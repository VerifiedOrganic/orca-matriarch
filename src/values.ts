// Small readers of untrusted values (JSON from Orca, a forge, storage) and short forms for text,
// shared so each module reads them the same way.

export type Obj = Record<string, unknown>

/** An object to read fields from: the value itself when it is one, else an empty one. */
export const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})

/** A plain object (not an array): what a stored record must be before its fields are trusted. */
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A non-empty string, or null: an empty field counts as absent. */
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Text cut to `n` characters, an ellipsis marking the cut. */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A commit as people read it: its first seven characters. */
export const shortSha = (sha: string): string => sha.slice(0, 7)

/** What an error says, whatever was thrown. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A size on disk in GB, one decimal. */
export const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`
