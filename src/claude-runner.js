import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { realpathSync } from 'fs'

const NODE_BIN = realpathSync(process.execPath)
const CLAUDE_CLI = realpathSync(process.env.CLAUDE_BIN || '/Users/chenwu.lcw/.npm-global/bin/claude')

// notify: --dangerously-skip-permissions + 事后通知（默认，稳定）
// confirm: PreToolUse hook 拦截确认（需要 hook 服务器）
const PERMISSION_MODE = process.env.PERMISSION_MODE || 'notify'

function formatToolLabel(toolName, input) {
  const map = {
    Read:      () => `读取文件: ${input?.file_path || ''}`,
    Write:     () => `写入文件: ${input?.file_path || ''}`,
    Edit:      () => `编辑文件: ${input?.file_path || ''}`,
    MultiEdit: () => `编辑文件: ${input?.file_path || ''}`,
    Bash:      () => `执行命令: ${String(input?.command || '').slice(0, 80)}`,
    Glob:      () => `搜索文件: ${input?.pattern || ''}`,
    Grep:      () => `搜索内容: ${input?.pattern || ''}`,
    WebFetch:  () => `请求 URL: ${input?.url || ''}`,
  }
  return (map[toolName] ?? (() => `调用工具: ${toolName}`))(input)
}

/**
 * Claude Code 执行器
 * 权限控制由 PreToolUse hook + hook-server.js 处理
 */
export class ClaudeRunner {
  constructor(workDir) {
    this.workDir = workDir
  }

  setWorkDir(workDir) {
    this.workDir = workDir
  }

  async run({ prompt, session, onOutput, onToolUse, resumeSessionId }) {
    return this._runOnce({ prompt, session, onOutput, onToolUse, resumeSessionId })
      .catch(async (err) => {
        // session 过期导致失败时，自动用新 session 重试
        if (resumeSessionId && !session.abortController.signal.aborted) {
          console.log(`[runner] 会话恢复失败，自动重新开始新对话：${err.message}`)
          return this._runOnce({ prompt, session, onOutput, onToolUse, resumeSessionId: null })
        }
        throw err
      })
  }

  async _runOnce({ prompt, session, onOutput, onToolUse, resumeSessionId }) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CLAUDECODE: '',
        TELEGRAM_BRIDGE_SESSION: '1',
        HOOK_SERVER_URL: process.env.HOOK_SERVER_URL || 'http://127.0.0.1:7701',
      }

      const escapedPrompt = prompt.replace(/'/g, `'\\''`)
      const extraArgs = resumeSessionId ? `--resume ${resumeSessionId}` : ''
      if (resumeSessionId) {
        console.log(`[runner] 恢复会话 session_id=${resumeSessionId}`)
      }

      const skipPerms = PERMISSION_MODE !== 'confirm' ? '--dangerously-skip-permissions' : ''
      // confirm 模式才设置 TELEGRAM_BRIDGE_SESSION，让 hook 只在 confirm 模式下生效
      if (PERMISSION_MODE === 'confirm') {
        env.TELEGRAM_BRIDGE_SESSION = '1'
      }

      console.log(`[runner] 启动 claude，cwd=${this.workDir}，mode=${PERMISSION_MODE}`)
      console.log(`[runner] prompt="${prompt.slice(0, 80)}"`)

      // 系统提示：启动长期运行的服务时必须用后台模式，否则 claude 进程会阻塞
      const systemPrompt = `--append-system-prompt "重要：如果需要启动长期运行的服务（如 npm run dev、npm start、python app.py 等），必须用后台方式运行，例如：nohup npm run dev > /tmp/app.log 2>&1 & 然后输出服务已在后台启动，PID 为 xxx。"`
      const cmd = `'${NODE_BIN}' '${CLAUDE_CLI}' -p '${escapedPrompt}' --output-format stream-json --verbose ${skipPerms} ${systemPrompt} ${extraArgs}`
      const child = spawn(cmd, {
        cwd: this.workDir,
        env,
        shell: true,
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
      let claudeSessionId = null

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
        let msg
        try { msg = JSON.parse(line) } catch { return }
        handleMessage(msg).catch(err => console.error('[claude-runner] 处理消息出错:', err))
      })

      async function handleMessage(msg) {
        if (msg.session_id && !claudeSessionId) {
          claudeSessionId = msg.session_id
          console.log(`[runner] 获取到 session_id=${claudeSessionId}`)
        }

        switch (msg.type) {
          case 'assistant': {
            for (const block of msg.message?.content || []) {
              if (block.type === 'text' && block.text) {
                textBuffer += block.text + '\n'
                scheduleFlush()
              }
              if (block.type === 'tool_use' && onToolUse) {
                const label = formatToolLabel(block.name, block.input)
                onToolUse(label).catch(() => {})
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
            if (flushTimer) clearTimeout(flushTimer)
            await flushBuffer()
            if (msg.is_error) {
              const errMsg = msg.result || msg.error || '执行失败（无错误信息）'
              console.error('[runner] Claude 报错:', errMsg)
              reject(new Error(errMsg))
            } else if (msg.result && !hasOutput) {
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
          resolve(claudeSessionId)
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
