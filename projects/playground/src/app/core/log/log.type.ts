/** `hook` — fired by a mutation lifecycle hook. `ui` — something you clicked. */
export type LogKind = 'hook' | 'ui'

export type LogEntry = {
  at: string
  text: string
  kind: LogKind
}
