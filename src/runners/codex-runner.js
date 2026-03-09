import { BaseRunner } from './base-runner.js'

const CODEX_BIN = process.env.CODEX_BIN || 'codex'

/**
 * Codex CLI Runner（OpenAI Codex）
 *
 * 实测验证（2026-03-10），JSONL 格式：
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"message.delta","content":"..."}           ← 流式文本增量（推测）
 *   {"type":"message.completed","content":"..."}       ← 完整消息（推测）
 *   {"type":"tool.call","name":"...","input":{...}}    ← 工具调用（推测）
 *   {"type":"tool.result","output":"..."}              ← 工具结果（推测）
 *   {"type":"turn.completed"}
 *   {"type":"error","message":"..."}
 *   {"type":"turn.failed","error":{"message":"..."}}
 *
 * 差异点：
 * - 子命令结构：`codex exec`（新会话）或 `codex exec resume <id>`（恢复）
 * - session_id 叫 thread_id，从 type:thread.started 取得
 * - 权限跳过：--dangerously-bypass-approvals-and-sandbox
 * - 原生 -C <dir> 支持工作目录
 * - 需要 OPENAI_API_KEY 或 CRS_OAI_KEY 环境变量
 *
 * 注意：文本 delta 和工具调用的具体字段名尚未实测（API key 缺失），
 * 如遇到格式不匹配，查看 pm2 日志中的 [Codex CLI stderr] 输出调整。
 */
export class CodexRunner extends BaseRunner {
  get displayName() { return 'Codex CLI' }

  get binPath() { return CODEX_BIN }

  buildArgs({ prompt, resumeSessionId }) {
    if (resumeSessionId) {
      // 恢复会话：codex exec resume <thread_id> <prompt>
      return [
        'exec', 'resume',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        resumeSessionId,
        prompt,
      ]
    }
    // 新会话：codex exec -C <dir> <prompt>
    return [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C', this.workDir,
      prompt,
    ]
  }

  extractSessionId(msg) {
    // Codex 用 thread_id 而非 session_id
    return msg.thread_id || null
  }

  /**
   * 覆盖消息处理（Codex 格式与 Claude/Qwen/Gemini 均不同）
   * 部分事件类型基于推测，如不匹配请查日志调整
   */
  async handleMessage(msg, ctx) {
    const { appendText, scheduleFlush, onToolUse, onOutput, setSessionId, flushBuffer, reject, state } = ctx

    if (msg.thread_id) setSessionId(msg.thread_id)

    switch (msg.type) {
      case 'thread.started': {
        // thread_id 已在上面提取
        break
      }

      case 'turn.started': {
        break
      }

      // 流式文本增量
      case 'message.delta':
      case 'text.delta': {
        const text = msg.content || msg.text || msg.delta || ''
        if (text) {
          appendText(text)
          scheduleFlush()
        }
        break
      }

      // 完整消息（非流式或最终版本）
      case 'message.completed':
      case 'message': {
        const content = msg.content || ''
        if (typeof content === 'string' && content.trim()) {
          appendText(content + '\n')
          scheduleFlush()
        }
        break
      }

      // 工具调用
      case 'tool.call':
      case 'function_call': {
        if (onToolUse) {
          const toolName = msg.name || msg.tool || '未知工具'
          const input = msg.input || msg.arguments || {}
          const cmd = input.command || input.cmd || ''
          const label = cmd
            ? `执行命令: ${String(cmd).slice(0, 80)}`
            : `调用工具: ${toolName}`
          onToolUse(label).catch(() => {})
        }
        break
      }

      // 工具结果
      case 'tool.result':
      case 'function_result': {
        const output = msg.output || msg.result || ''
        if (output && typeof output === 'string' && output.trim()) {
          const truncated = output.length > 2000
            ? output.slice(0, 2000) + '\n...(输出已截断)'
            : output
          appendText(`\`\`\`\n${truncated}\n\`\`\`\n`)
          scheduleFlush()
        }
        break
      }

      // 执行完成
      case 'turn.completed': {
        await flushBuffer()
        break
      }

      // 错误
      case 'error':
      case 'turn.failed': {
        await flushBuffer()
        const errMsg = msg.message || msg.error?.message || '执行失败'
        console.error(`[${this.displayName}] 错误:`, errMsg)
        reject(new Error(errMsg))
        break
      }
    }
  }
}
