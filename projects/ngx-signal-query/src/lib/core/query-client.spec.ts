import { fakeAsync, TestBed, tick } from '@angular/core/testing'
import { of } from 'rxjs'

import { withDefaultOptions } from '../features/with-default-options'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

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
})
