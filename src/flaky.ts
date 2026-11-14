// Which CI failures look like the infrastructure failing rather than the code: a runner that went
// away, GitLab's own failure reasons, or a package manager, git or a container registry unable to
// reach its server. Such a check is re-run once before a worker spends a round on it
// (fix.ci.rerunFlaky). A wrong "flaky" costs a re-run and delays the worker; so the list is short
// and each sign matches only the line its tool prints when it fails, at the start of that line.
// A test's output (its name, an assertion, an HTTP status the app under test answered, a database
// it could not reach) never matches, nor does a warning about something that recovered.

/** Each sign, and how the board names it. Matched against each line of a failed job's log tail and annotations. */
export const FLAKY_SIGNS: readonly { sign: RegExp; why: string }[] = [
  // GitHub Actions: the runner went away in the middle of the job.
  { sign: /The runner has received a shutdown signal/, why: 'the runner shut down' },
  { sign: /lost communication with the server/, why: 'the runner lost its connection' },
  { sign: /^The hosted runner encountered an error/, why: 'the hosted runner failed' },
  // GitLab's own reasons for a job that failed around its script, not in it.
  { sign: /^failure_reason: runner_system_failure$/, why: 'the GitLab runner failed' },
  { sign: /^failure_reason: stuck_or_timeout_failure$/, why: 'the job got stuck waiting for a runner' },
  { sign: /^failure_reason: api_failure$/, why: "GitLab's API failed" },
  { sign: /^failure_reason: scheduler_failure$/, why: 'GitLab could not schedule the job' },
  { sign: /^failure_reason: data_integrity_failure$/, why: 'GitLab lost track of the job' },
  // Package managers that could not reach their registry, in their own error lines.
  { sign: /^npm ERR! (?:code (?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|E429|E50[0234])\b|network )/, why: 'the npm registry could not be reached' },
  { sign: /^ERR_PNPM_(?:META_FETCH_FAIL|FETCH_429|FETCH_50[0234])\b/, why: 'the npm registry could not be reached' },
  { sign: /^error An unexpected error occurred: ".*\b(?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN)\b/, why: 'the yarn registry could not be reached' },
  // git that could not reach the remote, while checking out or fetching.
  { sign: /^fatal: unable to access '[^']*': (?:Could not resolve host|Failed to connect|Connection timed out|Recv failure|OpenSSL SSL_(?:read|connect))/, why: 'git could not reach the remote' },
  { sign: /^error: RPC failed; (?:HTTP 50[0234]|curl \d+)/, why: 'git lost its connection to the remote' },
  // A container registry turning a pull away.
  { sign: /^(?:Error response from daemon|Error: failed to (?:pull|resolve|copy)|error pulling image)\b.*(?:TLS handshake timeout|i\/o timeout|50[0234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)|toomanyrequests)/i, why: 'the container registry could not be reached' },
  { sign: /^toomanyrequests: You have reached your pull rate limit/, why: "Docker Hub's pull rate limit" },
  // GitHub's API limit, hit by an action (a setup step reading releases, say).
  { sign: /^API rate limit exceeded for /, why: "GitHub's API rate limit" }
]

/** Lines that say nothing about why the job failed: warnings, and a test's own name or assertion. */
const SKIP = /\bwarn(?:ing)?\b|[✕✗✘×✓✔●]|\bassert|\bexpect(?:ed)?\b|^(?:FAIL|PASS|not ok|ok)\b|\b(?:it|test|describe)\(/i

/** Why a failed check looks flaky, from what its forge kept of it; null when it looks like a real failure. */
export function flakyReason(details: string): string | null {
  for (const raw of details.split(/\r?\n/)) {
    // GitHub marks an error line `##[error]`; the tool's own words follow.
    const line = raw.trim().replace(/^##\[error\]/, '')
    if (line === '' || SKIP.test(line)) continue
    for (const { sign, why } of FLAKY_SIGNS) if (sign.test(line)) return why
  }
  return null
}
