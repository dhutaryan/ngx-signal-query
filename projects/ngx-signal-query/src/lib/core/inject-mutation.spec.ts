import { Component, Injector } from '@angular/core'
import {
  type ComponentFixture,
  TestBed,
  fakeAsync,
  tick,
} from '@angular/core/testing'
import { EMPTY, of, Subject, throwError } from 'rxjs'

import { injectMutation } from './inject-mutation'
import type { MutationOptions, MutationResult } from './mutation'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

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
