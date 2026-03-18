import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { HttpsProxyAgent } from 'https-proxy-agent'
import QRCode from 'qrcode'
import {
  sessionManager,
  currentWorkDir, setCurrentWorkDir,
  chatBackendMap, claudeSessionMap,
  projects, defaultBackend,
} from './state.js'
import { getRunner, RUNNERS, getAvailableRunners } from './runners/index.js'
import { takeScreenshot } from './screenshot-helper.js'
import { startTunnel, stopTunnel, getTunnelUrl, detectProjectPort } from './tunnel-helper.js'

const execAsync = promisify(exec)

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const AUTH_DIR = resolve(__dirname, '../.whatsapp-auth')

const whatsappAllowedUserIds = (process.env.WHATSAPP_ALLOWED_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean)

// sock 实例（startWhatsappBot 调用后赋值）
let sock

// ─── 鉴权 ────────────────────────────────────────────────
function isAuthorized(jid) {
  if (whatsappAllowedUserIds.length === 0) return true
  // 去掉 @domain 和 :device 后缀（如 8613588818853:3@s.whatsapp.net → 8613588818853）
  const number = jid.replace(/@.+$/, '').replace(/:\d+$/, '')
  return whatsappAllowedUserIds.some(n => n.replace(/\D/g, '') === number.replace(/\D/g, ''))
}

// ─── 发送文本消息（超 4000 字自动分片）────────────────────
async function sendText(jid, text) {
  const MAX = 4000
  const chunks = []
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX))
  // @lid 是 Bot 自身的 linked device ID，回复需发到用户的真实手机号 JID（去掉 :device 后缀）
  const sendJid = jid.endsWith('@lid')
    ? sock.user.id.replace(/:\d+@/, '@')
    : jid
  console.log('[WhatsApp] sendText', jid, '→', sendJid, '长度:', text.length)
  for (const chunk of chunks) {
    try {
      await sock.sendMessage(sendJid, { text: chunk })
    } catch (err) {
      console.error('[WhatsApp] sendMessage 失败 jid:', sendJid, err.message)
    }
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
const pendingMenuMap = new Map()
const MENU_TIMEOUT_MS = 60_000

// ─── 文字菜单构建 ─────────────────────────────────────────
function buildAiMenuText(chatId) {
  const currentBackend = getBackendName(chatId)
  const currentLabel = RUNNERS[currentBackend]?.label || currentBackend
  const lines = getAvailableRunners().map(([key, { label, emoji }], i) => {
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
async function handleCommand(jid, text) {
  if (/^\/start$|^\/help$/.test(text)) {
    const backendLabel = RUNNERS[getBackendName(jid)]?.label || getBackendName(jid)
    await sendText(jid,
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
      await sendText(jid, '未配置任何 AI 后端。')
      return
    }
    pendingMenuMap.set(jid, { type: 'ai', timestamp: Date.now() })
    await sendText(jid, buildAiMenuText(jid))
    return
  }

  if (text === '/projects') {
    if (projects.length === 0) {
      await sendText(jid, '未配置预设项目列表。\n请在 .env 文件中配置 PROJECTS 变量。')
      return
    }
    pendingMenuMap.set(jid, { type: 'project', timestamp: Date.now() })
    await sendText(jid, buildProjectMenuText())
    return
  }

  const cdMatch = text.match(/^\/cd(?:\s+(.+))?$/)
  if (cdMatch) {
    const targetPath = cdMatch[1] ? cdMatch[1].trim() : null
    if (!targetPath) {
      await sendText(jid, `当前工作目录：${currentWorkDir}\n\n用法: /cd <路径>\n例: /cd /Users/me/myproject`)
      return
    }
    try {
      const { stdout } = await execAsync(`cd '${targetPath.replace(/'/g, `'\\''`)}' && pwd`)
      const resolvedPath = stdout.trim()
      setCurrentWorkDir(resolvedPath)
      claudeSessionMap.delete(jid)
      await sendText(jid, `✅ 已切换工作目录：${resolvedPath}\n对话历史已自动清除`)
    } catch {
      await sendText(jid, `❌ 路径无效或无权限访问：${targetPath}`)
    }
    return
  }

  if (text === '/clear') {
    if (sessionManager.isRunning(jid)) {
      await sendText(jid, '当前有任务正在执行，请等待完成或发送 /stop 中止后再清除。')
      return
    }
    claudeSessionMap.delete(jid)
    await sendText(jid, '对话历史已清除，下一条消息将开始全新对话。')
    return
  }

  if (text === '/stop') {
    if (sessionManager.isRunning(jid) || sessionManager.pendingCount(jid) > 0) {
      sessionManager.abortAll(jid)
      await sendText(jid, '已中止当前任务并清空队列。')
    } else {
      await sendText(jid, '当前没有正在运行的任务。')
    }
    return
  }

  if (text === '/status') {
    const running = sessionManager.currentTask(jid)
    const pending = sessionManager.pendingCount(jid)
    const hasHistory = claudeSessionMap.has(jid)
    const backendLabel = RUNNERS[getBackendName(jid)]?.label || getBackendName(jid)
    if (running) {
      const queueInfo = pending > 0 ? `\n队列中还有 ${pending} 个任务待执行` : ''
      await sendText(jid, `当前状态：执行中\n任务：${running}${queueInfo}`)
    } else {
      await sendText(jid, `当前状态：空闲\n当前 AI：${backendLabel}\n工作目录：${currentWorkDir}\n对话历史：${hasHistory ? '有（发 /clear 可清除）' : '无'}`)
    }
    return
  }

  const testMatch = text.match(/^\/test(?:\s+(.+))?$/)
  if (testMatch) {
    const customCmd = testMatch[1] ? testMatch[1].trim() : null
    const cmd = customCmd || await autoDetectBuildCmd(currentWorkDir)
    if (!cmd) {
      await sendText(jid, '未检测到可用的构建/测试命令。\n用法: /test <命令>\n例: /test npm run build')
      return
    }
    await sendText(jid, `⏳ 执行：${cmd}`)
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: currentWorkDir, timeout: 120000, env: process.env })
      const output = (stdout + stderr).trim()
      const truncated = output.length > 3500 ? output.slice(-3500) + '\n...(已截断，显示末尾)' : output
      await sendText(jid, `✅ 执行完成：${cmd}\n\n${truncated || '(无输出)'}`)
    } catch (err) {
      const output = ((err.stdout || '') + (err.stderr || '')).trim()
      const truncated = output.length > 3000 ? output.slice(-3000) + '\n...(已截断)' : output
      await sendText(jid, `❌ 执行失败：${cmd}\n\n${truncated || err.message}`)
    }
    return
  }

  const ssMatch = text.match(/^\/screenshot(?:\s+(.+))?$/)
  if (ssMatch) {
    let url = ssMatch[1] ? ssMatch[1].trim() : getTunnelUrl()
    if (!url) {
      await sendText(jid, '请提供 URL。\n用法: /screenshot <URL>\n例: /screenshot http://localhost:3000')
      return
    }
    await sendText(jid, `⏳ 正在截图：${url}`)
    try {
      const screenshotPath = await takeScreenshot(url, { timeout: 20000 })
      if (screenshotPath && existsSync(screenshotPath)) {
        const { readFileSync } = await import('fs')
        await sock.sendMessage(jid, {
          image: readFileSync(screenshotPath),
          caption: `截图：${url}`,
        })
      } else {
        await sendText(jid, `📸 截图完成：${url}`)
      }
    } catch (err) {
      await sendText(jid, `❌ 截图失败：${err.message}`)
    }
    return
  }

  const tunnelMatch = text.match(/^\/tunnel(?:\s+(.+))?$/)
  if (tunnelMatch) {
    const arg = tunnelMatch[1] ? tunnelMatch[1].trim() : null
    if (arg === 'stop' || arg === 'close') {
      await stopTunnel()
      await sendText(jid, '隧道已关闭。')
      return
    }
    let port = parseInt(arg)
    if (!port || isNaN(port)) {
      const currentUrl = getTunnelUrl()
      if (currentUrl) {
        await sendText(jid, `当前隧道地址：${currentUrl}\n\n发送 /tunnel stop 可关闭。`)
        return
      }
      port = detectProjectPort(currentWorkDir)
      if (!port) {
        await sendText(jid, '请提供端口号。\n用法: /tunnel <端口>\n例: /tunnel 3000\n\n关闭: /tunnel stop')
        return
      }
    }
    await sendText(jid, `⏳ 正在开启端口 ${port} 的隧道...`)
    try {
      const publicUrl = await startTunnel(port)
      await sendText(jid, `✅ 隧道已开启\n\n公网地址：${publicUrl}\n本地端口：${port}\n\n关闭: /tunnel stop`)
    } catch (err) {
      await sendText(jid, `❌ 开启隧道失败：${err.message}\n\n请在 .env 中设置 NGROK_AUTHTOKEN`)
    }
    return
  }
}

// ─── 菜单回复处理 ─────────────────────────────────────────
async function handleMenuReply(jid, num) {
  const pending = pendingMenuMap.get(jid)
  if (!pending) return false
  if (Date.now() - pending.timestamp > MENU_TIMEOUT_MS) {
    pendingMenuMap.delete(jid)
    return false
  }

  pendingMenuMap.delete(jid)

  if (pending.type === 'ai') {
    const entries = getAvailableRunners()
    const selected = entries[num - 1]
    if (!selected) {
      await sendText(jid, `序号无效，请回复 1~${entries.length} 之间的数字。`)
      return true
    }
    const [key, { label, emoji }] = selected
    const oldBackend = getBackendName(jid)
    if (key === oldBackend) {
      await sendText(jid, `当前已经是 ${emoji} ${label}，无需切换。`)
    } else {
      chatBackendMap.set(jid, key)
      claudeSessionMap.delete(jid)
      await sendText(jid, `✅ 已切换到 ${emoji} ${label}\n对话历史已自动清除`)
    }
    return true
  }

  if (pending.type === 'project') {
    const project = projects[num - 1]
    if (!project) {
      await sendText(jid, `序号无效，请回复 1~${projects.length} 之间的数字。`)
      return true
    }
    setCurrentWorkDir(project.path)
    claudeSessionMap.delete(jid)
    await sendText(jid, `✅ 已切换到：${project.name}\n工作目录：${project.path}\n对话历史已自动清除`)
    return true
  }

  return false
}

// ─── 任务执行 ─────────────────────────────────────────────
async function handleTask(jid, userMessage) {
  const isRunning = sessionManager.isRunning(jid)
  if (isRunning) {
    const position = sessionManager.pendingCount(jid) + 1
    await sendText(jid, `已加入队列（排第 ${position} 位）：${userMessage.slice(0, 60)}`)
  }

  sessionManager.enqueue(jid, userMessage, async (session) => {
    const runner = getRunner(getBackendName(jid), currentWorkDir)
    const resumeSessionId = claudeSessionMap.get(jid)
    const backendLabel = RUNNERS[getBackendName(jid)]?.label || getBackendName(jid)

    await sendText(jid, `⏳ [${backendLabel}] 正在处理：${userMessage.slice(0, 100)}...`)

    try {
      const newSessionId = await runner.run({
        prompt: userMessage,
        session,
        resumeSessionId,
        onOutput: async (text) => {
          try { await sendText(jid, text) } catch (err) { console.error('[WhatsApp] 发送消息失败:', err.message) }
        },
        onToolUse: async (label) => {
          sendText(jid, `🔧 ${label}`).catch(() => {})
        },
      })

      if (newSessionId) claudeSessionMap.set(jid, newSessionId)

      const remaining = sessionManager.pendingCount(jid)
      const doneText = remaining > 0 ? `✅ 任务完成（队列中还有 ${remaining} 个任务）` : '✅ 任务完成'
      await sendText(jid, doneText)
    } catch (err) {
      claudeSessionMap.delete(jid)
      if (err.message === 'ABORTED') {
        await sendText(jid, '⛔ 任务已中止')
      } else {
        console.error('[WhatsApp] 执行错误:', err)
        await sendText(jid, `❌ 执行失败：${err.message}`)
      }
    }
  }).catch(() => {})
}

// ─── Baileys 启动 ─────────────────────────────────────────
export async function startWhatsappBot() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
    await import('@whiskeysockets/baileys')

  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const logger = {
    level: 'warn',
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (...a) => console.log('[WhatsApp:warn]', ...a),
    error: (...a) => console.log('[WhatsApp:error]', ...a),
    fatal: (...a) => console.log('[WhatsApp:fatal]', ...a),
  }

  // 使用 HttpsProxyAgent，支持 HTTP CONNECT 隧道（WSS 兼容）
  const proxyUrl = process.env.WHATSAPP_SOCKS_PROXY || process.env.HTTPS_PROXY
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
  console.log('[WhatsApp] 代理配置:', proxyUrl || '无')

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    agent,
    syncFullHistory: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    console.log('[WhatsApp] connection.update:', { connection, qr: !!qr, code: lastDisconnect?.error?.output?.statusCode })
    if (qr) {
      console.log('[WhatsApp] 正在生成二维码...')
      const qrData = typeof qr === 'string' ? qr : qr.ref || JSON.stringify(qr)
      try {
        const qrImage = await QRCode.toString(qrData, { type: 'terminal', small: true })
        console.log('[WhatsApp] 请用手机扫描下方二维码完成登录：\n' + qrImage)
      } catch (err) {
        console.log('[WhatsApp] 请扫描二维码（原始字符串）：' + qrData.slice(0, 200))
      }
    }
    if (connection === 'open') {
      console.log('[WhatsApp] 已成功连接')
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log(`[WhatsApp] 连接断开（code=${code}），${shouldReconnect ? '5 秒后重连...' : '已登出，请删除 .whatsapp-auth 目录后重启'}`)
      if (shouldReconnect) {
        setTimeout(() => startWhatsappBot(), 5000)
      }
    }
  })

  // 监听其他事件用于调试
  sock.ev.on('presence.update', (pres) => {
    console.log('[WhatsApp] presence.update:', JSON.stringify(pres).slice(0, 200))
  })

  sock.ev.on('chat.upsert', (chats) => {
    console.log('[WhatsApp] chat.upsert:', chats.length)
  })

  sock.ev.on('contact.upsert', (contacts) => {
    console.log('[WhatsApp] contact.upsert:', contacts.length)
  })

  sock.ev.on('messages.update', (msgs) => {
    console.log('[WhatsApp] messages.update:', JSON.stringify(msgs).slice(0, 500))
    for (const m of msgs) {
      console.log('[WhatsApp] 消息更新:', JSON.stringify(m.key).slice(0, 100))
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('[WhatsApp] messages.upsert 事件触发, type:', type, '消息数:', messages?.length)
    if (type !== 'notify') return

    for (const msg of messages) {
      try {
        // 调试日志
        console.log('[WhatsApp] 收到消息:', JSON.stringify({
          fromMe: msg.key.fromMe,
          remoteJid: msg.key.remoteJid,
          hasMessage: !!msg.message,
          conversation: msg.message?.conversation,
          extendedText: msg.message?.extendedTextMessage?.text,
        }).slice(0, 300))

        if (!msg.message) continue

        const rawJid = msg.key.remoteJid
        if (!rawJid) continue
        // @lid 是 Bot 自身 linked device，统一用 sock.user.id（真实手机号 JID）作为 chatId
        // 同时去掉 :device 后缀（如 8613588818853:3@s.whatsapp.net → 8613588818853@s.whatsapp.net）
        const jid = rawJid.endsWith('@lid')
          ? sock.user.id.replace(/:\d+@/, '@')
          : rawJid

        // 允许自己给自己发消息（多设备登录场景）
        // 只要不是从其他设备发的消息就可以处理
        // if (msg.key.fromMe) continue

        if (!isAuthorized(jid)) {
          console.log('[WhatsApp] 未授权:', jid)
          continue
        }

        // 提取文本（支持普通文本和引用回复消息）
        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim()

        if (!text) continue

        // 去除群聊中 @ 机器人的前缀（如 @15551234567 ）
        const cleanText = text.replace(/^@\d+\s*/, '').trim()
        if (!cleanText) continue

        console.log('[WhatsApp] 处理消息:', cleanText.slice(0, 50))

        // 优先检查菜单等待状态
        const numMatch = cleanText.match(/^(\d+)$/)
        if (numMatch) {
          const num = parseInt(numMatch[1])
          const handled = await handleMenuReply(jid, num)
          if (handled) continue
        }

        if (cleanText.startsWith('/')) {
          handleCommand(jid, cleanText).catch(err => console.error('[WhatsApp] 命令处理出错:', err))
        } else {
          handleTask(jid, cleanText).catch(err => console.error('[WhatsApp] 任务处理出错:', err))
        }
      } catch (err) {
        console.error('[WhatsApp] 消息处理出错:', err)
      }
    }
  })
}
