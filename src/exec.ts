// Runs a command without a shell. Injected everywhere so tests never start a process.
import { execFile } from 'node:child_process'

export interface ExecResult {
  /** Exit code; 127 when the command could not be started, 124 when it was killed (a timeout). */
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

/**
 * The exit code for a command that did not exit 0, from Node's error: its own code; 127 when it
 * could not be started; 124 when it was killed (a timeout), as timeout(1) says, so a caller never
 * takes a timeout for the command's own exit 1.
 */
export function exitCodeOf(error: { code?: number | string | null; killed?: boolean; signal?: string | null }): number {
  if (error.killed || error.signal) return 124
  return typeof error.code === 'number' ? error.code : error.code === 'ENOENT' ? 127 : 1
}

export const nodeExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null }
        resolve({ code: exitCodeOf(e), stdout: stdout ?? '', stderr: stderr || String(e.message) })
      }
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
