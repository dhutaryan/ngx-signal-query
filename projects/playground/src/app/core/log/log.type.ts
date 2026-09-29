/**
 * `hook` — fired by a mutation lifecycle hook. `query` — a queryFn was called,
 * one line per request. `ui` — something you clicked. `error` — an uncaught
 * error, reported by the ErrorHandler.
 */
export type LogKind = 'hook' | 'query' | 'ui' | 'error'

export type LogEntry = {
  at: string
  text: string
  kind: LogKind
}
