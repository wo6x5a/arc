import dotenv from 'dotenv'
import { homedir } from 'os'
import path from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { fileURLToPath } from 'url'

// Priority: ~/.arc-bot/.env (global config) > ./.env (dev fallback)
dotenv.config({ path: path.join(homedir(), '.arc-bot', '.env') })
dotenv.config() // second call: existing keys are NOT overwritten (dotenv default)

// PID 文件锁：防止多实例同时运行
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PID_FILE = path.join(homedir(), '.arc-bot', '.arc.pid')

const SKIP_PID_LOCK = process.env.ARC_SKIP_PID_LOCK === '1'

if (!SKIP_PID_LOCK && existsSync(PID_FILE)) {
  const oldPid = parseInt(readFileSync(PID_FILE, 'utf8').trim())
  if (oldPid && !isNaN(oldPid)) {
    try {
      process.kill(oldPid, 0) // 检查进程是否存在
      console.log(`[启动] 发现旧实例 PID=${oldPid}，正在停止...`)
      process.kill(oldPid, 'SIGTERM')
      // 等待旧进程退出，最多 3 秒，超时则强制 SIGKILL
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100))
        try { process.kill(oldPid, 0) } catch { break } // 进程已退出
      }
      try {
        process.kill(oldPid, 0)
        console.log(`[启动] 旧实例未响应 SIGTERM，强制 SIGKILL PID=${oldPid}`)
        process.kill(oldPid, 'SIGKILL')
        await new Promise(r => setTimeout(r, 200))
      } catch { /* 已退出 */ }
    } catch {
      // 进程已不存在，忽略
    }
  }
}

if (!SKIP_PID_LOCK) {
  writeFileSync(PID_FILE, String(process.pid))
  process.on('exit', () => { try { unlinkSync(PID_FILE) } catch {} })
}
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// 拦截所有未捕获的 Promise rejection，防止 TLS/网络抖动导致进程崩溃
process.on('unhandledRejection', (reason) => {
  const code = reason?.code || reason?.cause?.code
  const msg = reason?.message || String(reason)
  if (code === 'EFATAL' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    console.error('[网络抖动] 忽略并继续（自动重试中）:', code, msg.slice(0, 100))
    return
  }
  console.error('[未处理的 Promise rejection]', reason)
})

async function main() {
  const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN
  const hasFeishu = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
  const hasDingtalk = !!(process.env.DINGTALK_APP_KEY && process.env.DINGTALK_APP_SECRET)
  const hasWhatsapp = !!process.env.WHATSAPP_ENABLED

  if (!hasTelegram && !hasFeishu && !hasDingtalk && !hasWhatsapp) {
    console.error('错误：未配置任何 Bot，请在 .env 中设置 TELEGRAM_BOT_TOKEN、飞书、钉钉或 WHATSAPP_ENABLED 相关配置')
    process.exit(1)
  }

  if (hasTelegram) {
    const { startTelegramBot } = await import('./index.js')
    startTelegramBot()
  }

  if (hasFeishu) {
    const { startFeishuBot } = await import('./feishu.js')
    startFeishuBot()
  }

  // 钉钉使用 Stream 模式（WebSocket，无需公网 URL）
  if (hasDingtalk) {
    const { startDingtalkBot } = await import('./dingtalk.js')
    startDingtalkBot()
  }

  // WhatsApp 使用 Baileys（无需公网 IP，首次启动扫码登录）
  if (hasWhatsapp) {
    const { startWhatsappBot } = await import('./whatsapp.js')
    startWhatsappBot()
  }
}

main()
