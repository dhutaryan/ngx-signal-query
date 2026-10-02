/**
 * Calls `poll` every `ms`, but never sooner than `ms` after `updatedAt()`:
 * when the timer comes due earlier, it waits out the rest of the interval
 * from then. Returns a function that stops polling.
 *
 * @internal
 */
export function startPolling(
  ms: number,
  updatedAt: () => number,
  poll: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout>

  const wait = (delay: number): void => {
    timer = setTimeout(() => {
      const elapsed = Date.now() - updatedAt()

      if (elapsed < ms) {
        wait(ms - elapsed)

        return
      }

      poll()
      wait(ms)
    }, delay)
  }

  wait(ms)

  return () => clearTimeout(timer)
}
