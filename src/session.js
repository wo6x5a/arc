/**
 * 会话管理器
 * 每个 chatId 维护一个任务队列，串行执行
 */
export class SessionManager {
  constructor() {
    this.queues = new Map()  // chatId -> { running: Session|null, pending: Task[] }
  }

  _getQueue(chatId) {
    if (!this.queues.has(chatId)) {
      this.queues.set(chatId, { running: null, pending: [] })
    }
    return this.queues.get(chatId)
  }

  isRunning(chatId) {
    return this._getQueue(chatId).running !== null
  }

  pendingCount(chatId) {
    return this._getQueue(chatId).pending.length
  }

  currentTask(chatId) {
    return this._getQueue(chatId).running?.task || null
  }

  /**
   * 入队一个任务，返回 Promise，任务执行完后 resolve
   * executor: async (session) => any
   */
  enqueue(chatId, taskName, executor) {
    const queue = this._getQueue(chatId)

    return new Promise((resolve, reject) => {
      queue.pending.push({ task: taskName, executor, resolve, reject })
      this._drain(chatId)
    })
  }

  /**
   * 驱动队列：如果当前没有任务在跑，取队首执行
   */
  async _drain(chatId) {
    const queue = this._getQueue(chatId)
    if (queue.running || queue.pending.length === 0) return

    const { task, executor, resolve, reject } = queue.pending.shift()

    const session = {
      task,
      abortController: new AbortController(),
      abort() { this.abortController.abort() }
    }
    queue.running = session

    try {
      const result = await executor(session)
      resolve(result)
    } catch (err) {
      reject(err)
    } finally {
      queue.running = null
      this._drain(chatId)  // 执行下一个
    }
  }

  /**
   * 中止当前正在执行的任务，清空队列
   */
  abortAll(chatId) {
    const queue = this._getQueue(chatId)
    if (queue.running) {
      queue.running.abort()
    }
    // 把排队中的任务全部 reject
    for (const { reject } of queue.pending) {
      reject(new Error('ABORTED'))
    }
    queue.pending = []
    queue.running = null
  }
}
