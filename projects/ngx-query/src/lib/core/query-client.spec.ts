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
