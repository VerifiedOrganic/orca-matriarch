// Which CI failures look like the infrastructure failing rather than the code: a runner that went
// away, the network, a registry turning requests away. Such a check is re-run once before a worker
// spends a round on it (fix.ci.rerunFlaky). The list is kept short on purpose: a failing test, a
// compile error or a test that times out must never match, so anything not listed goes to the
// worker as before.

/** Each sign, and how the board names it. Matched against a failed job's log tail and annotations. */
export const FLAKY_SIGNS: readonly { sign: RegExp; why: string }[] = [
  // GitHub Actions: the runner went away in the middle of the job.
  { sign: /The runner has received a shutdown signal/i, why: 'the runner shut down' },
  { sign: /lost communication with the server/i, why: 'the runner lost its connection' },
  { sign: /The hosted runner encountered an error/i, why: 'the hosted runner failed' },
  // GitLab's own reasons for a job that failed around its script, not in it.
  { sign: /^failure_reason: runner_system_failure$/m, why: 'the GitLab runner failed' },
  { sign: /^failure_reason: stuck_or_timeout_failure$/m, why: 'the job got stuck waiting for a runner' },
  { sign: /^failure_reason: api_failure$/m, why: "GitLab's API failed" },
  { sign: /^failure_reason: scheduler_failure$/m, why: 'GitLab could not schedule the job' },
  { sign: /^failure_reason: data_integrity_failure$/m, why: 'GitLab lost track of the job' },
  // The network.
  { sign: /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/, why: 'a network connection failed' },
  { sign: /Could not resolve host|Temporary failure in name resolution/i, why: 'a host name did not resolve' },
  { sign: /\b502 Bad Gateway\b|\b503 Service (?:Temporarily )?Unavailable\b/i, why: 'a server was unavailable' },
  { sign: /TLS handshake timeout/i, why: 'a TLS handshake timed out' },
  // Registries and APIs turning requests away.
  { sign: /\b429 Too Many Requests\b|rate limit exceeded/i, why: 'a rate limit' }
]

/** Why a failed check looks flaky, from what its forge kept of it; null when it looks like a real failure. */
export function flakyReason(details: string): string | null {
  for (const { sign, why } of FLAKY_SIGNS) if (sign.test(details)) return why
  return null
}
