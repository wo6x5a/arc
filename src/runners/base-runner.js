import { spawn } from 'child_process'
import { createInterface } from 'readline'

/**
 * AI Runner 抽象基类（Template Method 模式）
 *
 * 子类必须实现：
 *   - get displayName()                     显示名称，如 "Claude Code"
 *   - get binPath()                          可执行文件路径
 *   - buildArgs({ prompt, resumeSessionId }) 构建命令行参数数组
 *
 * 子类可覆盖：
 *   - buildEnv()                             构建环境变量（默认继承 process.env）
 *   - extractSessionId(msg)                  从 JSONL 消息提取 session_id
 *   - handleMessage(msg, ctx)                解析单行 JSONL 消息（默认支持 Claude/Qwen 格式）
 */
export class BaseRunner {
  constructor(workDir) {
    this.workDir = workDir
  }

  setWorkDir(workDir) {
    this.workDir = workDir
  }

  /** @returns {string} 显示名称 */
  get displayName() {
    throw new Error(`${this.constructor.name} must implement get displayName()`)
  }

  /** @returns {string} 可执行文件路径 */
  get binPath() {
    throw new Error(`${this.constructor.name} must implement get binPath()`)
  }

  /**
   * 构建命令行参数数组
   * @param {{ prompt: string, resumeSessionId: string|null }} options
   * @returns {string[]}
   */
  buildArgs(_options) {
    throw new Error(`${this.constructor.name} must implement buildArgs()`)
  }

  /**
   * 构建子进程环境变量
   * @returns {Object}
   */
  buildEnv() {
    return { ...process.env }
  }

  /**
   * 从 JSONL 消息中提取 session_id（用于下次恢复）
   * 默认实现：从 msg.session_id 读取
   * @param {Object} msg
   * @returns {string|null}
   */
  extractSessionId(msg) {
    return msg.session_id || null
  }

  /**
   * 处理单条 JSONL 消息（默认实现支持 Claude/Qwen 格式）
   * 子类可覆盖来适配不同输出格式
   *
   * @param {Object} msg 解析后的 JSON 对象
   * @param {Object} ctx 上下文
   * @param {function(string): void} ctx.appendText  追加文本到缓冲区
   * @param {function(): void}       ctx.scheduleFlush 调度输出 flush
   * @param {function(string): void} ctx.onToolUse   工具调用通知回调
   * @param {function(string): Promise<void>} ctx.onOutput 立即输出回调（result 类型用）
   * @param {function(string): void} ctx.setSessionId 设置 session_id
   * @param {function(): Promise<void>} ctx.flushBuffer 立即 flush 缓冲区
   * @param {function(string): void} ctx.reject 报错 reject
   * @param {{ hasOutput: boolean }} ctx.state
   */
  async handleMessage(msg, ctx) {
    const { appendText, scheduleFlush, onToolUse, onOutput, setSessionId, flushBuffer, reject, state } = ctx

    // 提取 session_id
    const sid = this.extractSessionId(msg)
    if (sid) setSessionId(sid)

    switch (msg.type) {
      case 'assistant': {
        for (const block of msg.message?.content || []) {
          if (block.type === 'text' && block.text) {
            appendText(block.text + '\n')
            scheduleFlush()
          }
          if (block.type === 'tool_use' && onToolUse) {
            const label = this._formatToolLabel(block.name, block.input)
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
          appendText(`\`\`\`\n${truncated}\n\`\`\`\n`)
          scheduleFlush()
        }
        break
      }

      case 'result': {
        await flushBuffer()
        if (msg.is_error) {
          const errMsg = msg.result || msg.error || '执行失败（无错误信息）'
          console.error(`[${this.displayName}] 报错:`, errMsg)
          reject(new Error(errMsg))
        } else if (msg.result && !state.hasOutput) {
          await onOutput(msg.result)
        }
        break
      }
    }
  }

  /**
   * 格式化工具调用标签（子类可覆盖）
   */
  _formatToolLabel(toolName, input) {
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
   * 执行（带自动重试）
   * session 过期时自动用新 session 重试一次
   */
  async run({ prompt, session, onOutput, onToolUse, resumeSessionId }) {
    return this._runOnce({ prompt, session, onOutput, onToolUse, resumeSessionId })
      .catch(async (err) => {
        if (resumeSessionId && !session.abortController.signal.aborted) {
          console.log(`[${this.displayName}] 会话恢复失败，自动重新开始新对话：${err.message}`)
          return this._runOnce({ prompt, session, onOutput, onToolUse, resumeSessionId: null })
        }
        throw err
      })
  }

  /**
   * 核心执行逻辑（模板方法）
   * @returns {Promise<string|null>} sessionId（用于下次 resume）
   */
  async _runOnce({ prompt, session, onOutput, onToolUse, resumeSessionId }) {
    return new Promise((resolve, reject) => {
      const env = this.buildEnv()
      const args = this.buildArgs({ prompt, resumeSessionId })

      if (resumeSessionId) {
        console.log(`[${this.displayName}] 恢复会话 session_id=${resumeSessionId}`)
      }
      console.log(`[${this.displayName}] 启动，cwd=${this.workDir}`)
      console.log(`[${this.displayName}] prompt="${prompt.slice(0, 80)}"`)

      const child = spawn(this.binPath, args, {
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
      let resolvedSessionId = null

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

      const ctx = {
        appendText: (text) => { textBuffer += text },
        scheduleFlush,
        onToolUse,
        onOutput,
        setSessionId: (sid) => { if (!resolvedSessionId) resolvedSessionId = sid },
        flushBuffer,
        reject,
        state: { get hasOutput() { return hasOutput } },
      }

      rl.on('line', (line) => {
        if (!line.trim()) return
        let msg
        try { msg = JSON.parse(line) } catch { return }
        this.handleMessage(msg, ctx).catch(err => console.error(`[${this.displayName}] 处理消息出错:`, err))
      })

      child.stderr.on('data', (data) => {
        const text = data.toString().trim()
        if (text) console.error(`[${this.displayName} stderr]`, text)
      })

      child.on('close', async (code) => {
        console.log(`[${this.displayName}] 进程结束，退出码=${code}`)
        session.abortController.signal.removeEventListener('abort', onAbort)
        if (flushTimer) clearTimeout(flushTimer)
        await flushBuffer()

        if (session.abortController.signal.aborted) return
        if (code === 0) {
          resolve(resolvedSessionId)
        } else {
          reject(new Error(`${this.displayName} 进程退出，退出码: ${code}`))
        }
      })

      child.on('error', (err) => {
        reject(new Error(`启动 ${this.displayName} 失败: ${err.message}`))
      })
    })
  }
}
