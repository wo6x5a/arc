#!/usr/bin/env node
/**
 * Claude Code PreToolUse Hook
 * 只拦截由 ARC 启动的 Claude 会话
 * 通过 TELEGRAM_BRIDGE_SESSION 环境变量识别
 */

const HOOK_SERVER_URL = process.env.HOOK_SERVER_URL || 'http://127.0.0.1:7701'
const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoRead', 'NotebookRead'])

async function main() {
  // 不是 bridge 启动的会话，直接放行
  if (!process.env.TELEGRAM_BRIDGE_SESSION) {
    process.exit(0)
  }

  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
  }

  let hookData
  try {
    hookData = JSON.parse(input)
  } catch {
    process.exit(0)
  }

  const toolName = hookData.tool_name || hookData.tool?.name || ''
  const toolInput = hookData.tool_input || hookData.tool?.input || {}

  // 只读工具直接放行
  if (READONLY_TOOLS.has(toolName)) {
    process.exit(0)
  }

  // 向 bot 发请求，等待用户决定
  try {
    const resp = await fetch(`${HOOK_SERVER_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName, toolInput }),
      signal: AbortSignal.timeout(120000),
    })

    if (!resp.ok) {
      process.exit(0)
    }

    const result = await resp.json()
    if (!result.allowed) {
      console.log(JSON.stringify({ decision: 'block', reason: '用户拒绝了此操作' }))
    }
    process.exit(0)
  } catch {
    process.exit(0)
  }
}

main()
