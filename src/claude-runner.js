import { spawn } from 'child_process'
import { createInterface } from 'readline'

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'

function formatToolLabel(toolName, input) {
  const map = {
    Read: () => `读取文件: ${input?.file_path?.split('/').pop() || ''}`,
    Write: () => `写入文件: ${input?.file_path?.split('/').pop() || ''}`,
    Edit: () => `编辑文件: ${input?.file_path?.split('/').pop() || ''}`,
    Bash: () => `执行命令: ${String(input?.command || '').slice(0, 40)}`,
    Glob: () => `搜索文件: ${input?.pattern || ''}`,
    Grep: () => `搜索内容: ${input?.pattern || ''}`,
    WebFetch: () => `请求 URL: ${input?.url || ''}`,
  }
  return (map[toolName] ?? (() => `调用: ${toolName}`))()
}

/**
 * Claude Code 执行器
 * 通过子进程调用 claude -p CLI，解析 stream-json 输出
 * 支持通过 resumeSessionId 实现多轮对话
 */
export class ClaudeRunner {
  constructor(workDir) {
    this.workDir = workDir
  }

  setWorkDir(workDir) {
    this.workDir = workDir
  }

  async run({ prompt, session, onOutput, onProgress, onSummary, resumeSessionId }) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, CLAUDECODE: '' }

      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ]

      if (resumeSessionId) {
        args.push('--resume', resumeSessionId)
        console.log(`[runner] 恢复会话 session_id=${resumeSessionId}`)
      }

      console.log(`[runner] 启动 claude，cwd=${this.workDir}，bin=${CLAUDE_BIN}`)
      console.log(`[runner] prompt="${prompt.slice(0, 80)}"`)

      const child = spawn(CLAUDE_BIN, args, {
        cwd: this.workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const onAbort = () => {
        child.kill('SIGTERM')
        reject(new Error('ABORTED'))
      }
      session.abortController.signal.addEventListener('abort', onAbort, { once: true })

      const rl = createInterface({ input: child.stdout })
      let textBuffer = ''
      let flushTimer = null
      let hasOutput = false
      let claudeSessionId = null  // 从输出中提取的 session_id，用于下次 resume
      const stats = { toolCalls: [], startTime: Date.now() }

      const flushBuffer = async () => {
        if (textBuffer.trim()) {
          const text = textBuffer.trim()
          textBuffer = ''
          hasOutput = true
          await onOutput(text)
        }
      }

      const scheduleFlush = () => {
        if (flushTimer) clearTimeout(flushTimer)
        flushTimer = setTimeout(flushBuffer, 500)
      }

      rl.on('line', (line) => {
        if (!line.trim()) return
        console.log(`[runner] 收到行: ${line.slice(0, 120)}`)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }

        handleMessage(msg).catch(err => console.error('[claude-runner] 处理消息出错:', err))
      })

      async function handleMessage(msg) {
        // 从任意消息里提取 session_id
        if (msg.session_id && !claudeSessionId) {
          claudeSessionId = msg.session_id
          console.log(`[runner] 获取到 session_id=${claudeSessionId}`)
        }

        console.log(`[runner] 处理消息 type=${msg.type} subtype=${msg.subtype || '-'}`)
        switch (msg.type) {
          case 'assistant': {
            for (const block of msg.message?.content || []) {
              console.log(`[runner] assistant block type=${block.type}`)
              if (block.type === 'tool_use') {
                const label = formatToolLabel(block.name, block.input)
                stats.toolCalls.push({ name: block.name, label })
                if (onProgress) onProgress(label)
              }
              if (block.type === 'text' && block.text) {
                console.log(`[runner] 收到文字: "${block.text.slice(0, 80)}"`)
                textBuffer += block.text + '\n'
                scheduleFlush()
              }
            }
            break
          }

          case 'tool_result': {
            const content = Array.isArray(msg.content)
              ? msg.content.find(b => b.type === 'text')?.text
              : msg.content
            if (content && typeof content === 'string' && content.trim()) {
              const truncated = content.length > 2000
                ? content.slice(0, 2000) + '\n...(输出已截断)'
                : content
              textBuffer += `\`\`\`\n${truncated}\n\`\`\`\n`
              scheduleFlush()
            }
            break
          }

          case 'result': {
            console.log(`[runner] result: is_error=${msg.is_error}, hasOutput=${hasOutput}, result="${String(msg.result).slice(0, 80)}"`)
            if (flushTimer) clearTimeout(flushTimer)
            await flushBuffer()
            if (!msg.is_error && onSummary) {
              const duration = Math.round((Date.now() - stats.startTime) / 1000)
              await onSummary({ toolCalls: stats.toolCalls, duration, sessionId: claudeSessionId }).catch(err => console.error('[runner] onSummary 错误:', err))
            }
            if (msg.is_error) {
              reject(new Error(msg.result || '执行失败'))
            } else if (msg.result && !hasOutput) {
              console.log(`[runner] 使用兜底 result 字段发送`)
              await onOutput(msg.result)
            }
            break
          }
        }
      }

      child.stderr.on('data', (data) => {
        const text = data.toString().trim()
        if (text) console.error('[claude stderr]', text)
      })

      child.on('close', async (code) => {
        console.log(`[runner] 进程结束，退出码=${code}`)
        session.abortController.signal.removeEventListener('abort', onAbort)
        if (flushTimer) clearTimeout(flushTimer)
        await flushBuffer()

        if (session.abortController.signal.aborted) return
        if (code === 0) {
          resolve(claudeSessionId)  // 返回 session_id 供下次 resume 使用
        } else {
          reject(new Error(`claude 进程退出，退出码: ${code}`))
        }
      })

      child.on('error', (err) => {
        reject(new Error(`启动 claude 失败: ${err.message}`))
      })
    })
  }
}
