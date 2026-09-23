/**
 * `hook` — fired by a mutation lifecycle hook. `query` — a queryFn was called,
 * one line per request. `ui` — something you clicked.
 */
export type LogKind = 'hook' | 'query' | 'ui'

export type LogEntry = {
  at: string
  text: string
  kind: LogKind
}
