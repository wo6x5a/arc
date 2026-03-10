import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

// PID 文件锁：防止多实例同时运行
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PID_FILE = resolve(__dirname, '../.arc.pid')

if (existsSync(PID_FILE)) {
  const oldPid = parseInt(readFileSync(PID_FILE, 'utf8').trim())
  if (oldPid && !isNaN(oldPid)) {
    try {
      process.kill(oldPid, 0) // 检查进程是否存在
      console.log(`[启动] 发现旧实例 PID=${oldPid}，正在停止...`)
      process.kill(oldPid, 'SIGTERM')
    } catch {
      // 进程已不存在，忽略
    }
  }
}

writeFileSync(PID_FILE, String(process.pid))
process.on('exit', () => { try { unlinkSync(PID_FILE) } catch {} })
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
  // 等待旧实例完全退出（PID 文件锁 kill 后的缓冲）
  await new Promise(r => setTimeout(r, 800))

  const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN
  const hasFeishu = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
  const hasDingtalk = !!(process.env.DINGTALK_APP_KEY && process.env.DINGTALK_APP_SECRET)

  if (!hasTelegram && !hasFeishu && !hasDingtalk) {
    console.error('错误：未配置任何 Bot，请在 .env 中设置 TELEGRAM_BOT_TOKEN、飞书或钉钉相关配置')
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
}

main()
