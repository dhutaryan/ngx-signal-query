export type Todo = {
  id: number
  title: string
}

export type AddTodoVars = {
  title: string
  /** Latency of this one request, in ms — lets us stage a race deterministically. */
  delayMs: number
}

/**
 * `real` hits dummyjson over HTTP, so requests show up in the network panel
 * (and you can watch them get cancelled). `fake` is in-memory — same timings,
 * no network.
 */
export type Backend = 'real' | 'fake'

/** Shape dummyjson actually returns. */
export type DummyTodo = {
  id: number
  todo: string
}
