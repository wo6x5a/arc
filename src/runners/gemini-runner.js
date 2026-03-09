import { BaseRunner } from './base-runner.js'

const GEMINI_BIN = process.env.GEMINI_BIN || 'gemini'

/**
 * Gemini CLI Runner
 *
 * 实测验证（2026-03-10），stream-json 格式与 Claude 完全不同：
 *   {"type":"init", "session_id":"<uuid>", "model":"..."}
 *   {"type":"message", "role":"user", "content":"..."}
 *   {"type":"message", "role":"assistant", "content":"...", "delta":true}  ← 流式增量
 *   {"type":"message", "role":"assistant", "content":"...", "delta":true}  ← 流式增量（续）
 *   {"type":"result", "status":"success", "stats":{...}}
 *
 * 差异点：
 * - 权限跳过用 `-y`
 * - session_id 从 type:init 事件取得
 * - 文本增量用 delta:true 的 message 事件，content 是字符串片段
 * - 工具调用格式待实测（暂时做基本支持）
 * - --resume 用 session_id（UUID 格式），实测有效
 */
export class GeminiRunner extends BaseRunner {
  get displayName() { return 'Gemini CLI' }

  get binPath() { return GEMINI_BIN }

  buildArgs({ prompt, resumeSessionId }) {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '-y',
    ]
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
    }
    return args
  }

  extractSessionId(msg) {
    // session_id 在 type:init 事件中
    return msg.session_id || null
  }

  /**
   * 覆盖消息处理（Gemini 格式与 Claude/Qwen 不同）
   */
  async handleMessage(msg, ctx) {
    const { appendText, scheduleFlush, onToolUse, onOutput, setSessionId, flushBuffer, reject, state } = ctx

    if (msg.session_id) setSessionId(msg.session_id)

    switch (msg.type) {
      case 'init': {
        // 初始化事件，含 session_id（已在上面处理）
        break
      }

      case 'message': {
        if (msg.role === 'assistant') {
          if (typeof msg.content === 'string' && msg.content) {
            // delta:true 表示流式增量片段，直接追加
            appendText(msg.content)
            scheduleFlush()
          }
        }
        break
      }

      case 'tool_use': {
        if (onToolUse) {
          const toolName = msg.tool_name || msg.name || msg.tool || '未知工具'
          const input = msg.parameters || msg.input || {}
          const label = this._formatToolLabel(toolName, input)
          onToolUse(label).catch(() => {})
        }
        break
      }

      case 'tool_result': {
        const output = msg.output || msg.content || ''
        if (output && typeof output === 'string' && output.trim()) {
          const truncated = output.length > 2000
            ? output.slice(0, 2000) + '\n...(输出已截断)'
            : output
          appendText(`\`\`\`\n${truncated}\n\`\`\`\n`)
          scheduleFlush()
        }
        break
      }

      case 'result': {
        await flushBuffer()
        if (msg.status === 'error' || msg.error) {
          const errMsg = msg.error || msg.message || '执行失败'
          console.error(`[${this.displayName}] 错误:`, errMsg)
          reject(new Error(errMsg))
        } else if (!state.hasOutput && msg.content) {
          await onOutput(msg.content)
        }
        break
      }
    }
  }
}
