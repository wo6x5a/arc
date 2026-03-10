import { exec } from 'child_process'
import { promisify } from 'util'
import TelegramBot from 'node-telegram-bot-api'
import { HttpsProxyAgent } from 'https-proxy-agent'
import {
  sessionManager,
  currentWorkDir, setCurrentWorkDir,
  chatBackendMap, claudeSessionMap, pendingCustomDir,
  projects, defaultBackend, allowedUserIds,
} from './state.js'
import { getRunner, RUNNERS } from './runners/index.js'
import { takeScreenshot } from './screenshot-helper.js'
import { startTunnel, stopTunnel, getTunnelUrl } from './tunnel-helper.js'

const execAsync = promisify(exec)

const token = process.env.TELEGRAM_BOT_TOKEN
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy

// 鉴权中间件
function isAuthorized(userId) {
  if (allowedUserIds.length === 0 || allowedUserIds[0] === 0) return true
  return allowedUserIds.includes(userId)
}

// 发送长消息（自动分割超过 4096 字符的消息）
async function sendLongMessage(bot, chatId, text) {
  const MAX_LENGTH = 4096
  if (text.length <= MAX_LENGTH) {
    return bot.sendMessage(chatId, text)
  }
  const chunks = []
  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    chunks.push(text.slice(i, i + MAX_LENGTH))
  }
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk)
  }
}

// 获取当前 chat 使用的后端名称
function getBackendName(chatId) {
  return chatBackendMap.get(chatId) || defaultBackend
}

// 获取当前 chat 的 runner 实例（按需创建）
function getRunnerForChat(chatId) {
  return getRunner(getBackendName(chatId), currentWorkDir)
}

// 自动探测构建/测试命令
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

export function startTelegramBot() {
  if (!token) {
    console.error('错误：请在 .env 文件中设置 TELEGRAM_BOT_TOKEN')
    process.exit(1)
  }

  const botOptions = { polling: true }
  if (proxyUrl) {
    botOptions.request = { agent: new HttpsProxyAgent(proxyUrl) }
    console.log(`使用代理: ${proxyUrl}`)
  }
  const bot = new TelegramBot(token, botOptions)

  bot.on('polling_error', (err) => {
    console.error('[Telegram] 轮询错误（自动重试中）:', err.code || err.message)
  })

  // 处理 /start 命令
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) {
      return bot.sendMessage(chatId, '无权限访问。')
    }
    const backendName = getBackendName(chatId)
    const backendLabel = RUNNERS[backendName]?.label || backendName
    await bot.sendMessage(chatId,
      `ARC (AI Remote Coding) 已启动\n\n` +
      `当前 AI：${backendLabel}\n` +
      `工作目录：${currentWorkDir}\n\n` +
      `直接发送消息即可让 AI 执行任务。\n\n` +
      `命令：\n` +
      `/ai - 切换 AI 后端（Claude/Gemini/Qwen）\n` +
      `/projects - 切换工作项目\n` +
      `/cd <路径> - 切换到自定义工作目录\n` +
      `/clear - 清除对话历史，开始新对话\n` +
      `/stop - 中止当前任务\n` +
      `/status - 查看当前状态\n\n` +
      `验证命令：\n` +
      `/test [命令] - 运行测试/构建（自动探测或指定命令）\n` +
      `/screenshot [URL] - 截图网页发回 Telegram\n` +
      `/tunnel <端口> - 开启内网穿透，获取公网链接`
    )
  })

  // 处理 /help 命令
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    const backendName = getBackendName(chatId)
    const backendLabel = RUNNERS[backendName]?.label || backendName
    await bot.sendMessage(chatId,
      `命令列表：\n\n` +
      `AI 后端：\n` +
      `/ai - 切换 AI 后端，当前：${backendLabel}\n\n` +
      `基础命令：\n` +
      `/projects - 列出预设项目，点按钮切换工作目录\n` +
      `/cd <路径> - 切换到自定义工作目录\n` +
      `/clear - 清除对话历史，开始新对话\n` +
      `/stop - 中止当前任务并清空队列\n` +
      `/status - 查看当前状态（是否执行中、队列、是否有历史）\n\n` +
      `验证命令：\n` +
      `/test [命令] - 在工作目录运行测试/构建\n` +
      `  例: /test\n` +
      `  例: /test npm run build\n` +
      `/screenshot [URL] - 截图网页并发回图片\n` +
      `  例: /screenshot http://localhost:3000\n` +
      `/tunnel <端口> - 开启 ngrok 内网穿透\n` +
      `  例: /tunnel 3000\n` +
      `  关闭: /tunnel stop\n\n` +
      `当前工作目录: ${currentWorkDir}`
    )
  })

  // 处理 /stop 命令
  bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    if (sessionManager.isRunning(chatId) || sessionManager.pendingCount(chatId) > 0) {
      sessionManager.abortAll(chatId)
      await bot.sendMessage(chatId, '已中止当前任务并清空队列。')
    } else {
      await bot.sendMessage(chatId, '当前没有正在运行的任务。')
    }
  })

  // 处理 /clear 命令 - 清除多轮对话历史
  bot.onText(/\/clear/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    if (sessionManager.isRunning(chatId)) {
      return bot.sendMessage(chatId, '当前有任务正在执行，请等待完成或发送 /stop 中止后再清除。')
    }

    claudeSessionMap.delete(chatId)
    await bot.sendMessage(chatId, '对话历史已清除，下一条消息将开始全新对话。')
  })

  // 处理 /status 命令
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    const running = sessionManager.currentTask(chatId)
    const pending = sessionManager.pendingCount(chatId)
    const hasHistory = claudeSessionMap.has(chatId)
    const backendName = getBackendName(chatId)
    const backendLabel = RUNNERS[backendName]?.label || backendName

    if (running) {
      const queueInfo = pending > 0 ? `\n队列中还有 ${pending} 个任务待执行` : ''
      await bot.sendMessage(chatId, `当前状态：执行中\n任务：${running}${queueInfo}`)
    } else {
      await bot.sendMessage(chatId,
        `当前状态：空闲\n当前 AI：${backendLabel}\n工作目录：${currentWorkDir}\n对话历史：${hasHistory ? '有（发送 /clear 可清除）' : '无'}`
      )
    }
  })

  // 处理 /ai 命令 - 切换 AI 后端
  bot.onText(/\/ai/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    const currentBackend = getBackendName(chatId)
    const inline_keyboard = Object.entries(RUNNERS).map(([key, { label, emoji }]) => {
      const isCurrent = key === currentBackend
      return [{ text: isCurrent ? `✅ ${emoji} ${label}` : `${emoji} ${label}`, callback_data: `switch_ai_${key}` }]
    })

    await bot.sendMessage(chatId,
      `当前 AI 后端：${RUNNERS[currentBackend]?.label || currentBackend}\n\n请选择要切换的 AI：`,
      { reply_markup: { inline_keyboard } }
    )
  })

  // 处理 /projects 命令
  bot.onText(/\/projects/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    if (projects.length === 0) {
      return bot.sendMessage(chatId, '未配置预设项目列表。\n请在 .env 文件中配置 PROJECTS 变量。')
    }

    const inline_keyboard = projects.map((proj, index) => {
      const isCurrent = proj.path === currentWorkDir
      return [{ text: isCurrent ? `✅ ${proj.name}` : proj.name, callback_data: `switch_project_${index}` }]
    })
    inline_keyboard.push([{ text: '📁 自定义目录...', callback_data: 'switch_project_custom' }])

    await bot.sendMessage(chatId,
      `当前工作目录：${currentWorkDir}\n\n请选择要切换的项目：`,
      { reply_markup: { inline_keyboard } }
    )
  })

  // 处理 /cd 命令 - 切换到自定义工作目录
  bot.onText(/\/cd(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    const targetPath = match[1] ? match[1].trim() : null
    if (!targetPath) {
      return bot.sendMessage(chatId, `当前工作目录：${currentWorkDir}\n\n用法: /cd <路径>\n例: /cd /Users/me/myproject`)
    }

    try {
      const { stdout } = await execAsync(`cd '${targetPath.replace(/'/g, `'\\''`)}' && pwd`)
      const resolvedPath = stdout.trim()
      setCurrentWorkDir(resolvedPath)
      claudeSessionMap.delete(chatId)
      await bot.sendMessage(chatId, `✅ 已切换工作目录：${resolvedPath}\n对话历史已自动清除`)
    } catch {
      await bot.sendMessage(chatId, `❌ 路径无效或无权限访问：${targetPath}`)
    }
  })

  // 处理 /test 命令 - 在当前工作目录运行测试/构建/lint
  bot.onText(/\/test(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    const customCmd = match[1] ? match[1].trim() : null
    const cmd = customCmd || await autoDetectBuildCmd(currentWorkDir)

    if (!cmd) {
      return bot.sendMessage(chatId, '未检测到可用的构建/测试命令。\n用法: /test <命令>\n例: /test npm run build')
    }

    const statusMsg = await bot.sendMessage(chatId, `⏳ 执行：${cmd}`)
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: currentWorkDir,
        timeout: 120000,
        env: process.env
      })
      const output = (stdout + stderr).trim()
      const truncated = output.length > 3500 ? output.slice(-3500) + '\n...(已截断，显示末尾)' : output
      await bot.editMessageText(`✅ 执行完成：${cmd}\n\n${truncated || '(无输出)'}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      })
    } catch (err) {
      const output = ((err.stdout || '') + (err.stderr || '')).trim()
      const truncated = output.length > 3000 ? output.slice(-3000) + '\n...(已截断)' : output
      await bot.editMessageText(`❌ 执行失败：${cmd}\n\n${truncated || err.message}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      })
    }
  })

  // 处理 /screenshot 命令 - 截图网页发回 Telegram
  bot.onText(/\/screenshot(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    let url = match[1] ? match[1].trim() : null
    if (!url) {
      const tunnelUrl = getTunnelUrl()
      if (tunnelUrl) {
        url = tunnelUrl
      } else {
        return bot.sendMessage(chatId, '请提供 URL。\n用法: /screenshot <URL>\n例: /screenshot http://localhost:3000\n\n也可以先用 /tunnel 3000 开启公网通道，之后 /screenshot 无需参数。')
      }
    }

    const statusMsg = await bot.sendMessage(chatId, `⏳ 正在截图：${url}`)
    try {
      const imgBuf = await takeScreenshot(url, { timeout: 20000 })
      await bot.editMessageText(`📸 截图完成：${url}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      })
      await bot.sendPhoto(chatId, imgBuf, { caption: url })
    } catch (err) {
      await bot.editMessageText(`❌ 截图失败：${err.message}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      })
    }
  })

  // 处理 /tunnel 命令 - 开启/关闭 ngrok 内网穿透
  bot.onText(/\/tunnel(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) return

    const arg = match[1] ? match[1].trim() : null

    if (arg === 'stop' || arg === 'close') {
      await stopTunnel()
      return bot.sendMessage(chatId, '隧道已关闭。')
    }

    const port = parseInt(arg)
    if (!port || isNaN(port)) {
      const currentUrl = getTunnelUrl()
      if (currentUrl) {
        return bot.sendMessage(chatId, `当前隧道地址：${currentUrl}\n\n发送 /tunnel stop 可关闭。`)
      }
      return bot.sendMessage(chatId, '请提供端口号。\n用法: /tunnel <端口>\n例: /tunnel 3000\n\n关闭: /tunnel stop')
    }

    const statusMsg = await bot.sendMessage(chatId, `⏳ 正在开启端口 ${port} 的隧道...`)
    try {
      const publicUrl = await startTunnel(port)
      await bot.editMessageText(
        `✅ 隧道已开启\n\n公网地址：${publicUrl}\n本地端口：${port}\n\n关闭: /tunnel stop\n截图: /screenshot`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      )
    } catch (err) {
      await bot.editMessageText(`❌ 开启隧道失败：${err.message}\n\n如未配置 authtoken，请在 .env 中设置 NGROK_AUTHTOKEN`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      })
    }
  })

  // 处理内联按钮回调
  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id
    const userId = callbackQuery.from.id
    if (!isAuthorized(userId)) return

    const data = callbackQuery.data
    await bot.answerCallbackQuery(callbackQuery.id)

    // 切换 AI 后端
    if (data.startsWith('switch_ai_')) {
      const newBackend = data.replace('switch_ai_', '')
      if (!RUNNERS[newBackend]) return

      const oldBackend = getBackendName(chatId)
      if (newBackend === oldBackend) {
        return bot.sendMessage(chatId, `当前已经是 ${RUNNERS[newBackend].label}，无需切换。`)
      }

      chatBackendMap.set(chatId, newBackend)
      claudeSessionMap.delete(chatId)

      const { label, emoji } = RUNNERS[newBackend]
      const inline_keyboard = Object.entries(RUNNERS).map(([key, r]) => {
        const isCurrent = key === newBackend
        return [{ text: isCurrent ? `✅ ${r.emoji} ${r.label}` : `${r.emoji} ${r.label}`, callback_data: `switch_ai_${key}` }]
      })

      await bot.editMessageText(
        `✅ 已切换到 ${emoji} ${label}\n对话历史已自动清除`,
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          reply_markup: { inline_keyboard }
        }
      )
      return
    }

    if (data === 'switch_project_custom') {
      const promptMsg = await bot.sendMessage(chatId, '请输入要切换的目录路径：', {
        reply_markup: { force_reply: true, selective: true }
      })
      pendingCustomDir.set(chatId, promptMsg.message_id)
      return
    }

    if (data.startsWith('switch_project_')) {
      const index = parseInt(data.replace('switch_project_', ''))
      const project = projects[index]
      if (!project) return

      setCurrentWorkDir(project.path)
      claudeSessionMap.delete(chatId)

      const inline_keyboard = projects.map((proj, i) => {
        const isCurrent = i === index
        return [{ text: isCurrent ? `✅ ${proj.name}` : proj.name, callback_data: `switch_project_${i}` }]
      })

      await bot.editMessageText(
        `已切换到：${project.name}\n工作目录：${project.path}\n对话历史已自动清除`,
        {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          reply_markup: { inline_keyboard }
        }
      )
      return
    }
  })

  // 处理普通消息（执行任务）
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    if (!isAuthorized(userId)) {
      return bot.sendMessage(chatId, '无权限访问。')
    }

    const userMessage = msg.text || ''
    if (!userMessage.trim()) return

    // 处理「自定义目录」输入（优先，路径可能以 / 开头）
    if (pendingCustomDir.has(chatId)) {
      const isCommand = /^\/[^/\s]+$/.test(userMessage.trim())
      if (isCommand) {
        pendingCustomDir.delete(chatId)
      } else {
        pendingCustomDir.delete(chatId)
        const targetPath = userMessage.trim()
        try {
          const { stdout } = await execAsync(`cd '${targetPath.replace(/'/g, `'\\''`)}' && pwd`)
          const resolvedPath = stdout.trim()
          setCurrentWorkDir(resolvedPath)
          claudeSessionMap.delete(chatId)
          await bot.sendMessage(chatId, `✅ 已切换工作目录：${resolvedPath}\n对话历史已自动清除`)
        } catch {
          await bot.sendMessage(chatId, `❌ 路径无效或无权限访问：${targetPath}`)
        }
        return
      }
    }

    // 过滤 / 开头的命令消息
    if (msg.text && msg.text.startsWith('/')) return

    // 如果当前有任务在跑，提示加入队列
    const pendingBefore = sessionManager.pendingCount(chatId)
    const isRunning = sessionManager.isRunning(chatId)
    if (isRunning) {
      const position = pendingBefore + 1
      await bot.sendMessage(chatId, `已加入队列（排第 ${position} 位）：${userMessage.slice(0, 60)}`)
    }

    sessionManager.enqueue(chatId, userMessage, async (session) => {
      const runner = getRunnerForChat(chatId)
      const resumeSessionId = claudeSessionMap.get(chatId)
      const backendLabel = RUNNERS[getBackendName(chatId)]?.label || getBackendName(chatId)
      const statusMsg = await bot.sendMessage(chatId, `⏳ [${backendLabel}] 正在处理：${userMessage.slice(0, 100)}...`)

      let dots = 0
      const heartbeat = setInterval(async () => {
        dots = (dots + 1) % 4
        const dotStr = '.'.repeat(dots + 1)
        try {
          await bot.editMessageText(`⏳ [${backendLabel}] 正在处理：${userMessage.slice(0, 80)}${dotStr}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
          })
        } catch {}
      }, 8000)

      try {
        const newSessionId = await runner.run({
          prompt: userMessage,
          session,
          resumeSessionId,
          onOutput: async (text) => {
            try {
              await sendLongMessage(bot, chatId, text)
            } catch (err) {
              console.error('发送消息失败:', err.message)
            }
          },
          onToolUse: async (label) => {
            bot.sendMessage(chatId, `🔧 ${label}`).catch(() => {})
          },
        })

        if (newSessionId) {
          claudeSessionMap.set(chatId, newSessionId)
        }

        clearInterval(heartbeat)
        const remaining = sessionManager.pendingCount(chatId)
        const doneText = remaining > 0
          ? `✅ 任务完成（队列中还有 ${remaining} 个任务）`
          : '✅ 任务完成'
        await bot.editMessageText(doneText, {
          chat_id: chatId,
          message_id: statusMsg.message_id
        })
      } catch (err) {
        clearInterval(heartbeat)
        claudeSessionMap.delete(chatId)
        if (err.message === 'ABORTED') {
          await bot.editMessageText('⛔ 任务已中止', {
            chat_id: chatId,
            message_id: statusMsg.message_id
          })
        } else {
          console.error('执行错误:', err)
          await bot.editMessageText(`❌ 执行失败：${err.message}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
          })
        }
      }
    }).catch(() => {})
  })

  console.log(`[Telegram] Bot 启动成功`)
  console.log(`[Telegram] 默认 AI 后端: ${RUNNERS[defaultBackend]?.label || defaultBackend}`)
  console.log(`[Telegram] 工作目录: ${currentWorkDir}`)
  console.log(`[Telegram] 允许的用户 ID: ${allowedUserIds.join(', ') || '所有人'}`)
  console.log(`[Telegram] 预设项目数量: ${projects.length}`)
}
