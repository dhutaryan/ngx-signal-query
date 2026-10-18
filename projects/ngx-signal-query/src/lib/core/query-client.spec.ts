import { Component, PLATFORM_ID, effect, signal } from '@angular/core'
import {
  type ComponentFixture,
  fakeAsync,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing'
import { of, Subject, throwError } from 'rxjs'

import { settled } from '../../spec-helpers/promises'
import { withDefaultOptions } from '../features/with-default-options'
import { CancelledError } from './cancelled-error'
import { injectMutation } from './inject-mutation'
import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import { deferred } from './utils'

// Runs `body` in an effect of a mounted component, the way an app calls the
// client from one. Returns the fixture (detectChanges() flushes the effect
// after a change) and how many times the effect has run. An effect that keeps
// re-running itself is stopped after 20 runs, so a spec fails on its
// expectations rather than on change detection giving up (NG0103).
function inEffect(body: () => void): {
  fixture: ComponentFixture<unknown>
  runs: () => number
} {
  let runs = 0

  @Component({ template: '' })
  class Host {
    constructor() {
      effect(() => {
        runs++

        if (runs > 20) return

        body()
      })
    }
  }

  const fixture = TestBed.createComponent(Host)

  fixture.detectChanges()

  return { fixture, runs: () => runs }
}

describe('QueryClient', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideQueryClient()],
    })
    client = TestBed.inject(QueryClient)
  })

  describe('defaultQueryOptions', () => {
    it('applies built-in defaults', () => {
      const defaulted = client.defaultQueryOptions({
        queryKey: ['a'],
        queryFn: () => of(1),
      })

      expect(defaulted.staleTime).toBe(0)
      expect(defaulted.gcTime).toBe(5 * 60_000)
      expect(defaulted.retry).toBe(3)
      expect(typeof defaulted.retryDelay).toBe('function')
      expect(defaulted.refetchOnWindowFocus).toBe(true)
      expect(defaulted.refetchOnReconnect).toBe(true)
    })

    it('keeps explicitly provided options', () => {
      const defaulted = client.defaultQueryOptions({
        queryKey: ['a'],
        queryFn: () => of(1),
        staleTime: 5000,
        gcTime: 1000,
        retry: 1,
        refetchOnWindowFocus: 'always',
        refetchOnReconnect: false,
      })

      expect(defaulted.staleTime).toBe(5000)
      expect(defaulted.gcTime).toBe(1000)
      expect(defaulted.retry).toBe(1)
      expect(defaulted.refetchOnWindowFocus).toBe('always')
      expect(defaulted.refetchOnReconnect).toBe(false)
    })

    describe('on the server', () => {
      beforeEach(() => {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
          providers: [
            provideQueryClient(
              withDefaultOptions({ queries: { gcTime: 60_000 } }),
            ),
            { provide: PLATFORM_ID, useValue: 'server' },
          ],
        })
        client = TestBed.inject(QueryClient)
      })

      it('gives every query gcTime Infinity, whatever the query or the app asks for', () => {
        const asked = client.defaultQueryOptions({
          queryKey: ['a'],
          queryFn: () => of(1),
          gcTime: 1000,
        })
        const configured = client.defaultQueryOptions({
          queryKey: ['b'],
          queryFn: () => of(1),
        })

        expect(asked.gcTime).toBe(Infinity)
        expect(configured.gcTime).toBe(Infinity)
      })
    })
  })

  describe('with configured default options', () => {
    beforeEach(() => {
      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(
            withDefaultOptions({
              queries: {
                staleTime: 1234,
                gcTime: 60_000,
                retry: 5,
                retryDelay: 100,
                refetchOnWindowFocus: false,
                refetchOnReconnect: false,
              },
            }),
          ),
        ],
      })
      client = TestBed.inject(QueryClient)
    })

    it('falls back to the configured defaults', () => {
      const defaulted = client.defaultQueryOptions({
        queryKey: ['a'],
        queryFn: () => of(1),
      })

      expect(defaulted.staleTime).toBe(1234)
      expect(defaulted.gcTime).toBe(60_000)
      expect(defaulted.retry).toBe(5)
      expect(defaulted.refetchOnWindowFocus).toBe(false)
      expect(defaulted.refetchOnReconnect).toBe(false)
    })

    it('lets per-query options override the configured defaults', () => {
      const defaulted = client.defaultQueryOptions({
        queryKey: ['a'],
        queryFn: () => of(1),
        staleTime: 0,
        gcTime: 1000,
        refetchOnWindowFocus: 'always',
      })

      expect(defaulted.staleTime).toBe(0)
      expect(defaulted.gcTime).toBe(1000)
      expect(defaulted.retry).toBe(5)
      expect(defaulted.refetchOnWindowFocus).toBe('always')
      expect(defaulted.refetchOnReconnect).toBe(false)
    })

    it('applies the configured staleTime in fetchQuery', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      client.fetchQuery(['n'], queryFn)
      client.fetchQuery(['n'], queryFn)

      // staleTime 1234 keeps the data fresh, so no second fetch.
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('applies the configured retry and retryDelay in fetchQuery', fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []

      client.fetchQuery(['n'], () => {
        sent.push(Date.now() - start)

        return throwError(() => new Error('down'))
      })
      tick(1_000)

      // The first try, then 5 retries 100 ms apart.
      expect(sent).toEqual([0, 100, 200, 300, 400, 500])
    }))
  })

  describe('setQueryData / getQueryData', () => {
    it('round-trips data through the cache', () => {
      expect(client.getQueryData(['user', 1])).toBeUndefined()

      client.setQueryData(['user', 1], { name: 'Ann' })

      expect(client.getQueryData(['user', 1])).toEqual({ name: 'Ann' })
    })

    it('updates with a function receiving the previous value', () => {
      client.setQueryData<number[]>(['list'], [1, 2])
      client.setQueryData<number[]>(['list'], (prev) => [...(prev ?? []), 3])

      expect(client.getQueryData(['list'])).toEqual([1, 2, 3])
    })

    it('passes undefined to the updater when no data exists yet', () => {
      client.setQueryData<number[]>(['list'], (prev) => [...(prev ?? []), 1])

      expect(client.getQueryData(['list'])).toEqual([1])
    })

    it('is a no-op when the updater returns undefined', () => {
      client.setQueryData<number>(['n'], 5)
      client.setQueryData<number>(['n'], () => undefined as unknown as number)

      expect(client.getQueryData(['n'])).toBe(5)
    })

    // JSON data can have a field named `constructor`, e.g. a filter of cars
    // by the team that builds them, null while none is picked.
    it('accepts a key whose object has a null constructor field', () => {
      client.setQueryData(['cars', { constructor: null, year: 2024 }], 1)

      expect(
        client.getQueryData(['cars', { constructor: null, year: 2024 }]),
      ).toBe(1)
    })

    it('ignores property order in an object with a constructor field', () => {
      client.setQueryData(['cars', { constructor: 'ferrari', year: 2024 }], 1)

      expect(
        client.getQueryData(['cars', { year: 2024, constructor: 'ferrari' }]),
      ).toBe(1)
    })
  })

  describe('fetchQuery', () => {
    it('populates the cache from the queryFn', () => {
      client.fetchQuery(['n'], () => of(10))
      expect(client.getQueryData(['n'])).toBe(10)
    })

    it('does not refetch fresh data within staleTime', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      client.fetchQuery(['n'], queryFn, { staleTime: Infinity })
      client.fetchQuery(['n'], queryFn, { staleTime: Infinity })

      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('dedupes an in-flight fetch without cancelRefetch', () => {
      const first = jasmine
        .createSpy('first')
        .and.returnValue(new Promise<number>(() => {})) // never resolves
      const second = jasmine.createSpy('second')

      client.fetchQuery(['n'], first)
      client.fetchQuery(['n'], second, { staleTime: 0 })

      expect(second).not.toHaveBeenCalled()
    })

    it('cancelRefetch restarts an in-flight fetch with a fresh queryFn', fakeAsync(() => {
      const first = jasmine
        .createSpy('first')
        .and.returnValue(new Promise<number>(() => {})) // never resolves
      const second = jasmine
        .createSpy('second')
        .and.returnValue(Promise.resolve(2))

      client.fetchQuery(['n'], first)
      client.fetchQuery(['n'], second, { staleTime: 0, cancelRefetch: true })
      tick()

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['n'])).toBe(2)
    }))

    it("doesn't retry a failing fetch unless asked", fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []

      client.fetchQuery(['n'], () => {
        sent.push(Date.now() - start)

        return throwError(() => new Error('down'))
      })
      tick(60_000)

      // Whoever waits for the data hears of the failure at once.
      expect(sent).toEqual([0])
    }))

    it('retries a failing fetch as the call asks', fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []

      client.fetchQuery(
        ['n'],
        () => {
          sent.push(Date.now() - start)

          return throwError(() => new Error('down'))
        },
        { retry: 2, retryDelay: 10 },
      )
      tick(1_000)

      expect(sent).toEqual([0, 10, 20])
    }))

    it('keeps the cached data when the fetch brings the same data', () => {
      client.setQueryData(['n'], { id: 1, tags: ['a'] })

      const cached = client.getQueryData(['n'])

      client.fetchQuery(['n'], () => of({ id: 1, tags: ['a'] }))

      expect(client.getQueryData(['n'])).toBe(cached)
    })

    // The promise it returns: the data as the cache holds it.
    describe('promise', () => {
      it('resolves with the fetched data', fakeAsync(() => {
        const result = settled(client.fetchQuery(['n'], () => of(10)))

        flushMicrotasks()

        expect(result.value).toBe(10)
      }))

      it('resolves with the cached data, without a request, while it is fresh', fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(2))

        client.setQueryData(['n'], 1)

        const result = settled(
          client.fetchQuery(['n'], queryFn, { staleTime: Infinity }),
        )

        flushMicrotasks()

        expect(result.value).toBe(1)
        expect(queryFn).not.toHaveBeenCalled()
      }))

      it('waits for the fetch in flight and resolves with its data', fakeAsync(() => {
        const response = new Subject<number>()
        const second = jasmine.createSpy('second')

        client.fetchQuery(['n'], () => response)

        const result = settled(client.fetchQuery(['n'], second))

        flushMicrotasks()
        expect(result).toEqual({})

        response.next(1)
        flushMicrotasks()

        expect(result.value).toBe(1)
        expect(second).not.toHaveBeenCalled()
      }))

      it('resolves with the response of a request the component that started it left', fakeAsync(() => {
        const response = deferred<string>()

        @Component({ template: '' })
        class TodoList {
          readonly todos = injectQuery(() => ({
            queryKey: ['todos'],
            queryFn: () => response.promise,
          }))
        }

        const fixture = TestBed.createComponent(TodoList)

        fixture.detectChanges()

        // A route resolver waits for the list that the page it navigates
        // away from started loading.
        const result = settled(
          client.fetchQuery(['todos'], () => response.promise),
        )

        fixture.destroy()
        response.resolve('a')
        flushMicrotasks()

        expect(result.value).toBe('a')
      }))

      it('resolves with the data as the cache keeps it', fakeAsync(() => {
        client.setQueryData(['n'], { id: 1, tags: ['a'] })

        const cached = client.getQueryData<{ id: number; tags: string[] }>([
          'n',
        ])
        const result = settled(
          client.fetchQuery(['n'], () => of({ id: 1, tags: ['a'] })),
        )

        flushMicrotasks()

        // The response brought the same data, so the cache kept its object,
        // and the promise resolves with that object.
        expect(result.value).toBe(cached)
      }))

      it('rejects with the error of the fetch', fakeAsync(() => {
        const error = new Error('down')
        const result = settled(
          client.fetchQuery(['n'], () => throwError(() => error)),
        )

        flushMicrotasks()

        expect(result.error).toBe(error)
      }))

      it('resolves with the cached data when the fetch is cancelled', fakeAsync(() => {
        client.setQueryData(['n'], 1)

        const result = settled(
          client.fetchQuery(['n'], () => new Subject<number>()),
        )

        client.cancelQueries()
        flushMicrotasks()

        expect(result.value).toBe(1)
      }))

      it('rejects with a CancelledError when the fetch is cancelled before there is data', fakeAsync(() => {
        const result = settled(
          client.fetchQuery(['n'], () => new Subject<number>()),
        )

        client.cancelQueries()
        flushMicrotasks()

        expect(result.error).toBeInstanceOf(CancelledError)
      }))

      it('rejects with a CancelledError once the query is removed, even with data', fakeAsync(() => {
        client.setQueryData(['n'], 1)

        const result = settled(
          client.fetchQuery(['n'], () => new Subject<number>()),
        )

        // E.g. signing out while a refresh is in flight.
        client.removeQueries()
        flushMicrotasks()

        expect(result.error).toBeInstanceOf(CancelledError)
      }))

      it("doesn't surface a failure nobody waits for as an unhandled rejection", fakeAsync(() => {
        // A prefetch that fails: only the query's state tells.
        client.fetchQuery(['n'], () => throwError(() => new Error('down')))

        // fakeAsync rethrows an unhandled rejection when microtasks run.
        expect(() => flushMicrotasks()).not.toThrow()
        expect(client.getQueryCache().get(['n'])?.state().status).toBe('error')
      }))
    })
  })

  describe('invalidateQueries', () => {
    it('marks matching queries as invalidated', () => {
      client.setQueryData(['todos', 1], 'a')
      client.setQueryData(['todos', 2], 'b')
      client.setQueryData(['other'], 'c')

      client.invalidateQueries({ queryKey: ['todos'] })

      const cache = client.getQueryCache()

      expect(cache.get(['todos', 1])?.state().isInvalidated).toBe(true)
      expect(cache.get(['todos', 2])?.state().isInvalidated).toBe(true)
      expect(cache.get(['other'])?.state().isInvalidated).toBe(false)
    })

    it('invalidates every query when no filter is given', () => {
      client.setQueryData(['todos', 1], 'a')
      client.setQueryData(['other'], 'c')

      client.invalidateQueries()

      const cache = client.getQueryCache()

      expect(cache.get(['todos', 1])?.state().isInvalidated).toBe(true)
      expect(cache.get(['other'])?.state().isInvalidated).toBe(true)
    })

    it('matches only the exact key with exact: true', () => {
      client.setQueryData(['todos'], 'a')
      client.setQueryData(['todos', 1], 'b')

      client.invalidateQueries({ queryKey: ['todos'], exact: true })

      const cache = client.getQueryCache()

      expect(cache.get(['todos'])?.state().isInvalidated).toBe(true)
      expect(cache.get(['todos', 1])?.state().isInvalidated).toBe(false)
    })
  })

  describe('cancelQueries', () => {
    it('cancels in-flight queries matching the filter', () => {
      client.fetchQuery(['todos', 1], () => new Promise<number>(() => {}))
      client.fetchQuery(['other'], () => new Promise<number>(() => {}))
      expect(client.isFetching()).toBe(2)

      client.cancelQueries({ queryKey: ['todos'] })

      expect(client.isFetching()).toBe(1)
      expect(client.isFetching({ queryKey: ['other'] })).toBe(1)
    })

    it('cancels all in-flight queries with no filter', () => {
      client.fetchQuery(['a'], () => new Promise<number>(() => {}))
      client.fetchQuery(['b'], () => new Promise<number>(() => {}))

      client.cancelQueries()

      expect(client.isFetching()).toBe(0)
    })

    it('puts back the failure count and reason the fetch it stops had changed', fakeAsync(() => {
      const error = new Error('down')

      client.setQueryData(['todos'], 'a')
      client.fetchQuery(['todos'], () => throwError(() => error), {
        retry: 1,
        retryDelay: 100,
      })

      const query = client.getQueryCache().get(['todos'])!

      // The first attempt failed, and the retry is waiting.
      expect(query.state().failureCount).toBe(1)

      client.cancelQueries({ queryKey: ['todos'] })

      expect(query.state()).toEqual(
        jasmine.objectContaining({
          status: 'success',
          data: 'a',
          failureCount: 0,
          failureReason: null,
          isFetching: false,
        }),
      )
    }))

    it('keeps the stale mark an invalidation set during the fetch it stops', fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('fresh'))

      // A prefetch of a key nobody shows is in flight when a change marks the
      // key stale.
      client.setQueryData(['todos'], 'old')
      client.fetchQuery(['todos'], () => new Subject<string>())
      client.invalidateQueries({ queryKey: ['todos'] })
      client.cancelQueries({ queryKey: ['todos'] })
      flushMicrotasks()

      @Component({ template: '' })
      class TodoList {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn,
          staleTime: Infinity,
        }))
      }

      TestBed.createComponent(TodoList).detectChanges()

      // Still stale, so even a component that keeps data fresh for long
      // fetches it.
      expect(queryFn).toHaveBeenCalledTimes(1)
    }))
  })

  describe('removeQueries', () => {
    it('removes matching queries from the cache', () => {
      client.setQueryData(['todos', 1], 'a')
      client.setQueryData(['todos', 2], 'b')
      client.setQueryData(['other'], 'c')

      client.removeQueries({ queryKey: ['todos'] })

      const cache = client.getQueryCache()

      expect(cache.get(['todos', 1])).toBeUndefined()
      expect(cache.get(['todos', 2])).toBeUndefined()
      expect(cache.get(['other'])).toBeDefined()
    })

    it('removes everything with no filter', () => {
      client.setQueryData(['a'], 1)
      client.setQueryData(['b'], 2)

      client.removeQueries()

      expect(client.getQueryCache().getAll().length).toBe(0)
    })

    // e.g. a list keyed by a status the user hasn't picked yet
    it("doesn't remove a shorter key with a filter that ends in undefined", () => {
      client.setQueryData(['todos'], 'all')
      client.setQueryData(['todos', undefined], 'no status')

      client.removeQueries({ queryKey: ['todos', undefined] })

      const cache = client.getQueryCache()

      expect(cache.get(['todos'])).toBeDefined()
      expect(cache.get(['todos', undefined])).toBeUndefined()
    })
  })

  // A query nobody shows, from a prefetch or written by hand, is removed once
  // it has gone unused for gcTime. A fetch in flight counts as use.
  describe('garbage collection', () => {
    it('removes a prefetched query nobody shows gcTime after its fetch lands', fakeAsync(() => {
      const response = new Subject<string>()

      client.fetchQuery(['todos'], () => response)
      tick(60_000)
      response.next('v1')
      response.complete()

      tick(5 * 60_000 - 1)
      expect(client.getQueryData(['todos'])).toBe('v1')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it("doesn't remove a query while it fetches, and removes it gcTime after the fetch lands", fakeAsync(() => {
      const response = new Subject<string>()

      client.setQueryData(['todos'], 'v1')
      tick(5 * 60_000 - 1000)
      client.fetchQuery(['todos'], () => response)
      tick(1000)

      expect(client.getQueryData(['todos'])).toBe('v1')

      response.next('v2')
      response.complete()

      expect(client.getQueryData(['todos'])).toBe('v2')

      tick(5 * 60_000 - 1)
      expect(client.getQueryData(['todos'])).toBe('v2')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it('keeps data written into a query nobody shows for gcTime after the last write', fakeAsync(() => {
      client.setQueryData(['todos'], 'v1')
      tick(4 * 60_000)
      client.setQueryData(['todos'], 'v2')

      tick(5 * 60_000 - 1)
      expect(client.getQueryData(['todos'])).toBe('v2')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it("doesn't put off removing queries cancelQueries finds nothing to cancel in", fakeAsync(() => {
      client.setQueryData(['todos'], 'v1')
      tick(3 * 60_000)
      client.cancelQueries()
      tick(2 * 60_000)

      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    describe('with a configured gcTime', () => {
      beforeEach(() => {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
          providers: [
            provideQueryClient(
              withDefaultOptions({ queries: { gcTime: 1000 } }),
            ),
          ],
        })
        client = TestBed.inject(QueryClient)
      })

      it('removes data written into the cache by hand after it', fakeAsync(() => {
        client.setQueryData(['todos'], 'v1')

        tick(999)
        expect(client.getQueryData(['todos'])).toBe('v1')

        tick(1)
        expect(client.getQueryData(['todos'])).toBeUndefined()
      }))

      it('removes a prefetched query nobody shows after it', fakeAsync(() => {
        client.fetchQuery(['todos'], () => of('v1'))

        tick(999)
        expect(client.getQueryData(['todos'])).toBe('v1')

        tick(1)
        expect(client.getQueryData(['todos'])).toBeUndefined()
      }))

      it('removes a prefetch it cancels that long after the cancel', fakeAsync(() => {
        // The prefetch is slow: it's still in flight when gcTime first runs
        // out.
        client.fetchQuery(['todos'], () => new Subject<string>())
        tick(2000)
        client.cancelQueries({ queryKey: ['todos'] })

        tick(999)
        expect(client.getQueryCache().get(['todos'])).toBeDefined()

        tick(1)
        expect(client.getQueryCache().get(['todos'])).toBeUndefined()
      }))
    })
  })

  describe('isFetching', () => {
    it('returns 0 when nothing is fetching', () => {
      expect(client.isFetching()).toBe(0)
    })

    it('counts queries currently in flight', () => {
      // A promise that never settles keeps the query in the fetching state.
      client.fetchQuery(['n'], () => new Promise<number>(() => {}))

      expect(client.isFetching()).toBe(1)
      expect(client.isFetching({ queryKey: ['other'] })).toBe(0)
    })
  })

  // An effect that calls the client should depend only on what it reads
  // itself. What the call reads to do its job, the cache or a query's state,
  // mustn't become a dependency of the effect, or the call repeats whenever
  // that changes.
  describe('called in an effect', () => {
    it('fetchQuery prefetches the next page once, not once per response', () => {
      const page = signal(1)
      const responses: Array<Subject<string>> = []
      const fetchPage = jasmine
        .createSpy<(page: number) => Subject<string>>('fetchPage')
        .and.callFake(() => {
          const response = new Subject<string>()

          responses.push(response)

          return response
        })
      const { fixture } = inEffect(() => {
        const next = page() + 1

        client.fetchQuery(['todos', next], () => fetchPage(next))
      })

      // Answer the latest request, three times over: an answer mustn't send
      // the request again.
      for (let i = 0; i < 3; i++) {
        responses.at(-1)?.next('page')
        responses.at(-1)?.complete()
        fixture.detectChanges()
      }

      expect(fetchPage.calls.allArgs()).toEqual([[2]])

      page.set(2)
      fixture.detectChanges()

      expect(fetchPage.calls.allArgs()).toEqual([[2], [3]])
    })

    it("fetchQuery doesn't make the effect depend on the query or on what queryFn reads", () => {
      const version = signal(1)
      const { fixture, runs } = inEffect(() =>
        client.fetchQuery(['todos'], () => of(version()), {
          staleTime: Infinity,
        }),
      )

      // The call itself updated the query: fetching, then success.
      expect(runs()).toBe(1)

      version.set(2)
      fixture.detectChanges()

      expect(runs()).toBe(1)
    })

    it("setQueryData runs an updater once, and doesn't track what it reads", () => {
      const step = signal(1)
      const { fixture, runs } = inEffect(() =>
        client.setQueryData<number>(['count'], (count = 0) => count + step()),
      )

      expect(runs()).toBe(1)
      expect(client.getQueryData(['count'])).toBe(1)

      step.set(2)
      fixture.detectChanges()

      expect(runs()).toBe(1)
      expect(client.getQueryData(['count'])).toBe(1)
    })

    it("getQueryData doesn't re-run the effect when the data changes", () => {
      const seen: unknown[] = []

      client.setQueryData(['todos'], ['a'])

      const { fixture } = inEffect(() =>
        seen.push(client.getQueryData(['todos'])),
      )

      client.setQueryData(['todos'], ['a', 'b'])
      fixture.detectChanges()

      expect(seen).toEqual([['a']])
    })

    it("invalidateQueries doesn't re-run the effect when another query enters the cache", () => {
      client.setQueryData(['todos'], ['a'])

      const { fixture, runs } = inEffect(() =>
        client.invalidateQueries({ queryKey: ['todos'] }),
      )

      // Fresh data clears the mark; only another invalidation sets it again.
      client.setQueryData(['todos'], ['a', 'b'])
      client.setQueryData(['user'], 'Ann')
      fixture.detectChanges()

      expect(runs()).toBe(1)
      expect(client.getQueryCache().get(['todos'])?.state().isInvalidated).toBe(
        false,
      )
    })

    it("refetchQueries doesn't re-run the effect as queries enter the cache or refetch", () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(['a']))

      @Component({ template: '' })
      class TodoList {
        readonly todos = injectQuery(() => ({ queryKey: ['todos'], queryFn }))
      }

      TestBed.createComponent(TodoList).detectChanges()

      const { fixture, runs } = inEffect(() =>
        client.refetchQueries({ queryKey: ['todos'] }),
      )

      client.setQueryData(['user'], 'Ann')
      fixture.detectChanges()

      expect(runs()).toBe(1)
      // On mount, and once for the effect.
      expect(queryFn).toHaveBeenCalledTimes(2)
    })

    it("cancelQueries doesn't cancel a fetch that starts after it", () => {
      const { fixture } = inEffect(() =>
        client.cancelQueries({ queryKey: ['todos'] }),
      )

      client.fetchQuery(['todos'], () => new Subject<string[]>())
      fixture.detectChanges()

      expect(client.isFetching({ queryKey: ['todos'] })).toBe(1)
    })

    it("removeQueries doesn't remove an entry created after it", () => {
      const { fixture } = inEffect(() =>
        client.removeQueries({ queryKey: ['todos'] }),
      )

      client.setQueryData(['todos'], ['a'])
      fixture.detectChanges()

      expect(client.getQueryData(['todos'])).toEqual(['a'])
    })

    it("isFetching doesn't re-run the effect as fetches start and settle", () => {
      const response = new Subject<string[]>()
      const seen: number[] = []
      const { fixture } = inEffect(() => seen.push(client.isFetching()))

      client.fetchQuery(['todos'], () => response)
      fixture.detectChanges()
      response.next(['a'])
      response.complete()
      fixture.detectChanges()

      expect(seen).toEqual([0])
    })

    it("isMutating doesn't re-run the effect as mutations start and settle", () => {
      const response = new Subject<string>()
      const save = TestBed.runInInjectionContext(() =>
        injectMutation(() => ({ mutationFn: () => response })),
      )
      const seen: number[] = []
      const { fixture } = inEffect(() => seen.push(client.isMutating()))

      save.mutate()
      fixture.detectChanges()
      response.next('saved')
      response.complete()
      fixture.detectChanges()

      expect(seen).toEqual([0])
    })

    it("a tab return or a reconnect fired in the effect doesn't make it depend on what the refetch reads", () => {
      @Component({ template: '' })
      class Host {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: () => of(['a']),
        }))
      }

      TestBed.createComponent(Host).detectChanges()
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })

      try {
        // Each event refetches the stale list, which of() answers at once:
        // the query changes while the effect runs.
        const { runs } = inEffect(() => {
          document.dispatchEvent(new Event('visibilitychange'))
          window.dispatchEvent(new Event('online'))
        })

        expect(runs()).toBe(1)
      } finally {
        Reflect.deleteProperty(document, 'visibilityState')
      }
    })
  })
})
