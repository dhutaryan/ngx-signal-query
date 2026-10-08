import { Component, effect, signal } from '@angular/core'
import {
  type ComponentFixture,
  fakeAsync,
  TestBed,
  tick,
} from '@angular/core/testing'
import { of, Subject } from 'rxjs'

import { withDefaultOptions } from '../features/with-default-options'
import { injectMutation } from './inject-mutation'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

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
      expect(defaulted.retry).toBe(3)
      expect(typeof defaulted.retryDelay).toBe('function')
    })

    it('keeps explicitly provided options', () => {
      const defaulted = client.defaultQueryOptions({
        queryKey: ['a'],
        queryFn: () => of(1),
        staleTime: 5000,
        retry: 1,
      })

      expect(defaulted.staleTime).toBe(5000)
      expect(defaulted.retry).toBe(1)
    })
  })

  describe('with configured default options', () => {
    beforeEach(() => {
      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(
            withDefaultOptions({ queries: { staleTime: 1234, retry: 5 } }),
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
      expect(defaulted.retry).toBe(5)
    })

    it('lets per-query options override the configured defaults', () => {
      const defaulted = client.defaultQueryOptions({
        queryKey: ['a'],
        queryFn: () => of(1),
        staleTime: 0,
      })

      expect(defaulted.staleTime).toBe(0)
      expect(defaulted.retry).toBe(5)
    })

    it('applies the configured staleTime in fetchQuery', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      client.fetchQuery(['n'], queryFn)
      client.fetchQuery(['n'], queryFn)

      // staleTime 1234 keeps the data fresh, so no second fetch.
      expect(queryFn).toHaveBeenCalledTimes(1)
    })
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
  })
})
