import { createRequire } from 'module'
import { exec } from 'child_process'
import { promisify } from 'util'
import {
  sessionManager,
  currentWorkDir, setCurrentWorkDir,
  chatBackendMap, claudeSessionMap,
  projects, defaultBackend,
} from './state.js'
import { getRunner, RUNNERS } from './runners/index.js'
import { takeScreenshot } from './screenshot-helper.js'
import { startTunnel, stopTunnel, getTunnelUrl } from './tunnel-helper.js'

// dingtalk-stream-sdk-nodejs 是 CJS 包，用 createRequire 兼容 ESM
const require = createRequire(import.meta.url)
const { DWClient, TOPIC_ROBOT } = require('dingtalk-stream-sdk-nodejs')

const execAsync = promisify(exec)

const DINGTALK_APP_KEY = process.env.DINGTALK_APP_KEY
const DINGTALK_APP_SECRET = process.env.DINGTALK_APP_SECRET
const dingtalkAllowedUserIds = (process.env.DINGTALK_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

// ─── 鉴权 ────────────────────────────────────────────────
function isAuthorized(openId) {
  if (dingtalkAllowedUserIds.length === 0) return true
  return dingtalkAllowedUserIds.includes(openId)
}

// ─── 发送文本消息（通过 sessionWebhook）────────────────────
async function sendText(sessionWebhook, text) {
  const MAX = 5000
  const chunks = []
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX))
  for (const chunk of chunks) {
    await fetch(sessionWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: chunk },
      }),
    }).catch(err => console.error('[钉钉] 发送消息失败:', err.message))
  }
}


// ─── 获取后端 ─────────────────────────────────────────────
function getBackendName(chatId) {
  return chatBackendMap.get(chatId) || defaultBackend
}

// ─── 菜单等待状态 ─────────────────────────────────────────
const pendingMenu = new Map() // chatId → { options: [{title, cmd}] }

// ─── 自动探测构建命令 ──────────────────────────────────────
async function autoDetectBuildCmd(cwd) {
  try {
    const { stdout } = await execAsync('cat package.json', { cwd })
    const pkg = JSON.parse(stdout)
    const scripts = pkg.scripts || {}
    for (const name of ['test', 'build', 'lint', 'check', 'typecheck']) {
      if (scripts[name]) return `npm run ${name}`
    }
  } catch {}
  return null
}

// ─── 发送文本菜单 ─────────────────────────────────────────
async function sendTextMenu(sessionWebhook, chatId, title, btns) {
  pendingMenu.set(chatId, { options: btns })
  const btnLines = btns.map((b, i) => `${i + 1}. ${b.title}`).join('\n')
  await fetch(sessionWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: `${title}\n\n${btnLines}\n\n回复序号即可选择，或直接发送命令` },
    }),
  }).catch(err => console.error('[钉钉] 发送文本菜单失败:', err.message))
}

// ─── 数字选择处理 ─────────────────────────────────────────
async function handleMenuSelection(chatId, sessionWebhook, num) {
  const menu = pendingMenu.get(chatId)
  if (!menu) return false
  const index = num - 1
  if (index < 0 || index >= menu.options.length) {
    await sendText(sessionWebhook, `请输入 1 到 ${menu.options.length} 之间的数字。`)
    return true
  }
  pendingMenu.delete(chatId)
  const cmd = menu.options[index].cmd
  await handleCommand(chatId, null, sessionWebhook, cmd)
  return true
}

// ─── AI 切换菜单 ──────────────────────────────────────────
async function sendAiMenu(chatId, sessionWebhook) {
  const currentBackend = getBackendName(chatId)
  const currentLabel = RUNNERS[currentBackend]?.label || currentBackend
  const btns = Object.entries(RUNNERS).map(([key, { label, emoji }]) => ({
    title: key === currentBackend ? `✅ ${emoji} ${label}（当前）` : `${emoji} ${label}`,
    cmd: `/ai ${key}`,
  }))
  await sendTextMenu(sessionWebhook, chatId, `切换 AI 后端（当前：${currentLabel}）`, btns)
}

// ─── 项目切换菜单 ─────────────────────────────────────────
async function sendProjectMenu(chatId, sessionWebhook) {
  const btns = projects.map((proj, index) => ({
    title: proj.path === currentWorkDir ? `✅ ${proj.name}（当前）` : proj.name,
    cmd: `/projects ${index}`,
  }))
  await sendTextMenu(sessionWebhook, chatId, `切换工作项目（当前：${currentWorkDir}）`, btns)
}

// ─── 命令处理 ─────────────────────────────────────────────
async function handleCommand(chatId, _senderId, sessionWebhook, text) {
  if (/^\/start$|^\/help$/.test(text)) {
    const backendLabel = RUNNERS[getBackendName(chatId)]?.label || getBackendName(chatId)
    await sendText(sessionWebhook,
      `ARC (AI Remote Coding) 已启动\n\n` +
      `当前 AI：${backendLabel}\n` +
      `工作目录：${currentWorkDir}\n\n` +
      `直接发消息即可让 AI 执行任务。\n\n` +
      `命令：\n` +
      `/ai - 切换 AI 后端\n` +
      `/projects - 切换工作项目\n` +
      `/cd <路径> - 切换到自定义工作目录\n` +
      `/clear - 清除对话历史\n` +
      `/stop - 中止当前任务\n` +
      `/status - 查看当前状态\n` +
      `/test [命令] - 运行测试/构建\n` +
      `/screenshot [URL] - 截图网页\n` +
      `/tunnel <端口> - 开启内网穿透`
    )
    return
  }

  if (text === '/ai' || text.startsWith('/ai ')) {
    if (Object.keys(RUNNERS).length === 0) {
      await sendText(sessionWebhook, '未配置任何 AI 后端。')
      return
    }
    const arg = text.slice(3).trim()
    if (arg && RUNNERS[arg]) {
      // 直接切换（来自卡片按钮点击）
      const oldBackend = getBackendName(chatId)
      if (arg === oldBackend) {
        await sendText(sessionWebhook, `当前已经是 ${RUNNERS[arg].label}，无需切换。`)
      } else {
        chatBackendMap.set(chatId, arg)
        claudeSessionMap.delete(chatId)
        const { label, emoji } = RUNNERS[arg]
        await sendText(sessionWebhook, `✅ 已切换到 ${emoji} ${label}\n对话历史已自动清除`)
      }
    } else {
      await sendAiMenu(chatId, sessionWebhook)
    }
    return
  }

  if (text === '/projects' || text.startsWith('/projects ')) {
    if (projects.length === 0) {
      await sendText(sessionWebhook, '未配置预设项目列表。\n请在 .env 文件中配置 PROJECTS 变量。')
      return
    }
    const arg = text.slice(9).trim()
    const projIndex = parseInt(arg)
    if (!isNaN(projIndex) && projects[projIndex]) {
      // 直接切换（来自卡片按钮点击）
      const project = projects[projIndex]
      setCurrentWorkDir(project.path)
      claudeSessionMap.delete(chatId)
      await sendText(sessionWebhook, `✅ 已切换到：${project.name}\n工作目录：${project.path}\n对话历史已自动清除`)
    } else {
      await sendProjectMenu(chatId, sessionWebhook)
    }
    return
  }

  const cdMatch = text.match(/^\/cd(?:\s+(.+))?$/)
  if (cdMatch) {
    const targetPath = cdMatch[1] ? cdMatch[1].trim() : null
    if (!targetPath) {
      await sendText(sessionWebhook, `当前工作目录：${currentWorkDir}\n\n用法: /cd <路径>\n例: /cd /Users/me/myproject`)
      return
    }
    try {
      const { stdout } = await execAsync(`cd '${targetPath.replace(/'/g, `'\\''`)}' && pwd`)
      const resolvedPath = stdout.trim()
      setCurrentWorkDir(resolvedPath)
      claudeSessionMap.delete(chatId)
      await sendText(sessionWebhook, `✅ 已切换工作目录：${resolvedPath}\n对话历史已自动清除`)
    } catch {
      await sendText(sessionWebhook, `❌ 路径无效或无权限访问：${targetPath}`)
    }
    return
  }

  if (text === '/clear') {
    if (sessionManager.isRunning(chatId)) {
      await sendText(sessionWebhook, '当前有任务正在执行，请等待完成或发送 /stop 中止后再清除。')
      return
    }
    claudeSessionMap.delete(chatId)
    await sendText(sessionWebhook, '对话历史已清除，下一条消息将开始全新对话。')
    return
  }

  if (text === '/stop') {
    if (sessionManager.isRunning(chatId) || sessionManager.pendingCount(chatId) > 0) {
      sessionManager.abortAll(chatId)
      await sendText(sessionWebhook, '已中止当前任务并清空队列。')
    } else {
      await sendText(sessionWebhook, '当前没有正在运行的任务。')
    }
    return
  }

  if (text === '/status') {
    const running = sessionManager.currentTask(chatId)
    const pending = sessionManager.pendingCount(chatId)
    const hasHistory = claudeSessionMap.has(chatId)
    const backendLabel = RUNNERS[getBackendName(chatId)]?.label || getBackendName(chatId)
    if (running) {
      const queueInfo = pending > 0 ? `\n队列中还有 ${pending} 个任务待执行` : ''
      await sendText(sessionWebhook, `当前状态：执行中\n任务：${running}${queueInfo}`)
    } else {
      await sendText(sessionWebhook, `当前状态：空闲\n当前 AI：${backendLabel}\n工作目录：${currentWorkDir}\n对话历史：${hasHistory ? '有（发 /clear 可清除）' : '无'}`)
    }
    return
  }

  const testMatch = text.match(/^\/test(?:\s+(.+))?$/)
  if (testMatch) {
    const customCmd = testMatch[1] ? testMatch[1].trim() : null
    const cmd = customCmd || await autoDetectBuildCmd(currentWorkDir)
    if (!cmd) {
      await sendText(sessionWebhook, '未检测到可用的构建/测试命令。\n用法: /test <命令>\n例: /test npm run build')
      return
    }
    await sendText(sessionWebhook, `⏳ 执行：${cmd}`)
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: currentWorkDir, timeout: 120000, env: process.env })
      const output = (stdout + stderr).trim()
      const truncated = output.length > 3500 ? output.slice(-3500) + '\n...(已截断，显示末尾)' : output
      await sendText(sessionWebhook, `✅ 执行完成：${cmd}\n\n${truncated || '(无输出)'}`)
    } catch (err) {
      const output = ((err.stdout || '') + (err.stderr || '')).trim()
      const truncated = output.length > 3000 ? output.slice(-3000) + '\n...(已截断)' : output
      await sendText(sessionWebhook, `❌ 执行失败：${cmd}\n\n${truncated || err.message}`)
    }
    return
  }

  const ssMatch = text.match(/^\/screenshot(?:\s+(.+))?$/)
  if (ssMatch) {
    let url = ssMatch[1] ? ssMatch[1].trim() : getTunnelUrl()
    if (!url) {
      await sendText(sessionWebhook, '请提供 URL。\n用法: /screenshot <URL>\n例: /screenshot http://localhost:3000')
      return
    }
    await sendText(sessionWebhook, `⏳ 正在截图：${url}`)
    try {
      await takeScreenshot(url, { timeout: 20000 })
      await sendText(sessionWebhook, `📸 截图完成：${url}\n（钉钉暂不支持直接发送图片，请查看本地文件）`)
    } catch (err) {
      await sendText(sessionWebhook, `❌ 截图失败：${err.message}`)
    }
    return
  }

  const tunnelMatch = text.match(/^\/tunnel(?:\s+(.+))?$/)
  if (tunnelMatch) {
    const arg = tunnelMatch[1] ? tunnelMatch[1].trim() : null
    if (arg === 'stop' || arg === 'close') {
      await stopTunnel()
      await sendText(sessionWebhook, '隧道已关闭。')
      return
    }
    const port = parseInt(arg)
    if (!port || isNaN(port)) {
      const currentUrl = getTunnelUrl()
      if (currentUrl) {
        await sendText(sessionWebhook, `当前隧道地址：${currentUrl}\n\n发送 /tunnel stop 可关闭。`)
      } else {
        await sendText(sessionWebhook, '请提供端口号。\n用法: /tunnel <端口>\n例: /tunnel 3000\n\n关闭: /tunnel stop')
      }
      return
    }
    await sendText(sessionWebhook, `⏳ 正在开启端口 ${port} 的隧道...`)
    try {
      const publicUrl = await startTunnel(port)
      await sendText(sessionWebhook, `✅ 隧道已开启\n\n公网地址：${publicUrl}\n本地端口：${port}\n\n关闭: /tunnel stop`)
    } catch (err) {
      await sendText(sessionWebhook, `❌ 开启隧道失败：${err.message}\n\n请在 .env 中设置 NGROK_AUTHTOKEN`)
    }
    return
  }
}

// ─── 任务执行 ─────────────────────────────────────────────
async function handleTask(chatId, sessionWebhook, userMessage) {
  const isRunning = sessionManager.isRunning(chatId)
  if (isRunning) {
    const position = sessionManager.pendingCount(chatId) + 1
    await sendText(sessionWebhook, `已加入队列（排第 ${position} 位）：${userMessage.slice(0, 60)}`)
  }

  sessionManager.enqueue(chatId, userMessage, async (session) => {
    const runner = getRunner(getBackendName(chatId), currentWorkDir)
    const resumeSessionId = claudeSessionMap.get(chatId)
    const backendLabel = RUNNERS[getBackendName(chatId)]?.label || getBackendName(chatId)

    await sendText(sessionWebhook, `⏳ [${backendLabel}] 正在处理：${userMessage.slice(0, 100)}...`)

    try {
      const newSessionId = await runner.run({
        prompt: userMessage,
        session,
        resumeSessionId,
        onOutput: async (text) => {
          try { await sendText(sessionWebhook, text) } catch (err) { console.error('[钉钉] 发送消息失败:', err.message) }
        },
        onToolUse: async (label) => {
          sendText(sessionWebhook, `🔧 ${label}`).catch(() => {})
        },
      })

      if (newSessionId) claudeSessionMap.set(chatId, newSessionId)

      const remaining = sessionManager.pendingCount(chatId)
      const doneText = remaining > 0 ? `✅ 任务完成（队列中还有 ${remaining} 个任务）` : '✅ 任务完成'
      await sendText(sessionWebhook, doneText)
    } catch (err) {
      claudeSessionMap.delete(chatId)
      if (err.message === 'ABORTED') {
        await sendText(sessionWebhook, '⛔ 任务已中止')
      } else {
        console.error('[钉钉] 执行错误:', err)
        await sendText(sessionWebhook, `❌ 执行失败：${err.message}`)
      }
    }
  }).catch(() => {})
}

// ─── 启动 Stream 模式 ─────────────────────────────────────
export function startDingtalkBot() {
  const client = new DWClient({
    clientId: DINGTALK_APP_KEY,
    clientSecret: DINGTALK_APP_SECRET,
  })

  const startTime = Date.now()

  client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    // 立即 ACK，防止钉钉超时后重复推送
    client.send(res.headers.messageId, { success: true })

    let payload
    try {
      payload = JSON.parse(res.data)
    } catch {
      console.error('[钉钉] 解析消息失败:', res.data)
      return
    }

    const { text, senderStaffId, conversationId, sessionWebhook } = payload

    // 忽略服务启动前积压的旧消息，并提示用户
    const msgTime = payload.createAt || payload.sendTime || 0
    if (msgTime && msgTime < startTime) {
      console.log(`[钉钉] 忽略旧消息（积压）: ${new Date(msgTime).toLocaleTimeString()}`)
      if (sessionWebhook) {
        await sendText(sessionWebhook, '⏳ Bot 刚刚启动，刚才的消息未处理，请重新发送。')
      }
      return
    }

    if (!senderStaffId || !conversationId || !sessionWebhook) return
    if (!isAuthorized(senderStaffId)) {
      console.log(`[钉钉] 未授权用户: ${senderStaffId}`)
      return
    }

    // 去除群聊中的 @ 前缀
    let content = (text?.content || '').replace(/@\S+/g, '').trim()
    if (!content) return

    const chatId = conversationId
    console.log(`[钉钉] 收到消息 from ${senderStaffId}: ${content.slice(0, 80)}`)

    if (content.startsWith('/')) {
      handleCommand(chatId, senderStaffId, sessionWebhook, content)
        .catch(err => console.error('[钉钉] 命令处理出错:', err))
    } else if (/^\d+$/.test(content)) {
      const num = parseInt(content)
      handleMenuSelection(chatId, sessionWebhook, num).then(handled => {
        if (!handled) {
          handleTask(chatId, sessionWebhook, content)
            .catch(err => console.error('[钉钉] 任务处理出错:', err))
        }
      }).catch(err => console.error('[钉钉] 菜单选择出错:', err))
    } else {
      handleTask(chatId, sessionWebhook, content)
        .catch(err => console.error('[钉钉] 任务处理出错:', err))
    }
  })

  client.connect()
  console.log('[钉钉] Stream 模式已启动，等待消息...')
}
