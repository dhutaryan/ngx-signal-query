// What a promise has settled with so far, empty while it's pending. Read it
// after the microtasks have run.
export function settled<T>(promise: Promise<T>): {
  value?: T
  error?: unknown
} {
  const result: { value?: T; error?: unknown } = {}

  promise.then(
    (value) => {
      result.value = value
    },
    (error: unknown) => {
      result.error = error
    },
  )

  return result
}
