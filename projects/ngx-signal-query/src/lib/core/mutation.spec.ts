import { TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing'
import { of, Subject, throwError } from 'rxjs'

import { settled } from '../../spec-helpers/promises'
import { Mutation, type MutationOptions, type MutationState } from './mutation'
import { MutationCache } from './mutation-cache'
import { deferred } from './utils'

describe('Mutation', () => {
  function build(options: MutationOptions<string, Error, void, unknown>) {
    return TestBed.runInInjectionContext(() => new MutationCache()).build(
      options,
    )
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
  })

  // A run holds one of the app's pending tasks until its last hook is done.
  // Angular counts the app as busy while any is held, so it's removed only
  // once the state shows how the run ended: whoever waits for the app to
  // settle reads it.
  describe('pending task', () => {
    // A mutation whose runs hold tasks of a stand-in for the app's pending
    // tasks: `held` counts those held now. As each is removed, `removals`
    // records the mutation's state and how many are still held.
    function withTasks(options: MutationOptions<string, Error, void, unknown>) {
      // The mutation only calls cache.remove(this) once done; a stub is
      // enough.
      const cache = { remove: jasmine.createSpy('remove') }
      const tasks = {
        held: 0,
        removals: [] as Array<{
          state: MutationState<string, Error, void, unknown>
          held: number
        }>,
      }
      const mutation: Mutation<string, Error, void, unknown> = new Mutation(
        1,
        options,
        cache as unknown as MutationCache,
        {
          add: () => {
            tasks.held++

            return () => {
              tasks.held--
              tasks.removals.push({ state: mutation.state(), held: tasks.held })
            }
          },
        },
        // Angular's zone as an app without zone.js has it: both run what
        // they're given as is.
        { run: (fn) => fn(), runOutsideAngular: (fn) => fn() },
      )

      return { mutation, tasks }
    }

    it('holds one until the last hook is done, and removes it once the data is in', fakeAsync(() => {
      const response = new Subject<string>()
      const audit = deferred<void>()
      const { mutation, tasks } = withTasks({
        mutationFn: () => response,
        onSuccess: () => audit.promise,
      })

      settled(mutation.execute())
      expect(tasks.held).toBe(1)

      response.next('saved')
      response.complete()
      flushMicrotasks()
      expect(tasks.held).toBe(1)

      audit.resolve()
      flushMicrotasks()

      expect(tasks.removals).toEqual([
        {
          state: jasmine.objectContaining({ status: 'success', data: 'saved' }),
          held: 0,
        },
      ])
    }))

    it('removes it once the error is in, after the last hook', fakeAsync(() => {
      const error = new Error('down')
      const cleanup = deferred<void>()
      const { mutation, tasks } = withTasks({
        mutationFn: () => throwError(() => error),
        onSettled: () => cleanup.promise,
      })

      settled(mutation.execute())
      flushMicrotasks()
      expect(tasks.held).toBe(1)

      cleanup.resolve()
      flushMicrotasks()

      expect(tasks.removals).toEqual([
        {
          state: jasmine.objectContaining({ status: 'error', error }),
          held: 0,
        },
      ])
    }))
  })
})
