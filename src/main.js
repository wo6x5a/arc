import 'dotenv/config'

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
