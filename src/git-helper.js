import { execFile } from 'child_process'

/**
 * 检查工作目录是否有未提交的变更
 * 返回 { hasChanges, files } 或 null（不是 git 仓库或 git 不可用）
 */
export async function getGitStatus(cwd) {
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('git', ['status', '--porcelain'], { cwd }, (err, out) => {
        if (err) reject(err); else resolve(out)
      })
    })
    const files = stdout.trim().split('\n').filter(Boolean)
    return { hasChanges: files.length > 0, files }
  } catch (err) {
    // 非 git 仓库时 git 命令会报错，这是正常情况，只记录非常见错误
    if (!err.message?.includes('not a git repository')) {
      console.warn('[git] getGitStatus 异常:', err.message)
    }
    return null
  }
}

/**
 * 执行 git add -A && git commit
 * 返回 commit hash（短）
 */
export async function gitCommit(cwd, message) {
  await new Promise((resolve, reject) => {
    execFile('git', ['add', '-A'], { cwd }, (err) => {
      if (err) reject(err); else resolve()
    })
  })
  await new Promise((resolve, reject) => {
    execFile('git', ['commit', '-m', message], { cwd }, (err) => {
      if (err) reject(err); else resolve()
    })
  })
  const hash = await new Promise((resolve, reject) => {
    execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout.trim())
    })
  })
  return hash
}
