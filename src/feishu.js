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

const execAsync = promisify(exec)

const FEISHU_APP_ID = process.env.FEISHU_APP_ID
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET
const feishuAllowedUserIds = (process.env.FEISHU_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

// SDK 客户端（startFeishuBot 调用后赋值）
let client

// ─── 鉴权 ────────────────────────────────────────────────
function isAuthorized(openId) {
  if (feishuAllowedUserIds.length === 0) return true
  return feishuAllowedUserIds.includes(openId)
}

// ─── 发送文本消息（超 8000 字自动分片）────────────────────
async function sendText(chatId, text) {
  const MAX = 8000
  const chunks = []
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX))
  for (const chunk of chunks) {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      },
    })
  }
}

// ─── 获取后端 ─────────────────────────────────────────────
function getBackendName(chatId) {
  return chatBackendMap.get(chatId) || defaultBackend
}

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

// ─── 菜单等待状态 ─────────────────────────────────────────
// Map<chatId, { type: 'ai'|'project', timestamp: number }>
const pendingMenuMap = new Map()
const MENU_TIMEOUT_MS = 60_000

// ─── 文字菜单构建 ─────────────────────────────────────────
function buildAiMenuText(chatId) {
  const currentBackend = getBackendName(chatId)
  const currentLabel = RUNNERS[currentBackend]?.label || currentBackend
  const lines = Object.entries(RUNNERS).map(([key, { label, emoji }], i) => {
    const isCurrent = key === currentBackend
    return `${i + 1}. ${isCurrent ? '✅ ' : ''}${emoji} ${label}`
  })
  return `请选择 AI 后端：\n\n${lines.join('\n')}\n\n回复序号即可切换（当前：${currentLabel}）`
}

function buildProjectMenuText() {
  const lines = projects.map((proj, i) => {
    const isCurrent = proj.path === currentWorkDir
    return `${i + 1}. ${isCurrent ? '✅ ' : ''}${proj.name}`
  })
  return `请选择工作项目：\n\n${lines.join('\n')}\n\n回复序号即可切换（当前：${currentWorkDir}）`
}

// ─── 命令处理 ─────────────────────────────────────────────
async function handleCommand(chatId, openId, text) {
  if (/^\/start$|^\/help$/.test(text)) {
    const backendLabel = RUNNERS[getBackendName(chatId)]?.label || getBackendName(chatId)
    await sendText(chatId,
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

  if (text === '/ai') {
    if (Object.keys(RUNNERS).length === 0) {
      await sendText(chatId, '未配置任何 AI 后端。')
      return
    }
    pendingMenuMap.set(chatId, { type: 'ai', timestamp: Date.now() })
    await sendText(chatId, buildAiMenuText(chatId))
    return
  }

  if (text === '/projects') {
    if (projects.length === 0) {
      await sendText(chatId, '未配置预设项目列表。\n请在 .env 文件中配置 PROJECTS 变量。')
      return
    }
    pendingMenuMap.set(chatId, { type: 'project', timestamp: Date.now() })
    await sendText(chatId, buildProjectMenuText())
    return
  }

  const cdMatch = text.match(/^\/cd(?:\s+(.+))?$/)
  if (cdMatch) {
    const targetPath = cdMatch[1] ? cdMatch[1].trim() : null
    if (!targetPath) {
      await sendText(chatId, `当前工作目录：${currentWorkDir}\n\n用法: /cd <路径>\n例: /cd /Users/me/myproject`)
      return
    }
    try {
      const { stdout } = await execAsync(`cd '${targetPath.replace(/'/g, `'\\''`)}' && pwd`)
      const resolvedPath = stdout.trim()
      setCurrentWorkDir(resolvedPath)
      claudeSessionMap.delete(chatId)
      await sendText(chatId, `✅ 已切换工作目录：${resolvedPath}\n对话历史已自动清除`)
    } catch {
      await sendText(chatId, `❌ 路径无效或无权限访问：${targetPath}`)
    }
    return
  }

  if (text === '/clear') {
    if (sessionManager.isRunning(chatId)) {
      await sendText(chatId, '当前有任务正在执行，请等待完成或发送 /stop 中止后再清除。')
      return
    }
    claudeSessionMap.delete(chatId)
    await sendText(chatId, '对话历史已清除，下一条消息将开始全新对话。')
    return
  }

  if (text === '/stop') {
    if (sessionManager.isRunning(chatId) || sessionManager.pendingCount(chatId) > 0) {
      sessionManager.abortAll(chatId)
      await sendText(chatId, '已中止当前任务并清空队列。')
    } else {
      await sendText(chatId, '当前没有正在运行的任务。')
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
      await sendText(chatId, `当前状态：执行中\n任务：${running}${queueInfo}`)
    } else {
      await sendText(chatId, `当前状态：空闲\n当前 AI：${backendLabel}\n工作目录：${currentWorkDir}\n对话历史：${hasHistory ? '有（发 /clear 可清除）' : '无'}`)
    }
    return
  }

  const testMatch = text.match(/^\/test(?:\s+(.+))?$/)
  if (testMatch) {
    const customCmd = testMatch[1] ? testMatch[1].trim() : null
    const cmd = customCmd || await autoDetectBuildCmd(currentWorkDir)
    if (!cmd) {
      await sendText(chatId, '未检测到可用的构建/测试命令。\n用法: /test <命令>\n例: /test npm run build')
      return
    }
    await sendText(chatId, `⏳ 执行：${cmd}`)
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: currentWorkDir, timeout: 120000, env: process.env })
      const output = (stdout + stderr).trim()
      const truncated = output.length > 3500 ? output.slice(-3500) + '\n...(已截断，显示末尾)' : output
      await sendText(chatId, `✅ 执行完成：${cmd}\n\n${truncated || '(无输出)'}`)
    } catch (err) {
      const output = ((err.stdout || '') + (err.stderr || '')).trim()
      const truncated = output.length > 3000 ? output.slice(-3000) + '\n...(已截断)' : output
      await sendText(chatId, `❌ 执行失败：${cmd}\n\n${truncated || err.message}`)
    }
    return
  }

  const ssMatch = text.match(/^\/screenshot(?:\s+(.+))?$/)
  if (ssMatch) {
    let url = ssMatch[1] ? ssMatch[1].trim() : getTunnelUrl()
    if (!url) {
      await sendText(chatId, '请提供 URL。\n用法: /screenshot <URL>\n例: /screenshot http://localhost:3000')
      return
    }
    await sendText(chatId, `⏳ 正在截图：${url}`)
    try {
      await takeScreenshot(url, { timeout: 20000 })
      await sendText(chatId, `📸 截图完成：${url}\n（飞书暂不支持直接发送图片，请查看本地文件）`)
    } catch (err) {
      await sendText(chatId, `❌ 截图失败：${err.message}`)
    }
    return
  }

  const tunnelMatch = text.match(/^\/tunnel(?:\s+(.+))?$/)
  if (tunnelMatch) {
    const arg = tunnelMatch[1] ? tunnelMatch[1].trim() : null
    if (arg === 'stop' || arg === 'close') {
      await stopTunnel()
      await sendText(chatId, '隧道已关闭。')
      return
    }
    const port = parseInt(arg)
    if (!port || isNaN(port)) {
      const currentUrl = getTunnelUrl()
      if (currentUrl) {
        await sendText(chatId, `当前隧道地址：${currentUrl}\n\n发送 /tunnel stop 可关闭。`)
      } else {
        await sendText(chatId, '请提供端口号。\n用法: /tunnel <端口>\n例: /tunnel 3000\n\n关闭: /tunnel stop')
      }
      return
    }
    await sendText(chatId, `⏳ 正在开启端口 ${port} 的隧道...`)
    try {
      const publicUrl = await startTunnel(port)
      await sendText(chatId, `✅ 隧道已开启\n\n公网地址：${publicUrl}\n本地端口：${port}\n\n关闭: /tunnel stop`)
    } catch (err) {
      await sendText(chatId, `❌ 开启隧道失败：${err.message}\n\n请在 .env 中设置 NGROK_AUTHTOKEN`)
    }
    return
  }
}

// ─── 菜单回复处理 ─────────────────────────────────────────
async function handleMenuReply(chatId, num) {
  const pending = pendingMenuMap.get(chatId)
  if (!pending) return false
  if (Date.now() - pending.timestamp > MENU_TIMEOUT_MS) {
    pendingMenuMap.delete(chatId)
    return false
  }

  pendingMenuMap.delete(chatId)

  if (pending.type === 'ai') {
    const entries = Object.entries(RUNNERS)
    const selected = entries[num - 1]
    if (!selected) {
      await sendText(chatId, `序号无效，请回复 1~${entries.length} 之间的数字。`)
      return true
    }
    const [key, { label, emoji }] = selected
    const oldBackend = getBackendName(chatId)
    if (key === oldBackend) {
      await sendText(chatId, `当前已经是 ${emoji} ${label}，无需切换。`)
    } else {
      chatBackendMap.set(chatId, key)
      claudeSessionMap.delete(chatId)
      await sendText(chatId, `✅ 已切换到 ${emoji} ${label}\n对话历史已自动清除`)
    }
    return true
  }

  if (pending.type === 'project') {
    const project = projects[num - 1]
    if (!project) {
      await sendText(chatId, `序号无效，请回复 1~${projects.length} 之间的数字。`)
      return true
    }
    setCurrentWorkDir(project.path)
    claudeSessionMap.delete(chatId)
    await sendText(chatId, `✅ 已切换到：${project.name}\n工作目录：${project.path}\n对话历史已自动清除`)
    return true
  }

  return false
}

// ─── 任务执行 ─────────────────────────────────────────────
async function handleTask(chatId, userMessage) {
  const isRunning = sessionManager.isRunning(chatId)
  if (isRunning) {
    const position = sessionManager.pendingCount(chatId) + 1
    await sendText(chatId, `已加入队列（排第 ${position} 位）：${userMessage.slice(0, 60)}`)
  }

  sessionManager.enqueue(chatId, userMessage, async (session) => {
    const runner = getRunner(getBackendName(chatId), currentWorkDir)
    const resumeSessionId = claudeSessionMap.get(chatId)
    const backendLabel = RUNNERS[getBackendName(chatId)]?.label || getBackendName(chatId)

    await sendText(chatId, `⏳ [${backendLabel}] 正在处理：${userMessage.slice(0, 100)}...`)

    try {
      const newSessionId = await runner.run({
        prompt: userMessage,
        session,
        resumeSessionId,
        onOutput: async (text) => {
          try { await sendText(chatId, text) } catch (err) { console.error('[飞书] 发送消息失败:', err.message) }
        },
        onToolUse: async (label) => {
          sendText(chatId, `🔧 ${label}`).catch(() => {})
        },
      })

      if (newSessionId) claudeSessionMap.set(chatId, newSessionId)

      const remaining = sessionManager.pendingCount(chatId)
      const doneText = remaining > 0 ? `✅ 任务完成（队列中还有 ${remaining} 个任务）` : '✅ 任务完成'
      await sendText(chatId, doneText)
    } catch (err) {
      claudeSessionMap.delete(chatId)
      if (err.message === 'ABORTED') {
        await sendText(chatId, '⛔ 任务已中止')
      } else {
        console.error('[飞书] 执行错误:', err)
        await sendText(chatId, `❌ 执行失败：${err.message}`)
      }
    }
  }).catch(() => {})
}

// ─── WSClient 启动 ────────────────────────────────────────
export async function startFeishuBot() {
  const Lark = await import('@larksuiteoapi/node-sdk')

  // SDK 客户端（用于发送消息）
  client = new Lark.Client({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    domain: Lark.Domain.Feishu,
  })

  const wsClient = new Lark.WSClient({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  })

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const { message, sender } = data
          const openId = sender?.sender_id?.open_id
          const chatId = message?.chat_id
          const msgType = message?.message_type

          if (!openId || !chatId || msgType !== 'text') return
          if (!isAuthorized(openId)) return

          let text = ''
          try {
            text = JSON.parse(message.content).text?.trim() || ''
          } catch { return }
          if (!text) return

          // 优先检查菜单等待状态
          const numMatch = text.match(/^(\d+)$/)
          if (numMatch) {
            const num = parseInt(numMatch[1])
            const handled = await handleMenuReply(chatId, num)
            if (handled) return
          }

          if (text.startsWith('/')) {
            handleCommand(chatId, openId, text).catch(err => console.error('[飞书] 命令处理出错:', err))
          } else {
            handleTask(chatId, text).catch(err => console.error('[飞书] 任务处理出错:', err))
          }
        } catch (err) {
          console.error('[飞书] 消息处理出错:', err)
        }
      },
    }),
  })

  console.log('[飞书] WSClient 长连接已启动（无需公网 IP）')
}
