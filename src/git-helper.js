import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * 检查工作目录是否有未提交的变更
 * 返回 { hasChanges, files } 或 null（不是 git 仓库或 git 不可用）
 */
export async function getGitStatus(cwd) {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd })
    const files = stdout.trim().split('\n').filter(Boolean)
    return { hasChanges: files.length > 0, files }
  } catch {
    return null
  }
}

/**
 * 执行 git add -A && git commit
 * 返回 commit hash（短）
 */
export async function gitCommit(cwd, message) {
  await execAsync('git add -A', { cwd })
  await execAsync(`git commit -m ${JSON.stringify(message)}`, { cwd })
  const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd })
  return stdout.trim()
}
