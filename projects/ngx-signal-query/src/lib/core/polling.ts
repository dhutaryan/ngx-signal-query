/**
 * Calls `poll` every `ms`, but never sooner than `ms` after `updatedAt()`:
 * when the timer comes due earlier, it waits out the rest of the interval
 * from then. Returns a function that stops polling, even when a poll calls it.
 *
 * A poll that throws doesn't end polling: what it throws comes out of its
 * timer, and the next poll comes on time.
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

      // The next poll's timer is set first: if this poll throws, polling goes
      // on, and if it calls stop(), stop() clears that timer.
      wait(ms)
      poll()
    }, delay)
  }

  wait(ms)

  return () => clearTimeout(timer)
}
