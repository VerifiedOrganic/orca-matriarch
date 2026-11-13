// Runs a command without a shell. Injected everywhere so tests never start a process.
import { execFile } from 'node:child_process'

export interface ExecResult {
  /** Exit code; 127 when the command could not be started. */
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  input?: string
  cwd?: string
  timeoutMs?: number
}

export type Exec = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>

export const nodeExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        const e = error as NodeJS.ErrnoException & { code?: number | string }
        const code = typeof e.code === 'number' ? e.code : e.code === 'ENOENT' ? 127 : 1
        resolve({ code, stdout: stdout ?? '', stderr: stderr || String(e.message) })
      }
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
