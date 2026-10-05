import {
  Component,
  InjectionToken,
  Injector,
  type Signal,
  effect,
  inject,
  signal,
} from '@angular/core'
import {
  type ComponentFixture,
  TestBed,
  fakeAsync,
  flush,
  flushMicrotasks,
  tick,
} from '@angular/core/testing'
import { EMPTY, of, Subject, throwError } from 'rxjs'

import { withDefaultOptions } from '../features/with-default-options'
import { injectMutation } from './inject-mutation'
import type { MutationOptions, MutationResult } from './mutation'
import { mutationOptions } from './mutation-options'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { DefaultOptions } from './types'

// A promise the spec settles by hand. A hook that returns it keeps running
// until the spec resolves or rejects it.
function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

describe('injectMutation', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
  })

  // injectMutation has no effects (only pull-based computeds), so a real view
  // isn't needed — an injection context is enough.
  function setup<TData, TError = Error, TVariables = void, TContext = unknown>(
    optionsFn: () => MutationOptions<TData, TError, TVariables, TContext>,
  ): MutationResult<TData, TError, TVariables> {
    return TestBed.runInInjectionContext(() => injectMutation(optionsFn))
  }

  describe('status', () => {
    it('is idle initially', () => {
      const m = setup(() => ({ mutationFn: () => of(1) }))

      expect(m.isIdle()).toBe(true)
      expect(m.status()).toBe('idle')
      expect(m.isPending()).toBe(false)
      expect(m.data()).toBeUndefined()
      expect(m.variables()).toBeUndefined()
    })

    it('goes pending while the mutation is in flight', fakeAsync(() => {
      const subject = new Subject<number>()
      const m = setup<number, Error, number>(() => ({
        mutationFn: () => subject,
      }))

      m.mutate(5)

      expect(m.isPending()).toBe(true)
      expect(m.isIdle()).toBe(false)
      expect(m.variables()).toBe(5) // variables are set immediately

      subject.next(10)
      subject.complete()
      tick()

      expect(m.isSuccess()).toBe(true)
      expect(m.isPending()).toBe(false)
      expect(m.data()).toBe(10)
    }))

    it('resolves to success with data and variables', () => {
      const m = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v * 2),
      }))

      m.mutate(3)

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe(6)
      expect(m.variables()).toBe(3)
      expect(m.error()).toBeNull()
    })

    it('transitions to error when the mutation fails', () => {
      const err = new Error('boom')
      const m = setup(() => ({ mutationFn: () => throwError(() => err) }))

      m.mutate()

      expect(m.isError()).toBe(true)
      expect(m.isPending()).toBe(false)
      expect(m.error()).toBe(err)
    })

    it('errors when the mutationFn completes without emitting', () => {
      const m = setup<number>(() => ({ mutationFn: () => EMPTY }))

      m.mutate()

      expect(m.isError()).toBe(true)
      expect(m.error()?.message).toContain('without emitting')
    })

    it('re-runs and overwrites state on a second mutate', () => {
      const m = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v),
      }))

      m.mutate(1)
      expect(m.data()).toBe(1)

      m.mutate(2)
      expect(m.data()).toBe(2)
      expect(m.variables()).toBe(2)
    })
  })

  describe('reset', () => {
    it('returns the mutation to idle', () => {
      const m = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v),
      }))

      m.mutate(7)
      expect(m.isSuccess()).toBe(true)

      m.reset()

      expect(m.isIdle()).toBe(true)
      expect(m.data()).toBeUndefined()
      expect(m.variables()).toBeUndefined()
      expect(m.error()).toBeNull()
    })

    it('forgets an in-flight mutation without cancelling it', fakeAsync(() => {
      const subject = new Subject<number>()
      const onSuccess = jasmine.createSpy('onSuccess')
      const m = setup<number, Error, number>(() => ({
        mutationFn: () => subject,
        onSuccess,
      }))

      m.mutate(1)
      expect(m.isPending()).toBe(true)

      m.reset()
      expect(m.isIdle()).toBe(true)

      subject.next(1)
      subject.complete()
      tick()

      // The write can't be un-sent, so it runs to completion and its hooks fire
      // — otherwise the cache would never learn about a write that succeeded.
      expect(onSuccess).toHaveBeenCalledWith(1, 1, undefined)

      // The result is still forgotten: the signals stay idle.
      expect(m.isIdle()).toBe(true)
      expect(m.data()).toBeUndefined()

      // …and the abandoned run cleans itself out of the cache.
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))
  })

  describe('retry', () => {
    it('does not retry by default', () => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(throwError(() => new Error('fail')))
      const m = setup<unknown, Error, void>(() => ({ mutationFn }))

      m.mutate()

      expect(mutationFn).toHaveBeenCalledTimes(1)
      expect(m.isError()).toBe(true)
    })

    it('retries when configured and eventually succeeds', fakeAsync(() => {
      let attempts = 0
      const m = setup(() => ({
        mutationFn: () => {
          attempts++

          return attempts < 3 ? throwError(() => new Error('fail')) : of('ok')
        },
        retry: 3,
        retryDelay: () => 10,
      }))

      m.mutate()
      tick(100)

      expect(attempts).toBe(3)
      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('ok')
      // The failed attempts led to a success, so there's no failure to show.
      expect(m.failureCount()).toBe(0)
      expect(m.failureReason()).toBeNull()
    }))

    it('tracks failureCount and failureReason when retries are exhausted', fakeAsync(() => {
      const err = new Error('nope')
      const m = setup(() => ({
        mutationFn: () => throwError(() => err),
        retry: 2,
        retryDelay: () => 10,
      }))

      m.mutate()
      tick(100)

      expect(m.isError()).toBe(true)
      expect(m.failureCount()).toBe(3) // retry: 2 -> 3 attempts
      expect(m.failureReason()).toBe(err)
    }))
  })

  describe('side-effect callbacks', () => {
    it('fires onMutate -> onSuccess -> onSettled with the context on success', () => {
      const order: string[] = []
      const m = setup<number, Error, number, { ctx: number }>(() => ({
        mutationFn: (v) => of(v),
        onMutate: (v) => {
          order.push('mutate')

          return { ctx: v }
        },
        onSuccess: (data, v, context) =>
          order.push(`success:${data}:${v}:${context?.ctx}`),
        onError: () => order.push('error'),
        onSettled: (data, err, v, context) =>
          order.push(`settled:${data}:${context?.ctx}`),
      }))

      m.mutate(5)

      expect(order).toEqual(['mutate', 'success:5:5:5', 'settled:5:5'])
    })

    it('fires onError and onSettled with the context on failure', () => {
      const err = new Error('boom')
      const onSuccess = jasmine.createSpy('onSuccess')
      const onError = jasmine.createSpy('onError')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<number, Error, number, { rollback: boolean }>(() => ({
        mutationFn: () => throwError(() => err),
        onMutate: () => ({ rollback: true }),
        onSuccess,
        onError,
        onSettled,
      }))

      m.mutate(2)

      expect(onSuccess).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(err, 2, { rollback: true })
      expect(onSettled).toHaveBeenCalledWith(undefined, err, 2, {
        rollback: true,
      })
    })

    it('supports optimistic update + rollback via context', () => {
      client.setQueryData(['todos'], ['a'])

      const m = setup<unknown, Error, string, { prev: string[] }>(() => ({
        mutationFn: () => throwError(() => new Error('fail')),
        onMutate: (todo) => {
          const prev = client.getQueryData<string[]>(['todos']) ?? []

          client.setQueryData(['todos'], [...prev, todo])

          return { prev }
        },
        onError: (_err, _todo, context) => {
          if (context) client.setQueryData(['todos'], context.prev)
        },
      }))

      m.mutate('b')

      // Optimistically added 'b', then rolled back to the snapshot on error.
      expect(client.getQueryData(['todos'])).toEqual(['a'])
    })
  })

  // A hook may return a promise. The run waits for it before moving on, and
  // stays pending until its last hook is done.
  describe('async hooks', () => {
    it('stays pending until an async onSuccess resolves', fakeAsync(() => {
      const response = new Subject<string>()
      const audit = deferred()
      const m = setup(() => ({
        mutationFn: () => response,
        // Logs the saved record somewhere, e.g. to an audit trail.
        onSuccess: () => audit.promise,
      }))

      m.mutate()
      response.next('saved')
      response.complete()
      flushMicrotasks()

      // The write landed, but its onSuccess is still running.
      expect(m.isPending()).toBe(true)
      expect(m.data()).toBeUndefined()

      audit.resolve()
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
    }))

    it('runs onSettled once an async onSuccess resolves', fakeAsync(() => {
      const audit = deferred()
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => audit.promise,
        onSettled,
      }))

      m.mutate()
      flushMicrotasks()

      expect(onSettled).not.toHaveBeenCalled()

      audit.resolve()
      flushMicrotasks()

      expect(onSettled).toHaveBeenCalledOnceWith(
        'saved',
        null,
        undefined,
        undefined,
      )
    }))

    it('stays pending until an async onError resolves, then runs onSettled', fakeAsync(() => {
      const error = new Error('boom')
      const rollback = deferred()
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => error),
        onError: () => rollback.promise,
        onSettled,
      }))

      m.mutate()
      flushMicrotasks()

      expect(m.isPending()).toBe(true)
      expect(onSettled).not.toHaveBeenCalled()

      rollback.resolve()
      flushMicrotasks()

      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(error)
      expect(onSettled).toHaveBeenCalledOnceWith(
        undefined,
        error,
        undefined,
        undefined,
      )
    }))

    it('stays pending until an async onSettled resolves', fakeAsync(() => {
      const cleanup = deferred()
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSettled: () => cleanup.promise,
      }))

      m.mutate()
      flushMicrotasks()

      expect(m.isPending()).toBe(true)

      cleanup.resolve()
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
    }))

    it('sends the write once an async onMutate resolves, and passes its value on as the context', fakeAsync(() => {
      const snapshot = deferred<{ previous: string[] }>()
      const sent: string[] = []
      const contexts: Array<{ previous: string[] } | undefined> = []
      const m = setup(() => ({
        mutationFn: (title: string) => {
          sent.push(title)

          return throwError(() => new Error('boom'))
        },
        // Snapshots the list for a rollback; getting it may take a while.
        onMutate: () => snapshot.promise,
        onError: (_error, _title, context) => contexts.push(context),
        onSettled: (_data, _error, _title, context) => contexts.push(context),
      }))

      m.mutate('b')
      flushMicrotasks()

      // Nothing goes out while onMutate is still running.
      expect(sent).toEqual([])

      snapshot.resolve({ previous: ['a'] })
      flushMicrotasks()

      expect(sent).toEqual(['b'])
      expect(contexts).toEqual([{ previous: ['a'] }, { previous: ['a'] }])
    }))

    it('settles inside mutate() when no hook returns a promise', () => {
      const saved: string[] = []
      const m = setup(() => ({
        mutationFn: () => of('note'),
        // Returns the new length, a plain value: nothing to wait for.
        onSuccess: (note) => saved.push(note),
      }))

      m.mutate()

      expect(m.isSuccess()).toBe(true)
      expect(saved).toEqual(['note'])
    })

    it('counts an earlier run until its onSuccess is done, while the signals follow the latest call', fakeAsync(() => {
      const responses = { a: new Subject<string>(), b: new Subject<string>() }
      const audits = { a: deferred(), b: deferred() }
      const m = setup(() => ({
        mutationFn: (title: 'a' | 'b') => responses[title],
        onSuccess: (_saved, title) => audits[title].promise,
      }))

      m.mutate('a')
      responses.a.next('a saved')
      responses.a.complete()
      m.mutate('b')

      // 'a' landed and its onSuccess is still running; 'b' is in flight.
      expect(client.isMutating()).toBe(2)
      expect(m.variables()).toBe('b')

      audits.a.resolve()
      flushMicrotasks()

      // 'a' is done and leaves the cache. The signals still follow 'b'.
      expect(client.isMutating()).toBe(1)
      expect(client.getMutationCache().getAll().length).toBe(1)
      expect(m.isPending()).toBe(true)
      expect(m.variables()).toBe('b')
    }))

    it('forgets a run whose onSuccess is still running, and counts it until that is done', fakeAsync(() => {
      const audit = deferred()
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => audit.promise,
        onSettled,
      }))

      m.mutate()
      m.reset()

      expect(m.isIdle()).toBe(true)
      expect(client.isMutating()).toBe(1)

      audit.resolve()
      flushMicrotasks()

      expect(onSettled).toHaveBeenCalled()
      expect(client.isMutating()).toBe(0)
      expect(client.getMutationCache().getAll().length).toBe(0)
      expect(m.isIdle()).toBe(true)
    }))

    it('lets a run finish its async onSuccess after the host is destroyed', fakeAsync(() => {
      const audit = deferred()
      const onSettled = jasmine.createSpy('onSettled')

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation<string, Error, void>(() => ({
          mutationFn: () => of('saved'),
          onSuccess: () => audit.promise,
          onSettled,
        }))
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate()
      fixture.destroy()

      expect(client.isMutating()).toBe(1)
      expect(onSettled).not.toHaveBeenCalled()

      audit.resolve()
      flushMicrotasks()

      expect(onSettled).toHaveBeenCalled()
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))

    it('still sends the write when reset() comes while an async onMutate runs', fakeAsync(() => {
      const snapshot = deferred()
      const sent: string[] = []
      const onSuccess = jasmine.createSpy('onSuccess')
      const m = setup(() => ({
        mutationFn: (title: string) => {
          sent.push(title)

          return of(title)
        },
        onMutate: () => snapshot.promise,
        onSuccess,
      }))

      m.mutate('b')
      m.reset()
      snapshot.resolve()
      flushMicrotasks()

      // reset() forgets the result; it doesn't call off the write.
      expect(sent).toEqual(['b'])
      expect(onSuccess).toHaveBeenCalled()
      expect(m.isIdle()).toBe(true)
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))
  })

  // A hook that fails doesn't change what happened to the write, and the
  // hooks after it still run. A failing onMutate stops the run before the
  // write is sent.
  describe('failing hooks', () => {
    it('fails the run without sending the write when onMutate throws', () => {
      const error = new Error('onMutate failed')
      const sent: string[] = []
      const onError = jasmine.createSpy('onError')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup(() => ({
        mutationFn: (title: string) => {
          sent.push(title)

          return of(title)
        },
        onMutate: () => {
          throw error
        },
        onError,
        onSettled,
      }))

      m.mutate('b')

      expect(sent).toEqual([])
      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(error)
      expect(onError).toHaveBeenCalledOnceWith(error, 'b', undefined)
      expect(onSettled).toHaveBeenCalledOnceWith(
        undefined,
        error,
        'b',
        undefined,
      )
    })

    it('fails the run without sending the write when an async onMutate rejects', fakeAsync(() => {
      const error = new Error('onMutate failed')
      const snapshot = deferred<{ previous: string[] }>()
      const sent: string[] = []
      const onError = jasmine.createSpy('onError')
      const m = setup<string, Error, string, { previous: string[] }>(() => ({
        mutationFn: (title: string) => {
          sent.push(title)

          return of(title)
        },
        onMutate: () => snapshot.promise,
        onError,
      }))

      m.mutate('b')
      snapshot.reject(error)
      flushMicrotasks()

      expect(sent).toEqual([])
      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(error)
      expect(onError).toHaveBeenCalledOnceWith(error, 'b', undefined)
    }))

    it('keeps the success when onSuccess throws, still runs onSettled and reports the error', fakeAsync(() => {
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw new Error('onSuccess failed')
        },
        onSettled,
      }))

      m.mutate()

      // The write went through; a broken hook doesn't undo that.
      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
      expect(onSettled).toHaveBeenCalledOnceWith(
        'saved',
        null,
        undefined,
        undefined,
      )
      // The error isn't swallowed: the app's error handling still sees it.
      expect(() => flush()).toThrowError(/onSuccess failed/)
    }))

    it('keeps the error when onError throws, still runs onSettled and reports the error', fakeAsync(() => {
      const error = new Error('write failed')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => error),
        onError: () => {
          throw new Error('rollback failed')
        },
        onSettled,
      }))

      m.mutate()

      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(error)
      expect(onSettled).toHaveBeenCalledOnceWith(
        undefined,
        error,
        undefined,
        undefined,
      )
      expect(() => flush()).toThrowError(/rollback failed/)
    }))

    it('keeps the success when an async onSuccess rejects, and reports the error', fakeAsync(() => {
      const audit = deferred()
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => audit.promise,
        onSettled,
      }))

      m.mutate()
      audit.reject(new Error('audit failed'))

      expect(() => flush()).toThrowError(/audit failed/)
      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
      expect(onSettled).toHaveBeenCalledOnceWith(
        'saved',
        null,
        undefined,
        undefined,
      )
    }))

    it('keeps the outcome when onSettled throws, and reports the error', fakeAsync(() => {
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSettled: () => {
          throw new Error('onSettled failed')
        },
      }))

      m.mutate()

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
      expect(() => flush()).toThrowError(/onSettled failed/)
    }))

    it('drops a forgotten run from the cache even when its hook throws', fakeAsync(() => {
      const response = new Subject<string>()
      const m = setup(() => ({
        mutationFn: () => response,
        onSuccess: () => {
          throw new Error('onSuccess failed')
        },
      }))

      m.mutate()
      m.reset()
      response.next('saved')
      response.complete()

      expect(() => flush()).toThrowError(/onSuccess failed/)
      expect(client.getMutationCache().getAll().length).toBe(0)
      expect(client.isMutating()).toBe(0)
    }))
  })

  describe('independent instances', () => {
    it('keeps separate state per mutation', () => {
      const a = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v),
      }))
      const b = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v * 10),
      }))

      a.mutate(1)
      b.mutate(2)

      expect(a.data()).toBe(1)
      expect(b.data()).toBe(20)
    })
  })

  describe('lifecycle', () => {
    it('does not touch the cache until the first mutate()', () => {
      const m = setup(() => ({ mutationFn: () => of(1) }))

      // Nothing has run, so there's nothing to observe or count.
      expect(client.getMutationCache().getAll().length).toBe(0)

      m.mutate()

      expect(client.getMutationCache().getAll().length).toBe(1)
    })

    it('removes a settled mutation from the cache when the host is destroyed', () => {
      @Component({ template: '' })
      class Host {
        readonly m = injectMutation(() => ({ mutationFn: () => of(1) }))
      }

      const fixture: ComponentFixture<Host> = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.m.mutate()

      expect(client.getMutationCache().getAll().length).toBe(1)

      fixture.destroy()

      expect(client.getMutationCache().getAll().length).toBe(0)
    })

    it('lets an in-flight mutation finish after the host is destroyed', fakeAsync(() => {
      const subject = new Subject<number>()
      const onSuccess = jasmine.createSpy('onSuccess')

      @Component({ template: '' })
      class Host {
        readonly m = injectMutation<number, Error, void>(() => ({
          mutationFn: () => subject,
          onSuccess,
        }))
      }

      const fixture: ComponentFixture<Host> = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.m.mutate()
      fixture.destroy()

      // The write is probably already on the server; cancelling would skip
      // onSuccess and leave the cache stale. So it runs to completion.
      subject.next(7)
      subject.complete()
      tick()

      expect(onSuccess).toHaveBeenCalledWith(7, undefined, undefined)
      // …and cleans itself out of the cache once it's done.
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))

    it('replaces settled runs in the cache rather than piling them up', () => {
      const m = setup(() => ({ mutationFn: () => of(1) }))

      m.mutate()
      m.mutate()
      m.mutate()

      expect(client.getMutationCache().getAll().length).toBe(1)
    })
  })

  describe('concurrent calls', () => {
    it('keeps the latest call as the result, even if an earlier one lands later', fakeAsync(() => {
      const slow = new Subject<string>()
      const fast = new Subject<string>()
      const sources = [slow, fast]

      const m = setup(() => ({
        mutationFn: (variables: string) =>
          sources[variables === 'slow' ? 0 : 1],
      }))

      m.mutate('slow')
      m.mutate('fast')

      // The later call is the one being tracked.
      expect(m.variables()).toBe('fast')

      fast.next('fast result')
      fast.complete()
      tick()

      expect(m.data()).toBe('fast result')

      // The superseded run finishes afterwards. It must not hijack the state.
      slow.next('slow result')
      slow.complete()
      tick()

      expect(m.data()).toBe('fast result')
      expect(m.variables()).toBe('fast')
    }))

    it('does not cancel the earlier call, and still runs its hooks', fakeAsync(() => {
      const slow = new Subject<string>()
      const fast = new Subject<string>()
      const sources = [slow, fast]
      const onSuccess = jasmine.createSpy('onSuccess')

      const m = setup(() => ({
        mutationFn: (variables: string) =>
          sources[variables === 'slow' ? 0 : 1],
        onSuccess,
      }))

      m.mutate('slow')
      m.mutate('fast')

      fast.next('fast result')
      fast.complete()
      slow.next('slow result')
      slow.complete()
      tick()

      // Both writes happened, so both get their side effects.
      expect(onSuccess).toHaveBeenCalledTimes(2)
      expect(onSuccess).toHaveBeenCalledWith('fast result', 'fast', undefined)
      expect(onSuccess).toHaveBeenCalledWith('slow result', 'slow', undefined)
    }))
  })

  describe('options', () => {
    it('re-reads the options on every mutate()', () => {
      const first = jasmine.createSpy('first').and.returnValue(of(1))
      const second = jasmine.createSpy('second').and.returnValue(of(2))
      let currentFn = first

      const m = setup<number, Error, void>(() => ({
        mutationFn: () => currentFn(),
      }))

      m.mutate()

      expect(first).toHaveBeenCalledTimes(1)

      currentFn = second
      m.mutate()

      expect(second).toHaveBeenCalledTimes(1)
      expect(m.data()).toBe(2)
    })
  })

  // withDefaultOptions({ mutations }) fills in what a mutation leaves unset,
  // field by field. Its hooks run in the injection context of the injector
  // that provides the client.
  describe('default options', () => {
    const REPORTS = new InjectionToken<unknown[]>('REPORTS')

    // Provides a client with these defaults, and a list the default hooks can
    // report to through inject(REPORTS). Returns that list.
    function provideDefaults(defaultOptions: DefaultOptions): unknown[] {
      const reports: unknown[] = []

      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(withDefaultOptions(defaultOptions)),
          { provide: REPORTS, useValue: reports },
        ],
      })

      return reports
    }

    it('runs the default onError and onSettled when the mutation has none, with its variables and context', () => {
      const error = new Error('boom')
      const onError = jasmine.createSpy('onError')
      const onSettled = jasmine.createSpy('onSettled')

      provideDefaults({ mutations: { onError, onSettled } })

      const m = setup<string, Error, string, { previous: string[] }>(() => ({
        mutationFn: () => throwError(() => error),
        onMutate: () => ({ previous: ['a'] }),
      }))

      m.mutate('b')

      expect(onError).toHaveBeenCalledOnceWith(error, 'b', { previous: ['a'] })
      expect(onSettled).toHaveBeenCalledOnceWith(undefined, error, 'b', {
        previous: ['a'],
      })
    })

    it('runs the default onSuccess and onSettled when the mutation has none', () => {
      const onSuccess = jasmine.createSpy('onSuccess')
      const onSettled = jasmine.createSpy('onSettled')

      provideDefaults({ mutations: { onSuccess, onSettled } })

      const m = setup(() => ({
        mutationFn: (title: string) => of(`${title} saved`),
      }))

      m.mutate('b')

      expect(onSuccess).toHaveBeenCalledOnceWith('b saved', 'b', undefined)
      expect(onSettled).toHaveBeenCalledOnceWith(
        'b saved',
        null,
        'b',
        undefined,
      )
    })

    it("replaces a default hook with the mutation's own", () => {
      const defaultOnError = jasmine.createSpy('default onError')
      const onError = jasmine.createSpy('onError')

      provideDefaults({ mutations: { onError: defaultOnError } })

      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => new Error('boom')),
        // Handles the error itself, e.g. rolls back an optimistic update.
        onError,
      }))

      m.mutate()

      expect(onError).toHaveBeenCalledTimes(1)
      expect(defaultOnError).not.toHaveBeenCalled()
    })

    it("replaces hooks one by one: the mutation's own onSuccess keeps the default onError", () => {
      const error = new Error('boom')
      const defaultOnError = jasmine.createSpy('default onError')

      provideDefaults({ mutations: { onError: defaultOnError } })

      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => error),
        onSuccess: jasmine.createSpy('onSuccess'),
      }))

      m.mutate()

      expect(defaultOnError).toHaveBeenCalledOnceWith(
        error,
        undefined,
        undefined,
      )
    })

    it('treats a hook set to undefined as not set', () => {
      const defaultOnError = jasmine.createSpy('default onError')

      provideDefaults({ mutations: { onError: defaultOnError } })

      // A shared definition that passes an optional hook on, used here
      // without one.
      const saveTodo = (onError?: (error: Error) => void) =>
        mutationOptions({
          mutationFn: () => throwError(() => new Error('boom')),
          onError,
        })
      const m = setup(() => saveTodo())

      m.mutate()

      expect(defaultOnError).toHaveBeenCalledTimes(1)
    })

    it('stays pending until an async default hook resolves', fakeAsync(() => {
      const report = deferred()

      provideDefaults({ mutations: { onSuccess: () => report.promise } })

      const m = setup(() => ({ mutationFn: () => of('saved') }))

      m.mutate()
      flushMicrotasks()

      expect(m.isPending()).toBe(true)

      report.resolve()
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
    }))

    it('retries with the default retry and retryDelay', fakeAsync(() => {
      let attempts = 0

      provideDefaults({ mutations: { retry: 1, retryDelay: 50 } })

      const m = setup(() => ({
        mutationFn: () => {
          attempts++

          return throwError(() => new Error('fail'))
        },
      }))

      m.mutate()
      tick(49)

      expect(attempts).toBe(1)

      tick(1)

      expect(attempts).toBe(2)
      expect(m.isError()).toBe(true)
    }))

    it("lets the mutation's own retry override the default, 0 included", fakeAsync(() => {
      let attempts = 0

      provideDefaults({ mutations: { retry: 2, retryDelay: 10 } })

      const m = setup(() => ({
        mutationFn: () => {
          attempts++

          return throwError(() => new Error('fail'))
        },
        // This write isn't safe to send twice.
        retry: 0,
      }))

      m.mutate()
      tick(100)

      expect(attempts).toBe(1)
      expect(m.isError()).toBe(true)
    }))

    it('ignores the query defaults', fakeAsync(() => {
      let attempts = 0

      provideDefaults({ queries: { retry: 3, retryDelay: 10 } })

      const m = setup(() => ({
        mutationFn: () => {
          attempts++

          return throwError(() => new Error('fail'))
        },
      }))

      m.mutate()
      tick(100)

      expect(attempts).toBe(1)
    }))

    it('runs each default hook in an injection context', fakeAsync(() => {
      const reports = provideDefaults({
        mutations: {
          onSuccess: () => inject(REPORTS).push('success'),
          onError: () => inject(REPORTS).push('error'),
          onSettled: () => inject(REPORTS).push('settled'),
        },
      })
      const save = setup(() => ({ mutationFn: () => of('saved') }))
      const remove = setup(() => ({
        mutationFn: () => throwError(() => new Error('boom')),
      }))

      save.mutate()
      remove.mutate()
      flush()

      expect(reports).toEqual(['success', 'settled', 'error', 'settled'])
    }))

    it('resolves inject() from the injector that provides the client, not the component that started the run', fakeAsync(() => {
      const response = new Subject<string>()
      const hostReports: unknown[] = []
      const reports = provideDefaults({
        mutations: { onSuccess: (saved) => inject(REPORTS).push(saved) },
      })

      @Component({
        template: '',
        providers: [{ provide: REPORTS, useValue: hostReports }],
      })
      class Host {
        readonly save = injectMutation(() => ({ mutationFn: () => response }))
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate()
      // The user leaves the page before the save lands.
      fixture.destroy()
      response.next('saved')
      response.complete()
      flush()

      expect(reports).toEqual(['saved'])
      expect(hostReports).toEqual([])
    }))

    it('skips the default hooks once that injector is destroyed', fakeAsync(() => {
      const response = new Subject<string>()
      const onSuccess = jasmine.createSpy('onSuccess')

      provideDefaults({ mutations: { onSuccess } })

      const m = setup(() => ({ mutationFn: () => response }))

      m.mutate()
      // The test ends, or the app is destroyed, while the save is in flight.
      TestBed.resetTestingModule()
      response.next('saved')
      response.complete()

      expect(() => flush()).not.toThrow()
      expect(onSuccess).not.toHaveBeenCalled()
      expect(m.isSuccess()).toBe(true)
    }))
  })

  // An effect that mutates or resets should depend only on what it reads
  // itself, not on what mutate() or reset() read to do their job.
  describe('called in an effect', () => {
    // Mounts a component whose effect saves `draft()` as it changes, as an
    // auto-save does. Stopped after 20 runs, so a loop fails the expectations
    // rather than change detection.
    function autoSave<TContext>(
      draft: Signal<string>,
      optionsFn: () => MutationOptions<string, Error, string, TContext>,
    ): ComponentFixture<unknown> {
      let runs = 0

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation(optionsFn)

        constructor() {
          effect(() => {
            runs++

            if (runs > 20) return

            this.save.mutate(draft())
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      return fixture
    }

    it('saves once per change with an optimistic update', () => {
      const draft = signal('a')
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.callFake((title: string) => of(title))

      client.setQueryData<string[]>(['todos'], [])

      const fixture = autoSave(draft, () => ({
        mutationFn,
        onMutate: (title) => {
          const prev = client.getQueryData<string[]>(['todos']) ?? []

          client.setQueryData(['todos'], [...prev, title])

          return { prev }
        },
      }))

      expect(mutationFn).toHaveBeenCalledTimes(1)

      draft.set('b')
      fixture.detectChanges()

      expect(mutationFn).toHaveBeenCalledTimes(2)
      expect(client.getQueryData(['todos'])).toEqual(['a', 'b'])
    })

    it("mutate() doesn't track what the options, onMutate or mutationFn read", () => {
      const draft = signal('a')
      const retries = signal(0)
      const locale = signal('en')
      const noteId = signal(1)
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.callFake((title: string) => of(`${noteId()}: ${title}`))

      const fixture = autoSave(draft, () => ({
        mutationFn,
        retry: retries(),
        onMutate: () => locale(),
      }))

      retries.set(1)
      locale.set('nl')
      noteId.set(2)
      fixture.detectChanges()

      // Only a new draft is a reason to save.
      expect(mutationFn).toHaveBeenCalledTimes(1)
    })

    it('saves each change once while an earlier save is in flight', () => {
      const draft = signal('a')
      const saves: Array<Subject<string>> = []
      const mutationFn = jasmine
        .createSpy<(title: string) => Subject<string>>('mutationFn')
        .and.callFake(() => {
          const save = new Subject<string>()

          saves.push(save)

          return save
        })
      const fixture = autoSave(draft, () => ({ mutationFn }))

      // Typed on before the first save landed, as fast typing does.
      draft.set('ab')
      fixture.detectChanges()

      // The first save lands while the second is in flight, then the second.
      for (const save of saves.slice(0, 2)) {
        save.next('saved')
        save.complete()
        fixture.detectChanges()
      }

      expect(mutationFn.calls.allArgs()).toEqual([['a'], ['ab']])
    })

    it("reset() doesn't re-run the effect when the forgotten save lands", () => {
      const open = signal(true)
      const response = new Subject<string>()
      let runs = 0

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation(() => ({ mutationFn: () => response }))

        constructor() {
          // Clears what the save left behind once the form closes.
          effect(() => {
            runs++

            if (!open()) this.save.reset()
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate()
      open.set(false)
      fixture.detectChanges()

      response.next('saved')
      response.complete()
      fixture.detectChanges()

      // Once on mount, once for the close.
      expect(runs).toBe(2)
    })
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      expect(() =>
        injectMutation(() => ({ mutationFn: () => of(1) })),
      ).toThrowError(/NG0203|injection context/)
    })

    it('works outside an injection context when given an injector', () => {
      const injector = TestBed.inject(Injector)
      const m = injectMutation<number, Error, number>(
        () => ({ mutationFn: (v) => of(v) }),
        { injector },
      )

      m.mutate(42)

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe(42)
    })
  })
})
