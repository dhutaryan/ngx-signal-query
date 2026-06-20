import { Component, Injector, signal } from '@angular/core'
import {
  type ComponentFixture,
  TestBed,
  fakeAsync,
  flush,
  tick,
} from '@angular/core/testing'
import { of, Subject, throwError } from 'rxjs'

import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { QueryOptions, QueryResult } from './types'

// Mounts injectQuery inside a host component so its effects are tied to a real
// view and flush on detectChanges(). Returns the result plus the fixture so a
// test can push new inputs (detectChanges) or unmount (destroy).
function mount<TData, TError = Error>(
  optionsFn: () => QueryOptions<TData, TError>,
): { fixture: ComponentFixture<unknown>; result: QueryResult<TData, TError> } {
  @Component({ template: '' })
  class Host {
    readonly result = injectQuery<TData, TError>(optionsFn)
  }

  const fixture = TestBed.createComponent(Host)

  fixture.detectChanges()

  return { fixture, result: fixture.componentInstance.result }
}

describe('injectQuery', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
  })

  it('resolves a synchronous queryFn to success', () => {
    const { result } = mount(() => ({
      queryKey: ['a'],
      queryFn: () => of(42),
    }))

    expect(result.status()).toBe('success')
    expect(result.data()).toBe(42)
    expect(result.isSuccess()).toBe(true)
    expect(result.isFetching()).toBe(false)
    expect(result.isLoading()).toBe(false)
  })

  it('exposes loading state while the first fetch is in flight', fakeAsync(() => {
    const subject = new Subject<number>()
    const { result } = mount(() => ({
      queryKey: ['a'],
      queryFn: () => subject,
    }))

    expect(result.isPending()).toBe(true)
    expect(result.isLoading()).toBe(true)
    expect(result.isFetching()).toBe(true)
    expect(result.data()).toBeUndefined()

    subject.next(1)
    subject.complete()
    tick()

    expect(result.isLoading()).toBe(false)
    expect(result.isSuccess()).toBe(true)
    expect(result.data()).toBe(1)
  }))

  it('surfaces errors', () => {
    const err = new Error('boom')
    const { result } = mount<number>(() => ({
      queryKey: ['a'],
      queryFn: () => throwError(() => err),
      retry: false,
    }))

    expect(result.status()).toBe('error')
    expect(result.isError()).toBe(true)
    expect(result.error()).toBe(err)
  })

  it('exposes failureCount and failureReason after retries', fakeAsync(() => {
    const err = new Error('nope')
    const { result } = mount<number>(() => ({
      queryKey: ['f'],
      queryFn: () => throwError(() => err),
      retry: 2,
      retryDelay: () => 10,
    }))

    tick(100)

    expect(result.isError()).toBe(true)
    expect(result.failureCount()).toBe(3) // retry: 2 -> 3 attempts
    expect(result.failureReason()).toBe(err)
  }))

  describe('enabled', () => {
    it('does not fetch while disabled', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { result } = mount(() => ({
        queryKey: ['e'],
        queryFn,
        enabled: false,
      }))

      expect(queryFn).not.toHaveBeenCalled()
      expect(result.isPending()).toBe(true)
      expect(result.data()).toBeUndefined()
    })

    it('fetches once it becomes enabled', () => {
      const enabled = signal(false)
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { fixture, result } = mount(() => ({
        queryKey: ['e'],
        queryFn,
        enabled: enabled(),
      }))

      expect(queryFn).not.toHaveBeenCalled()

      enabled.set(true)
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result.isSuccess()).toBe(true)
      expect(result.data()).toBe(1)
    })
  })

  describe('refetch / invalidate', () => {
    it('refetch() forces a fetch past staleTime', fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { result } = mount(() => ({
        queryKey: ['r'],
        queryFn,
        staleTime: Infinity,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)

      // refetch() forces staleTime: 0, so the cached data must read as stale —
      // advance the clock past the last updatedAt for that to hold.
      tick(1)
      result.refetch()

      expect(queryFn).toHaveBeenCalledTimes(2)
    }))

    it('refetches when the query is invalidated', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { fixture } = mount(() => ({
        queryKey: ['i'],
        queryFn,
        staleTime: Infinity,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)

      client.invalidateQueries({ queryKey: ['i'] })
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(2)
    })

    it('a data change alone does not re-trigger the fetch effect', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { fixture } = mount(() => ({
        queryKey: ['nl'],
        queryFn,
        staleTime: Infinity,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)

      // Writing data updates state but must not wake the fetch effect.
      client.setQueryData(['nl'], 99)
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('reactive query key', () => {
    it('switches to a new query when the key changes', () => {
      const id = signal(1)
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake(() => of(`v${id()}`))
      const { fixture, result } = mount(() => ({
        queryKey: ['item', id()],
        queryFn,
      }))

      expect(result.data()).toBe('v1')

      id.set(2)
      fixture.detectChanges()

      expect(result.data()).toBe('v2')
      // The previous query stays cached under its own key.
      expect(client.getQueryData(['item', 1])).toBe('v1')
    })

    it('re-points observers when the key changes', () => {
      const id = signal(1)
      const { fixture } = mount(() => ({
        queryKey: ['k', id()],
        queryFn: () => of(id()),
        staleTime: Infinity,
      }))

      const cache = client.getQueryCache()

      expect(cache.get(['k', 1])?.observerCount).toBe(1)

      id.set(2)
      fixture.detectChanges()

      expect(cache.get(['k', 1])?.observerCount).toBe(0)
      expect(cache.get(['k', 2])?.observerCount).toBe(1)
    })
  })

  describe('shared cache', () => {
    it('two observers of the same key share one fetch and one query', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('x'))
      const a = mount(() => ({
        queryKey: ['s'],
        queryFn,
        staleTime: Infinity,
      }))
      const b = mount(() => ({
        queryKey: ['s'],
        queryFn,
        staleTime: Infinity,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(a.result.data()).toBe('x')
      expect(b.result.data()).toBe('x')
      expect(client.getQueryCache().get(['s'])?.observerCount).toBe(2)
    })

    it('removes its observer when the host is destroyed', () => {
      const { fixture } = mount(() => ({
        queryKey: ['d'],
        queryFn: () => of(1),
        staleTime: Infinity,
      }))

      const query = client.getQueryCache().get(['d'])

      expect(query?.observerCount).toBe(1)

      fixture.destroy()

      expect(query?.observerCount).toBe(0)
    })
  })

  describe('initialData', () => {
    it('renders success immediately and skips fetch when fresh', () => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.returnValue(of('fetched'))
      const { result } = mount(() => ({
        queryKey: ['id'],
        queryFn,
        initialData: 'init',
        staleTime: Infinity,
      }))

      expect(result.status()).toBe('success')
      expect(result.data()).toBe('init')
      expect(queryFn).not.toHaveBeenCalled()
    })

    it('shows initialData while background-refetching stale data', fakeAsync(() => {
      const subject = new Subject<string>()
      const { result } = mount(() => ({
        queryKey: ['id2'],
        queryFn: () => subject,
        initialData: 'init',
      }))

      // updatedAt defaults to 0 → stale → background refetch, but data shows.
      expect(result.isSuccess()).toBe(true)
      expect(result.data()).toBe('init')
      expect(result.isFetching()).toBe(true)
      expect(result.isLoading()).toBe(false)

      subject.next('fresh')
      subject.complete()
      tick()

      expect(result.data()).toBe('fresh')
    }))
  })

  describe('refetchInterval (polling)', () => {
    it('refetches on the interval and stops on destroy', fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { fixture } = mount(() => ({
        queryKey: ['p'],
        queryFn,
        refetchInterval: 100,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1) // initial fetch

      tick(100)
      expect(queryFn).toHaveBeenCalledTimes(2)

      tick(100)
      expect(queryFn).toHaveBeenCalledTimes(3)

      fixture.destroy()
      tick(300)
      expect(queryFn).toHaveBeenCalledTimes(3) // interval cleared
      flush()
    }))

    it('stops polling when the interval function returns false', fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      mount(() => ({
        queryKey: ['pf'],
        queryFn,
        // Once the query has data, stop polling.
        refetchInterval: ({ state }) =>
          state.status === 'success' ? false : 100,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)

      tick(500)
      expect(queryFn).toHaveBeenCalledTimes(1)
      flush()
    }))
  })

  describe('cancelRefetch', () => {
    it('invalidate cancels an in-flight fetch and starts a fresh one', fakeAsync(() => {
      const subjects = [new Subject<string>(), new Subject<string>()]
      let call = 0
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake(() => subjects[call++])

      const { fixture, result } = mount<string>(() => ({
        queryKey: ['c'],
        queryFn,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result.isFetching()).toBe(true)

      client.invalidateQueries({ queryKey: ['c'] })
      fixture.detectChanges()

      // The first fetch was cancelled; a second one is now in flight.
      expect(queryFn).toHaveBeenCalledTimes(2)

      // Late emission from the cancelled fetch is ignored.
      subjects[0].next('stale')
      subjects[0].complete()
      subjects[1].next('fresh')
      subjects[1].complete()
      tick()

      expect(result.data()).toBe('fresh')
    }))
  })

  describe('dependent queries', () => {
    it('runs the dependent query only after the first resolves', fakeAsync(() => {
      const userId = new Subject<number>()
      const userFn = jasmine.createSpy('userFn').and.returnValue(userId)
      const postsFn = jasmine
        .createSpy('postsFn')
        .and.callFake(() => of(['post']))

      @Component({ template: '' })
      class Host {
        readonly user = injectQuery<number>(() => ({
          queryKey: ['user'],
          queryFn: userFn,
        }))

        readonly posts = injectQuery<string[]>(() => ({
          queryKey: ['posts', this.user.data()],
          queryFn: postsFn,
          enabled: this.user.data() !== undefined,
        }))
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      // First query in flight, dependent one is still gated off.
      expect(postsFn).not.toHaveBeenCalled()
      expect(fixture.componentInstance.posts.isPending()).toBe(true)

      userId.next(1)
      userId.complete()
      tick()
      fixture.detectChanges()

      expect(postsFn).toHaveBeenCalledTimes(1)
      expect(fixture.componentInstance.posts.data()).toEqual(['post'])
    }))
  })

  describe('refetch uses live options', () => {
    it('reads the current queryKey signal at refetch time', () => {
      const id = signal(1)
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake(() => of(`v${id()}`))
      const { result } = mount(() => ({
        queryKey: ['item', id()],
        queryFn,
        staleTime: Infinity,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)

      // Change the key but do NOT run change detection: refetch must still
      // target the current signal value, not the observed (stale) query.
      id.set(2)
      result.refetch()

      expect(client.getQueryData(['item', 2])).toBe('v2')
    })
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      expect(() =>
        injectQuery(() => ({ queryKey: ['x'], queryFn: () => of(1) })),
      ).toThrowError(/NG0203|injection context/)
    })

    it('works outside an injection context when given an injector', () => {
      const injector = TestBed.inject(Injector)
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(7))

      const result = injectQuery(
        () => ({ queryKey: ['inj'], queryFn, staleTime: Infinity }),
        { injector },
      )

      // Effects are tied to the environment injector; flush them explicitly.
      TestBed.tick()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result.isSuccess()).toBe(true)
      expect(result.data()).toBe(7)
    })
  })
})
