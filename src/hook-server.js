import http from 'http'

const PORT = parseInt(process.env.HOOK_SERVER_PORT || '7701')

function formatToolLabel(toolName, input) {
  const map = {
    Write:     () => `写入文件: ${input?.file_path || ''}`,
    Edit:      () => `编辑文件: ${input?.file_path || ''}`,
    MultiEdit: () => `编辑文件: ${input?.file_path || ''}`,
    Bash:      () => `执行命令: ${String(input?.command || '').slice(0, 100)}`,
    TodoWrite: () => `更新任务列表`,
  }
  return (map[toolName] ?? (() => `调用工具: ${toolName}`))(input)
}

/**
 * 内嵌 HTTP 服务器，接收 Claude PreToolUse hook 请求
 * 调用 onPermission 回调发 Telegram 确认，等待用户决定后返回结果
 */
export function createHookServer(onPermission) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/permission') {
      res.writeHead(404)
      res.end()
      return
    }

    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let data
      try {
        data = JSON.parse(body)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ allowed: true }))
        return
      }

      const { toolName, toolInput } = data
      const label = formatToolLabel(toolName, toolInput)

      try {
        const allowed = await onPermission({ toolName, label, input: toolInput })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ allowed }))
      } catch (err) {
        console.error('[hook-server] 权限处理出错:', err)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ allowed: true }))
      }
    })
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[hook-server] 端口 ${PORT} 已被占用，请先停止已有进程再启动`)
      process.exit(1)
    } else {
      throw err
    }
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Hook 服务器已启动，端口: ${PORT}`)
  })

  return server
}
