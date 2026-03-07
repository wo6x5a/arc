import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SessionManager } from './session.js'
import { ClaudeRunner } from './claude-runner.js'

const token = process.env.TELEGRAM_BOT_TOKEN
const allowedUserIds = (process.env.ALLOWED_USER_IDS || '').split(',').map(id => parseInt(id.trim()))
const defaultWorkDir = process.env.WORK_DIR || process.cwd()
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy

// 解析预设项目列表
let projects = []
try {
  projects = JSON.parse(process.env.PROJECTS || '[]')
} catch {
  console.warn('警告：PROJECTS 环境变量格式错误，请检查 .env 文件中的 JSON 格式')
}

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
const sessionManager = new SessionManager()
const claudeRunner = new ClaudeRunner(defaultWorkDir)

// 每个 chatId 对应的 claude session_id，用于多轮对话 resume
const claudeSessionMap = new Map()

// 鉴权中间件
function isAuthorized(userId) {
  if (allowedUserIds.length === 0 || allowedUserIds[0] === 0) return true
  return allowedUserIds.includes(userId)
}

// 发送长消息（自动分割超过 4096 字符的消息）
async function sendLongMessage(chatId, text) {
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

// 处理 /start 命令
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  if (!isAuthorized(userId)) {
    return bot.sendMessage(chatId, '无权限访问。')
  }
  await bot.sendMessage(chatId,
    `Claude Code Bridge 已启动\n\n` +
    `工作目录: ${claudeRunner.workDir}\n\n` +
    `直接发送消息即可让 Claude Code 执行任务。\n\n` +
    `命令：\n` +
    `/projects - 切换工作项目\n` +
    `/clear - 清除对话历史，开始新对话\n` +
    `/stop - 中止当前任务\n` +
    `/status - 查看当前状态`
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

  if (running) {
    const queueInfo = pending > 0 ? `\n队列中还有 ${pending} 个任务待执行` : ''
    await bot.sendMessage(chatId, `当前状态：执行中\n任务：${running}${queueInfo}`)
  } else {
    await bot.sendMessage(chatId,
      `当前状态：空闲\n工作目录：${claudeRunner.workDir}\n对话历史：${hasHistory ? '有（发送 /clear 可清除）' : '无'}`
    )
  }
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
    const isCurrent = proj.path === claudeRunner.workDir
    return [{ text: isCurrent ? `✅ ${proj.name}` : proj.name, callback_data: `switch_project_${index}` }]
  })

  await bot.sendMessage(chatId,
    `当前工作目录：${claudeRunner.workDir}\n\n请选择要切换的项目：`,
    { reply_markup: { inline_keyboard } }
  )
})

// 处理内联按钮回调（项目切换）
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id
  const userId = callbackQuery.from.id
  if (!isAuthorized(userId)) return

  const data = callbackQuery.data
  await bot.answerCallbackQuery(callbackQuery.id)

  if (data.startsWith('switch_project_')) {
    const index = parseInt(data.replace('switch_project_', ''))
    const project = projects[index]
    if (!project) return

    claudeRunner.setWorkDir(project.path)
    // 切换项目时清除对话历史，避免上下文混乱
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
  }
})

// 处理普通消息（执行任务）
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return
  const chatId = msg.chat.id
  const userId = msg.from.id
  if (!isAuthorized(userId)) {
    return bot.sendMessage(chatId, '无权限访问。')
  }

  const userMessage = msg.text || ''
  if (!userMessage.trim()) return

  // 如果当前有任务在跑，提示加入队列
  const pendingBefore = sessionManager.pendingCount(chatId)
  const isRunning = sessionManager.isRunning(chatId)
  if (isRunning) {
    const position = pendingBefore + 1
    await bot.sendMessage(chatId, `已加入队列（排第 ${position} 位）：${userMessage.slice(0, 60)}`)
  }

  // 入队，等待轮到自己执行
  sessionManager.enqueue(chatId, userMessage, async (session) => {
    const resumeSessionId = claudeSessionMap.get(chatId)
    const statusMsg = await bot.sendMessage(chatId, `⏳ 正在处理：${userMessage.slice(0, 100)}...`)

    // 心跳
    let dots = 0
    let heartbeat = setInterval(async () => {
      dots = (dots + 1) % 4
      const dotStr = '.'.repeat(dots + 1)
      try {
        await bot.editMessageText(`⏳ 正在处理：${userMessage.slice(0, 80)}${dotStr}`, {
          chat_id: chatId,
          message_id: statusMsg.message_id
        })
      } catch {}
    }, 8000)

    try {
      const newClaudeSessionId = await claudeRunner.run({
        prompt: userMessage,
        session,
        resumeSessionId,
        onOutput: async (text) => {
          try {
            await sendLongMessage(chatId, text)
          } catch (err) {
            console.error('发送消息失败:', err.message)
          }
        },
        onProgress: (label) => {
          // 重置心跳（清除旧的，立即更新消息，再启一个新的）
          clearInterval(heartbeat)
          bot.editMessageText(`⏳ ${label}`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
          }).catch(() => {})
          dots = 0
          heartbeat = setInterval(async () => {
            dots = (dots + 1) % 4
            const dotStr = '.'.repeat(dots + 1)
            try {
              await bot.editMessageText(`⏳ ${label}${dotStr}`, {
                chat_id: chatId,
                message_id: statusMsg.message_id
              })
            } catch {}
          }, 8000)
        },
        onSummary: async ({ toolCalls, duration }) => {
          if (toolCalls.length === 0) return
          // 用 label 聚合，直接显示已格式化的中文标签
          const labelCounts = {}
          for (const { label } of toolCalls) {
            labelCounts[label] = (labelCounts[label] || 0) + 1
          }
          const lines = Object.entries(labelCounts).map(([label, n]) => n > 1 ? `  ${label} x${n}` : `  ${label}`)
          const summary = `执行摘要\n用时：${duration} 秒\n操作：\n${lines.join('\n')}`
          await bot.sendMessage(chatId, summary).catch(() => {})
        },
      })

      if (newClaudeSessionId) {
        claudeSessionMap.set(chatId, newClaudeSessionId)
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
  }).catch(() => {})  // enqueue 的 reject 已在内部处理，这里避免 unhandledRejection
})

console.log(`Claude Code Bridge 启动成功`)
console.log(`工作目录: ${claudeRunner.workDir}`)
console.log(`允许的用户 ID: ${allowedUserIds.join(', ') || '所有人'}`)
console.log(`预设项目数量: ${projects.length}`)
