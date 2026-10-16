import { fakeAsync, flushMicrotasks } from '@angular/core/testing'
import { of, Subject, throwError } from 'rxjs'

import { CancelledError } from './cancelled-error'
import type { MutationOptions } from './mutation'
import { MutationCache } from './mutation-cache'
import { deferred } from './utils'

// What a promise has settled with so far, empty while it's pending. Read it
// after the microtasks have run.
function settled<T>(promise: Promise<T>): { value?: T; error?: unknown } {
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

describe('Mutation', () => {
  function build(options: MutationOptions<string, Error, void, unknown>) {
    return new MutationCache().build(options)
  }

  // execute() returns a promise of the run, settled once its last hook is
  // done, as the state is.
  describe('execute promise', () => {
    it('resolves with the data once its last hook is done', fakeAsync(() => {
      const audit = deferred<void>()
      const mutation = build({
        mutationFn: () => of('saved'),
        onSuccess: () => audit.promise,
      })
      const result = settled(mutation.execute())

      flushMicrotasks()
      expect(result).toEqual({})

      audit.resolve()
      flushMicrotasks()

      expect(result.value).toBe('saved')
    }))

    it('rejects with the error once its last hook is done', fakeAsync(() => {
      const error = new Error('down')
      const cleanup = deferred<void>()
      const mutation = build({
        mutationFn: () => throwError(() => error),
        onSettled: () => cleanup.promise,
      })
      const result = settled(mutation.execute())

      flushMicrotasks()
      expect(result).toEqual({})

      cleanup.resolve()
      flushMicrotasks()

      expect(result.error).toBe(error)
    }))

    it('rejects with a CancelledError when the run is cancelled', fakeAsync(() => {
      const mutation = build({ mutationFn: () => new Subject<string>() })
      const result = settled(mutation.execute())

      mutation.cancel()
      flushMicrotasks()

      expect(result.error).toBeInstanceOf(CancelledError)
      expect((result.error as Error).message).toBe('The mutation was cancelled')
    }))
  })
})
