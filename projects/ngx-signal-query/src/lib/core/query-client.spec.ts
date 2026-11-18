import {
  Component,
  DestroyRef,
  EnvironmentInjector,
  NgZone,
  PLATFORM_ID,
  createComponent,
  createEnvironmentInjector,
  effect,
  inject,
  signal,
} from '@angular/core'
import {
  type ComponentFixture,
  fakeAsync,
  flush,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing'
import { createApplication } from '@angular/platform-browser'
import { Observable, of, Subject, throwError } from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import {
  type List,
  type Page,
  listOptions,
  server,
  threePages,
} from '../../spec-helpers/list-server'
import {
  goOfflineAndBack,
  leaveAndComeBack,
} from '../../spec-helpers/page-events'
import { settled } from '../../spec-helpers/promises'
import { appIsStable } from '../../spec-helpers/stability'
import { provideZonelessChangeDetection } from '../../spec-helpers/zoneless'
import { withDefaultOptions } from '../features/with-default-options'
import { CancelledError } from './cancelled-error'
import { injectInfiniteQuery } from './inject-infinite-query'
import { injectMutation } from './inject-mutation'
import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type {
  InfiniteQueryFunctionContext,
  QueryFunctionContext,
  QueryKey,
} from './types'
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
      expect(defaulted.refetchIntervalInBackground).toBe(false)
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
        refetchIntervalInBackground: true,
      })

      expect(defaulted.staleTime).toBe(5000)
      expect(defaulted.gcTime).toBe(1000)
      expect(defaulted.retry).toBe(1)
      expect(defaulted.refetchOnWindowFocus).toBe('always')
      expect(defaulted.refetchOnReconnect).toBe(false)
      expect(defaulted.refetchIntervalInBackground).toBe(true)
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

      it('turns polling off, whatever the query asks for', () => {
        const asNumber = client.defaultQueryOptions({
          queryKey: ['a'],
          queryFn: () => of(1),
          refetchInterval: 100,
        })
        const asFunction = client.defaultQueryOptions({
          queryKey: ['b'],
          queryFn: () => of(1),
          refetchInterval: () => 100,
        })

        expect(asNumber.refetchInterval).toBe(false)
        expect(asFunction.refetchInterval).toBe(false)
      })

      it("doesn't retry unless the query asks", () => {
        const unasked = client.defaultQueryOptions({
          queryKey: ['a'],
          queryFn: () => of(1),
        })
        const asked = client.defaultQueryOptions({
          queryKey: ['b'],
          queryFn: () => of(1),
          retry: 2,
        })

        expect(unasked.retry).toBe(0)
        expect(asked.retry).toBe(2)
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
                refetchIntervalInBackground: true,
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
      expect(defaulted.refetchIntervalInBackground).toBe(true)
    })

    it('lets per-query options override the configured defaults', () => {
      const defaulted = client.defaultQueryOptions({
        queryKey: ['a'],
        queryFn: () => of(1),
        staleTime: 0,
        gcTime: 1000,
        refetchOnWindowFocus: 'always',
        refetchIntervalInBackground: false,
      })

      expect(defaulted.staleTime).toBe(0)
      expect(defaulted.gcTime).toBe(1000)
      expect(defaulted.retry).toBe(5)
      expect(defaulted.refetchOnWindowFocus).toBe('always')
      expect(defaulted.refetchOnReconnect).toBe(false)
      expect(defaulted.refetchIntervalInBackground).toBe(false)
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

    it('applies the configured staleTime in query()', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      client.query({ queryKey: ['n'], queryFn })
      client.query({ queryKey: ['n'], queryFn })

      // staleTime 1234 keeps the data fresh, so no second fetch.
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('applies the configured retry and retryDelay in query()', fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []

      client.query({
        queryKey: ['n'],
        queryFn: () => {
          sent.push(Date.now() - start)

          return throwError(() => new Error('down'))
        },
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
      client.setQueryData<number>(['n'], () => undefined)

      expect(client.getQueryData(['n'])).toBe(5)
    })

    it("doesn't create an entry when the updater returns undefined", () => {
      client.setQueryData<string[]>(['todos'], (todos) =>
        todos?.map((todo) => todo.toUpperCase()),
      )

      expect(client.getQueryCache().get(['todos'])).toBeUndefined()
    })

    it("doesn't create an entry for an undefined value", () => {
      // A rollback to what the key held before: nothing.
      const previous = client.getQueryData<string[]>(['todos'])

      client.setQueryData<string[]>(['todos'], previous)

      expect(client.getQueryCache().get(['todos'])).toBeUndefined()
    })

    it('writes into a new entry when the updater removes the key', () => {
      client.setQueryData(['todo'], 'v1')
      client.setQueryData<string>(['todo'], (todo) => {
        client.removeQueries({ queryKey: ['todo'] })

        return `${todo}!`
      })

      // Into the cache as the updater left it, not into the query it removed.
      expect(client.getQueryData(['todo'])).toBe('v1!')
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

  // query() takes a query's options as they are, such as a queryOptions()
  // definition: what fetching the query needs comes from them, and what only
  // a component does with a query doesn't apply.
  describe('query', () => {
    it("doesn't refetch data that's fresh for the options' staleTime", fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const todos = { queryKey: ['todos'], queryFn, staleTime: 60_000 }

      client.query(todos)
      tick(59_999)

      const result = settled(client.query(todos))

      flushMicrotasks()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result.value).toBe(1)
    }))

    it("removes a query nobody shows the options' gcTime after its fetch lands", fakeAsync(() => {
      client.query({
        queryKey: ['todos'],
        queryFn: () => of('v1'),
        gcTime: 1000,
      })

      tick(999)
      expect(client.getQueryData(['todos'])).toBe('v1')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it('retries a failing fetch as the options say', fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []

      client.query({
        queryKey: ['n'],
        queryFn: () => {
          sent.push(Date.now() - start)

          return throwError(() => new Error('down'))
        },
        retry: 2,
        retryDelay: 10,
      })
      tick(60_000)

      expect(sent).toEqual([0, 10, 20])
    }))

    it("doesn't retry a failing fetch unless asked", fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []

      client.query({
        queryKey: ['n'],
        queryFn: () => {
          sent.push(Date.now() - start)

          return throwError(() => new Error('down'))
        },
      })
      tick(60_000)

      expect(sent).toEqual([0])
    }))

    it("doesn't retry with retry: undefined written out, as with none", fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []

      client.query({
        queryKey: ['n'],
        queryFn: () => {
          sent.push(Date.now() - start)

          return throwError(() => new Error('down'))
        },
        retry: undefined,
      })
      tick(60_000)

      expect(sent).toEqual([0])
    }))

    it("waits out the retries of a fetch it joins, such as a component's", fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []
      const failing = (): Observable<string> => {
        sent.push(Date.now() - start)

        return throwError(() => new Error('down'))
      }
      const { fixture } = mountHost(() =>
        injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: failing,
          retry: 2,
          retryDelay: 100,
        })),
      )
      const result = settled(
        client.query({ queryKey: ['todos'], queryFn: failing }),
      )

      tick(199)
      expect(result).toEqual({})

      tick(1)
      expect(result.error).toEqual(new Error('down'))
      expect(sent).toEqual([0, 100, 200])

      fixture.destroy()
    }))

    // A call that fails before any fetch settles its promise all the same,
    // so a caller that handles the promise hears of it there.
    it('rejects, rather than throwing, when an initialData function throws', fakeAsync(() => {
      const error = new Error('boom')
      let result: { value?: string; error?: unknown } = {}

      expect(() => {
        result = settled(
          client.query({
            queryKey: ['todos'],
            queryFn: () => of('v1'),
            initialData: (): string => {
              throw error
            },
          }),
        )
      }).not.toThrow()
      flushMicrotasks()

      expect(result.error).toBe(error)
    }))

    it("rejects, rather than throwing, when the key can't be hashed", fakeAsync(() => {
      let result: { value?: string; error?: unknown } = {}

      expect(() => {
        result = settled(
          client.query({ queryKey: ['todo', 1n], queryFn: () => of('v1') }),
        )
      }).not.toThrow()
      flushMicrotasks()

      expect(result.error).toBeInstanceOf(TypeError)
    }))

    it("stores the response as is with the options' structuralSharing: false", () => {
      client.setQueryData(['n'], { id: 1, tags: ['a'] })

      const cached = client.getQueryData(['n'])

      client.query({
        queryKey: ['n'],
        queryFn: () => of({ id: 1, tags: ['a'] }),
        structuralSharing: false,
      })

      expect(client.getQueryData(['n'])).not.toBe(cached)
      expect(client.getQueryData(['n'])).toEqual({ id: 1, tags: ['a'] })
    })

    it('waits for a fetch of the key in flight rather than fetching again', fakeAsync(() => {
      const response = new Subject<string>()
      const second = jasmine.createSpy('second')

      client.query({ queryKey: ['todos'], queryFn: () => response })

      const result = settled(
        client.query({ queryKey: ['todos'], queryFn: second }),
      )

      response.next('v1')
      response.complete()
      flushMicrotasks()

      expect(result.value).toBe('v1')
      expect(second).not.toHaveBeenCalled()
    }))

    it("fetches whatever the options' enabled says", () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('v1'))

      client.query({ queryKey: ['todos'], queryFn, enabled: false })

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['todos'])).toBe('v1')
    })

    it("doesn't poll with the options' refetchInterval", fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('v1'))

      client.query({ queryKey: ['todos'], queryFn, refetchInterval: 10 })
      tick(1000)

      expect(queryFn).toHaveBeenCalledTimes(1)
    }))

    it("doesn't refetch on focus or reconnect, whatever the options say", fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('v1'))

      client.query({
        queryKey: ['todos'],
        queryFn,
        refetchOnWindowFocus: 'always',
        refetchOnReconnect: 'always',
      })
      leaveAndComeBack()
      goOfflineAndBack()

      expect(queryFn).toHaveBeenCalledTimes(1)
    }))

    it("leaves the options' placeholderData out of the cache", () => {
      client.query({
        queryKey: ['todos'],
        queryFn: () => new Subject<string>(),
        placeholderData: 'placeholder',
      })

      expect(client.getQueryData(['todos'])).toBeUndefined()
    })

    // As for a component showing the key: initialData seeds a key with no
    // data, and staleTime decides whether the seed is fetched over.
    describe('with initialData', () => {
      it('resolves with it, without a request, while it is fresh', fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('v1'))
        const result = settled(
          client.query({
            queryKey: ['todos'],
            queryFn,
            initialData: 'seed',
            staleTime: 60_000,
          }),
        )

        flushMicrotasks()

        expect(result.value).toBe('seed')
        expect(queryFn).not.toHaveBeenCalled()
        expect(client.getQueryData(['todos'])).toBe('seed')
      }))

      it('seeds the key, then fetches over the seed once it is stale', fakeAsync(() => {
        const response = new Subject<string>()
        const result = settled(
          client.query({
            queryKey: ['todos'],
            queryFn: () => response,
            initialData: 'seed',
          }),
        )

        expect(client.getQueryData(['todos'])).toBe('seed')

        response.next('v1')
        response.complete()
        flushMicrotasks()

        expect(result.value).toBe('v1')
        expect(client.getQueryData(['todos'])).toBe('v1')
      }))

      it('takes initialDataUpdatedAt as when the seed was fetched', () => {
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.returnValue(new Subject<string>())

        client.query({
          queryKey: ['todos'],
          queryFn,
          initialData: 'seed',
          initialDataUpdatedAt: Date.now() - 60_000,
          staleTime: 60_000,
        })

        // Fetched a minute ago, the seed is stale for a staleTime of a minute.
        expect(client.getQueryData(['todos'])).toBe('seed')
        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it("seeds nothing when it's a function that gives undefined", fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('v1'))
        const result = settled(
          client.query({
            queryKey: ['todos'],
            queryFn,
            initialData: () => undefined,
            staleTime: 60_000,
          }),
        )

        flushMicrotasks()

        expect(result.value).toBe('v1')
        expect(queryFn).toHaveBeenCalledTimes(1)
      }))

      it("doesn't seed a key that holds data", () => {
        client.setQueryData(['todos'], 'cached')
        client.query({
          queryKey: ['todos'],
          queryFn: () => new Subject<string>(),
          initialData: 'seed',
        })

        expect(client.getQueryData(['todos'])).toBe('cached')
      })

      it("resolves with a fresh seed at once, while the key's first load is in flight", fakeAsync(() => {
        const load = new Subject<string>()
        const { fixture } = mountHost(() =>
          injectQuery(() => ({ queryKey: ['todos'], queryFn: () => load })),
        )
        const result = settled(
          client.query({
            queryKey: ['todos'],
            queryFn: () => of('not asked'),
            initialData: 'seed',
            staleTime: 60_000,
          }),
        )

        flushMicrotasks()
        expect(result.value).toBe('seed')

        load.next('first')
        load.complete()
        expect(client.getQueryData(['todos'])).toBe('first')

        fixture.destroy()
      }))

      it('seeds a key whose fetch failed before it had any data', fakeAsync(() => {
        client.query({
          queryKey: ['todos'],
          queryFn: () => throwError(() => new Error('down')),
        })
        flushMicrotasks()

        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('v1'))
        const result = settled(
          client.query({
            queryKey: ['todos'],
            queryFn,
            initialData: 'seed',
            staleTime: 60_000,
          }),
        )

        flushMicrotasks()

        expect(result.value).toBe('seed')
        expect(queryFn).not.toHaveBeenCalled()
      }))

      it("keeps a key it seeds for the options' gcTime, when that's longer than the key's", fakeAsync(() => {
        // A first load that fails leaves the key with no data, kept for 1 s.
        client.query({
          queryKey: ['todos'],
          queryFn: () => throwError(() => new Error('down')),
          gcTime: 1000,
        })
        flushMicrotasks()

        client.query({
          queryKey: ['todos'],
          queryFn: () => of('v1'),
          initialData: 'seed',
          staleTime: 60_000,
          gcTime: 10_000,
        })

        tick(9_999)
        expect(client.getQueryData(['todos'])).toBe('seed')

        tick(1)
        expect(client.getQueryData(['todos'])).toBeUndefined()
      }))
    })
  })

  // A list of the items 0 to 7, two to a page: the pages are asked for with
  // the params 0, 2, 4 and 6 (see server()).
  describe('infiniteQuery', () => {
    it('fetches the first page with initialPageParam, and resolves with the list', fakeAsync(() => {
      const api = server()
      const result = settled(client.infiniteQuery(listOptions(api)))

      flushMicrotasks()

      expect(api.sent).toEqual([0])
      expect(result.value).toEqual({ pages: [api.page(0)], pageParams: [0] })
      expect(client.getQueryData(['list'])).toBe(result.value)
    }))

    it('fetches as many pages as `pages` asks for, each with the param getNextPageParam gives for the page before', fakeAsync(() => {
      const api = server()
      const result = settled(
        client.infiniteQuery({ ...listOptions(api), pages: 3 }),
      )

      flushMicrotasks()

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.value).toEqual(threePages(api))
    }))

    it('fetches fewer pages than `pages` asks for once getNextPageParam gives no next one', fakeAsync(() => {
      const api = server()

      client.infiniteQuery({ ...listOptions(api), pages: 5 })

      expect(api.sent).toEqual([0, 2, 4, 6])
    }))

    it("refetches every page a stale list holds, in order, from the first page's own param", fakeAsync(() => {
      const api = server()

      client.setQueryData<List>(['list'], {
        pages: [api.page(2), api.page(4), api.page(6)],
        pageParams: [2, 4, 6],
      })
      // Item 3 is deleted: each page after the first is asked for with the
      // param getNextPageParam gives for the page just fetched.
      api.items = [0, 1, 2, 4, 5, 6, 7]

      const result = settled(client.infiniteQuery(listOptions(api)))

      flushMicrotasks()

      expect(api.sent).toEqual([2, 5, 7])
      expect(result.value).toEqual({
        pages: [api.page(2), api.page(5), api.page(7)],
        pageParams: [2, 5, 7],
      })
    }))

    it('fetches only the first `pages` pages of a stale list that holds more', fakeAsync(() => {
      const api = server()

      client.setQueryData<List>(['list'], threePages(api))

      const result = settled(
        client.infiniteQuery({ ...listOptions(api), pages: 1 }),
      )

      flushMicrotasks()

      expect(api.sent).toEqual([0])
      expect(result.value).toEqual({ pages: [api.page(0)], pageParams: [0] })
    }))

    it('fetches only the first page with `pages: 0`, however many pages a stale list holds', fakeAsync(() => {
      const api = server()

      client.setQueryData<List>(['list'], threePages(api))

      const result = settled(
        client.infiniteQuery({ ...listOptions(api), pages: 0 }),
      )

      flushMicrotasks()

      expect(api.sent).toEqual([0])
      expect(result.value).toEqual({ pages: [api.page(0)], pageParams: [0] })
    }))

    it('fetches as many pages as `pages` asks for of a stale list that holds fewer', fakeAsync(() => {
      const api = server()

      client.setQueryData<List>(['list'], {
        pages: [api.page(0)],
        pageParams: [0],
      })

      const result = settled(
        client.infiniteQuery({ ...listOptions(api), pages: 3 }),
      )

      flushMicrotasks()

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.value).toEqual(threePages(api))
    }))

    it("leaves a list that's fresh for the options' staleTime as it is, whatever `pages` asks for", fakeAsync(() => {
      const api = server()
      const options = listOptions(api, { staleTime: 60_000 })

      client.infiniteQuery(options)
      tick(59_999)

      const result = settled(client.infiniteQuery({ ...options, pages: 3 }))

      flushMicrotasks()

      expect(api.sent).toEqual([0])
      expect(result.value).toEqual({ pages: [api.page(0)], pageParams: [0] })
    }))

    it('counts the pages it fetches, not the pages maxPages keeps', fakeAsync(() => {
      const api = server()
      const result = settled(
        client.infiniteQuery({
          ...listOptions(api, { maxPages: 2 }),
          pages: 3,
        }),
      )

      flushMicrotasks()

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.value).toEqual({
        pages: [api.page(2), api.page(4)],
        pageParams: [2, 4],
      })
    }))

    it("doesn't retry a page that fails unless asked, and the list keeps the pages it held", fakeAsync(() => {
      const api = server()

      client.setQueryData<List>(['list'], threePages(api))
      api.failOnce.add(2)

      const result = settled(client.infiniteQuery(listOptions(api)))

      tick(60_000)

      expect(api.sent).toEqual([0, 2])
      expect(result.error).toEqual(new Error('page 2 failed'))
      expect(client.getQueryData(['list'])).toEqual(threePages(api))
    }))

    it("lets a component that shows the key afterwards show the list without a fetch while it's fresh, and add the next page", fakeAsync(() => {
      const api = server()

      client.infiniteQuery(listOptions(api, { staleTime: 60_000 }))

      const { fixture, created: list } = mountHost(() =>
        injectInfiniteQuery(() => listOptions(api, { staleTime: 60_000 })),
      )

      expect(list.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
      expect(list.isFetching()).toBe(false)
      expect(list.hasNextPage()).toBe(true)

      list.fetchNextPage()
      flushMicrotasks()

      expect(api.sent).toEqual([0, 2])
      expect(list.data()).toEqual({
        pages: [api.page(0), api.page(2)],
        pageParams: [0, 2],
      })

      fixture.destroy()
    }))

    it('goes on with its own queryFn once a component that joined its fetch moves to another key', fakeAsync(() => {
      const sent: string[] = []
      const answers: Array<() => void> = []
      // Promise query functions that don't read the signal: the component
      // leaving the key doesn't stop the fetch.
      const pagesOf =
        (who: string) =>
        ({
          queryKey: [, list],
          pageParam,
        }: InfiniteQueryFunctionContext<QueryKey, number>): Promise<Page> => {
          sent.push(`${who} ${list}:${pageParam}`)

          return new Promise((resolve) =>
            answers.push(() =>
              resolve({
                items: [`${list}:${pageParam}`],
                next: pageParam < 4 ? pageParam + 2 : null,
                previous: null,
              }),
            ),
          )
        }
      const listOf = (list: number, who: string) => ({
        queryKey: ['list', list],
        queryFn: pagesOf(who),
        initialPageParam: 0,
        getNextPageParam: (lastPage: Page) => lastPage.next,
      })
      const result = settled(
        client.infiniteQuery({ ...listOf(1, 'call'), pages: 3 }),
      )
      // The list opens while the prefetch runs, so the component joins its
      // fetch, then moves to another list before the first page is in.
      const { fixture, value } = mountHost(
        (list) => injectInfiniteQuery(() => listOf(list(), 'component')),
        1,
      )

      value.set(2)
      fixture.detectChanges()

      for (let i = 0; i < 5; i++) {
        answers.splice(0).forEach((answer) => answer())
        flushMicrotasks()
      }

      expect(sent).toEqual([
        'call 1:0',
        'component 2:0',
        'call 1:2',
        'call 1:4',
      ])
      expect(result.value?.pageParams).toEqual([0, 2, 4])

      fixture.destroy()
    }))

    it('waits for a fetch of the list in flight, whatever `pages` asks for', fakeAsync(() => {
      const api = server()

      api.hold.add(0)

      const { fixture } = mountHost(() =>
        injectInfiniteQuery(() => listOptions(api)),
      )
      const result = settled(
        client.infiniteQuery({ ...listOptions(api), pages: 3 }),
      )

      api.answer(0)
      flushMicrotasks()

      expect(api.sent).toEqual([0])
      expect(result.value).toEqual({ pages: [api.page(0)], pageParams: [0] })

      fixture.destroy()
    }))

    // As for query(): initialData seeds a key with no data, and staleTime
    // decides whether the seed is fetched over.
    describe('with initialData', () => {
      it('resolves with a fresh seed, without a request', fakeAsync(() => {
        const api = server()
        const seed: List = { pages: [api.page(4)], pageParams: [4] }
        const result = settled(
          client.infiniteQuery(
            listOptions(api, { initialData: seed, staleTime: 60_000 }),
          ),
        )

        flushMicrotasks()

        expect(result.value).toBe(seed)
        expect(api.sent).toEqual([])
      }))

      it("refetches every page of a stale seed, from its first page's param", fakeAsync(() => {
        const api = server()
        const seed: List = {
          pages: [api.page(2), api.page(4)],
          pageParams: [2, 4],
        }

        // The server's list has changed since the seed was read.
        api.version = 1

        const result = settled(
          client.infiniteQuery(listOptions(api, { initialData: seed })),
        )

        flushMicrotasks()

        expect(api.sent).toEqual([2, 4])
        expect(result.value).toEqual({
          pages: [api.page(2), api.page(4)],
          pageParams: [2, 4],
        })
      }))
    })
  })

  describe('fetchQuery', () => {
    it('populates the cache from the queryFn', () => {
      client.fetchQuery(['n'], () => of(10))
      expect(client.getQueryData(['n'])).toBe(10)
    })

    it('hands queryFn the key and a signal', () => {
      const contexts: QueryFunctionContext[] = []

      client.fetchQuery(['todo', 1], (context) => {
        contexts.push(context)

        return of('todo 1')
      })

      expect(contexts.length).toBe(1)
      expect(contexts[0].queryKey).toEqual(['todo', 1])
      expect(contexts[0].signal).toBeInstanceOf(AbortSignal)
      expect(contexts[0].signal.aborted).toBe(false)
    })

    it('does not refetch fresh data within staleTime', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

      client.fetchQuery(['n'], queryFn, { staleTime: Infinity })
      client.fetchQuery(['n'], queryFn, { staleTime: Infinity })

      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('removes a query nobody shows the gcTime it asks for after the fetch lands', fakeAsync(() => {
      client.fetchQuery(['todos'], () => of('v1'), { gcTime: 1000 })

      tick(999)
      expect(client.getQueryData(['todos'])).toBe('v1')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it('dedupes an in-flight fetch without cancelRefetch', () => {
      const first = jasmine
        .createSpy('first')
        .and.returnValue(new Promise<number>(() => {})) // never resolves
      const second = jasmine.createSpy('second')

      client.fetchQuery(['n'], first)
      client.fetchQuery(['n'], second, { staleTime: 0 })

      expect(second).not.toHaveBeenCalled()
    })

    it('cancelRefetch restarts an in-flight fetch of a key with data, with a fresh queryFn', fakeAsync(() => {
      const first = jasmine
        .createSpy('first')
        .and.returnValue(new Promise<number>(() => {})) // never resolves
      const second = jasmine
        .createSpy('second')
        .and.returnValue(Promise.resolve(2))

      client.setQueryData(['n'], 1)
      client.fetchQuery(['n'], first)
      client.fetchQuery(['n'], second, { staleTime: 0, cancelRefetch: true })
      tick()

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['n'])).toBe(2)
    }))

    it("cancelRefetch doesn't let a request that fails as its signal is aborted fail the fetch it replaces", fakeAsync(() => {
      // The key holds data, stale at once, so fetchQuery() refetches it.
      client.setQueryData(['todos'], 'cached')

      const first = settled(
        client.fetchQuery(
          ['todos'],
          ({ signal }) =>
            new Observable<string>((subscriber) => {
              signal.addEventListener('abort', () =>
                subscriber.error(new Error('aborted')),
              )
            }),
        ),
      )
      const second = settled(
        client.fetchQuery(['todos'], () => of('fresh'), {
          cancelRefetch: true,
        }),
      )

      flushMicrotasks()

      // Whoever waited for the replaced fetch gets the one that replaced it.
      expect(first).toEqual({ value: 'fresh' })
      expect(second).toEqual({ value: 'fresh' })
    }))

    it('cancelRefetch lets a fetch of a key with no data land, then fetches once more with its own queryFn', fakeAsync(() => {
      const load = new Subject<number>()
      const again = new Subject<number>()
      const first = settled(client.fetchQuery(['n'], () => load))
      const second = settled(
        client.fetchQuery(['n'], () => again, { cancelRefetch: true }),
      )

      expect(load.observed).toBe(true)
      expect(again.observed).toBe(false)

      load.next(1)
      load.complete()
      flushMicrotasks()

      expect(first.value).toBe(1)
      expect(again.observed).toBe(true)
      expect(second).toEqual({})

      again.next(2)
      again.complete()
      flushMicrotasks()

      expect(second.value).toBe(2)
      expect(client.getQueryData(['n'])).toBe(2)
    }))

    it('cancelRefetch rejects with a CancelledError once the key is removed during the fetch it waits for', fakeAsync(() => {
      client.fetchQuery(['n'], () => new Subject<number>())

      const waiting = settled(
        client.fetchQuery(['n'], () => new Subject<number>(), {
          cancelRefetch: true,
        }),
      )

      client.removeQueries({ queryKey: ['n'] })
      flushMicrotasks()

      expect(waiting.error).toEqual(jasmine.any(CancelledError))
    }))

    it('cancelRefetch fetches once more with the queryFn of the call made last', fakeAsync(() => {
      const load = new Subject<number>()
      const earlier = jasmine.createSpy('earlier').and.returnValue(of(1))
      const later = jasmine.createSpy('later').and.returnValue(of(2))

      client.fetchQuery(['n'], () => load)
      client.fetchQuery(['n'], earlier, { cancelRefetch: true })
      client.fetchQuery(['n'], later, { cancelRefetch: true })

      load.next(0)
      load.complete()
      flushMicrotasks()

      expect(earlier).not.toHaveBeenCalled()
      expect(later).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['n'])).toBe(2)
    }))

    it('cancelRefetch fetches once more with its own queryFn and retry, not those of a component showing the key, even one that asked too', fakeAsync(() => {
      const load = new Subject<string>()
      const componentFn = jasmine.createSpy('componentFn').and.returnValue(load)

      @Component({ template: '' })
      class Todos {
        readonly todos = injectQuery(() => ({
          queryKey: ['n'],
          queryFn: componentFn,
          retry: 3,
          retryDelay: 10,
        }))
      }

      TestBed.createComponent(Todos).detectChanges()

      const error = new Error('down')
      const mine = jasmine
        .createSpy('mine')
        .and.returnValue(throwError(() => error))
      const result = settled(
        client.fetchQuery(['n'], mine, { cancelRefetch: true }),
      )

      // The component asks for a refetch after the call.
      client.invalidateQueries({ queryKey: ['n'] })
      load.next('first')
      load.complete()
      flushMicrotasks()

      // Not retried: fetchQuery doesn't retry unless asked.
      expect(mine).toHaveBeenCalledTimes(1)
      expect(componentFn).toHaveBeenCalledTimes(1)
      expect(result.error).toBe(error)
    }))

    it("cancelRefetch still fetches once more after a component's first load once the component is gone", fakeAsync(() => {
      const load = deferred<string>()

      @Component({ template: '' })
      class Todos {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: () => load.promise,
        }))
      }

      const fixture = TestBed.createComponent(Todos)

      fixture.detectChanges()

      const fresh = jasmine.createSpy('fresh').and.returnValue(of('fresh'))
      const result = settled(
        client.fetchQuery(['todos'], fresh, { cancelRefetch: true }),
      )

      // fetchQuery needs no component: the one showing the key goes away
      // while its first load runs on.
      fixture.destroy()
      load.resolve('old')
      flushMicrotasks()

      expect(fresh).toHaveBeenCalledTimes(1)
      expect(result.value).toBe('fresh')
    }))

    it('cancelRefetch rejects with a CancelledError when the last component leaves the Observable load it waits behind', fakeAsync(() => {
      @Component({ template: '' })
      class Todos {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: () => new Subject<string>(),
        }))
      }

      const fixture = TestBed.createComponent(Todos)

      fixture.detectChanges()

      const fresh = jasmine.createSpy('fresh').and.returnValue(of('fresh'))
      const result = settled(
        client.fetchQuery(['todos'], fresh, { cancelRefetch: true }),
      )

      // Leaving stops the load, as it would stop any Observable fetch.
      fixture.destroy()
      flushMicrotasks()

      expect(fresh).not.toHaveBeenCalled()
      expect(result.error).toEqual(jasmine.any(CancelledError))
    }))

    it('cancelRefetch hands its queryFn over to the retries of the fetch it waits for', fakeAsync(() => {
      const loadA = jasmine
        .createSpy('loadA')
        .and.returnValue(throwError(() => new Error('blip')))
      const loadB = jasmine.createSpy('loadB').and.returnValue(of('B'))

      client.fetchQuery(['n'], loadA, { retry: 1, retryDelay: 10 })

      const result = settled(
        client.fetchQuery(['n'], loadB, { cancelRefetch: true }),
      )

      tick(10)
      flushMicrotasks()

      // The retry went out after the call, with its queryFn.
      expect(loadA).toHaveBeenCalledTimes(1)
      expect(loadB).toHaveBeenCalledTimes(1)
      expect(result.value).toBe('B')
    }))

    it('cancelRefetch rejects with the error of a retry that went out after the call', fakeAsync(() => {
      const responses: Array<Subject<string>> = []

      @Component({ template: '' })
      class Todos {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: () => {
            const response = new Subject<string>()

            responses.push(response)

            return response
          },
          retry: 1,
          retryDelay: 10,
        }))
      }

      TestBed.createComponent(Todos).detectChanges()

      const callerFn = jasmine.createSpy('callerFn').and.returnValue(of('mine'))
      const result = settled(
        client.fetchQuery(['todos'], callerFn, { cancelRefetch: true }),
      )

      responses[0].error(new Error('first'))
      tick(10)

      // The retry went out after the call, so it reads the data after it:
      // its failure is the call's.
      const error = new Error('second')

      responses[1].error(error)
      flushMicrotasks()

      expect(callerFn).not.toHaveBeenCalled()
      expect(result.error).toBe(error)
    }))

    it('cancelRefetch resolves with the data written meanwhile when the fetch it waits behind is cancelled', fakeAsync(() => {
      client.fetchQuery(['todos'], () => new Subject<string>())

      const result = settled(
        client.fetchQuery(['todos'], () => of('fresh'), {
          cancelRefetch: true,
        }),
      )

      client.setQueryData(['todos'], 'written')
      client.cancelQueries({ queryKey: ['todos'] })
      flushMicrotasks()

      expect(result.value).toBe('written')
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

    it('stores the response as is with structuralSharing: false', () => {
      client.setQueryData(['n'], { id: 1, tags: ['a'] })

      const cached = client.getQueryData(['n'])

      client.fetchQuery(['n'], () => of({ id: 1, tags: ['a'] }), {
        structuralSharing: false,
      })

      expect(client.getQueryData(['n'])).not.toBe(cached)
      expect(client.getQueryData(['n'])).toEqual({ id: 1, tags: ['a'] })
    })

    it('keeps the cached data when cancelRefetch refetches the same data', () => {
      client.setQueryData(['n'], { id: 1, tags: ['a'] })

      const cached = client.getQueryData(['n'])

      client.fetchQuery(['n'], () => of({ id: 1, tags: ['a'] }), {
        cancelRefetch: true,
      })

      expect(client.getQueryData(['n'])).toBe(cached)
    })

    it('keeps what a first load brought when cancelRefetch fetches the same data once it lands', fakeAsync(() => {
      const load = new Subject<{ id: number; tags: string[] }>()
      const first = { id: 1, tags: ['a'] }

      client.fetchQuery(['n'], () => load)
      client.fetchQuery(['n'], () => of({ id: 1, tags: ['a'] }), {
        cancelRefetch: true,
      })
      load.next(first)
      load.complete()
      flushMicrotasks()

      expect(client.getQueryData(['n'])).toBe(first)
    }))

    // Only the options it fetches with reach the fetch. An options object
    // built elsewhere, rather than written in the call, may hold other
    // fields too, such as a scroll setting shared with it.
    it('fetches with the options it knows, whatever else its options object holds', fakeAsync(() => {
      const shared = { staleTime: 0, behavior: 'smooth' }
      const fetched = settled(client.fetchQuery(['n'], () => of(1), shared))

      flushMicrotasks()

      // And so does the refetch it asks for with cancelRefetch.
      const refetching = { ...shared, cancelRefetch: true }
      const refetched = settled(
        client.fetchQuery(['n'], () => of(2), refetching),
      )

      flushMicrotasks()

      expect(fetched.value).toBe(1)
      expect(refetched.value).toBe(2)
      expect(client.isFetching()).toBe(0)
    }))

    // A whole definition passed as its options, say: only the options
    // fetchQuery takes reach the fetch, not the definition's initialData, key
    // or queryFn.
    it('takes only its own options from an options object that holds a whole definition', fakeAsync(() => {
      const definition = {
        queryKey: ['other'],
        queryFn: () => of('from the definition'),
        initialData: 'seed',
        staleTime: 60_000,
      }
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.returnValue(of('fetched'))
      const result = settled(client.fetchQuery(['todos'], queryFn, definition))

      flushMicrotasks()

      expect(result.value).toBe('fetched')
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['other'])).toBeUndefined()
    }))

    it("rejects, rather than throwing, when the key can't be hashed", fakeAsync(() => {
      let result: { value?: string; error?: unknown } = {}

      expect(() => {
        result = settled(client.fetchQuery(['todo', 1n], () => of('v1')))
      }).not.toThrow()
      flushMicrotasks()

      expect(result.error).toBeInstanceOf(TypeError)
    }))

    // A server render and whenStable() wait for it as for a component's
    // query, so the data is in the cache by then.
    it('keeps the app busy until the fetch lands, though no component shows the key', fakeAsync(() => {
      const response = new Subject<string>()

      client.fetchQuery(['todos'], () => response)
      expect(appIsStable()).toBe(false)

      response.next('v1')
      response.complete()

      expect(appIsStable()).toBe(true)
      expect(client.getQueryData(['todos'])).toBe('v1')
    }))

    // zone.js counts the app as busy while a timer set in the Angular zone is
    // pending. The query is kept for gcTime once the fetch lands, and that
    // wait mustn't hold the app up.
    it('lets a zone.js app settle once the fetch lands, though no component shows the key', fakeAsync(() => {
      // As a click handler or a route resolver calls it: in the Angular zone.
      TestBed.inject(NgZone).run(() =>
        client.fetchQuery(['todos'], () => of('v1')),
      )

      expect(appIsStable()).toBe(true)
      expect(client.getQueryData(['todos'])).toBe('v1')
    }))

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

      it('rejects when the queryFn produces undefined', fakeAsync(() => {
        const result = settled(
          client.fetchQuery(['todo', 3], () => of(undefined)),
        )

        flushMicrotasks()

        expect(result.error).toEqual(
          new Error(
            'Query function for ["todo",3] produced undefined; return null for no data',
          ),
        )
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

      it("doesn't surface a failed refetch that cancelRefetch queued and nobody waits for as an unhandled rejection", fakeAsync(() => {
        const load = new Subject<number>()

        client.fetchQuery(['n'], () => load)
        client.fetchQuery(['n'], () => throwError(() => new Error('down')), {
          cancelRefetch: true,
        })

        load.next(1)
        load.complete()

        // fakeAsync rethrows an unhandled rejection when microtasks run.
        expect(() => flushMicrotasks()).not.toThrow()
        expect(client.getQueryCache().get(['n'])?.state().status).toBe('error')
      }))
    })

    describe('on the server', () => {
      beforeEach(() => {
        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
          providers: [
            provideQueryClient(),
            { provide: PLATFORM_ID, useValue: 'server' },
          ],
        })
        client = TestBed.inject(QueryClient)
      })

      // As in the browser: a resolver that waits for the data hears of a
      // failure at once, unless the call asks for retries.
      it('retries a failing fetch only as the call asks', fakeAsync(() => {
        const start = Date.now()
        const sent = { unasked: [] as number[], asked: [] as number[] }
        const failing = (attempts: number[]) => () => {
          attempts.push(Date.now() - start)

          return throwError(() => new Error('down'))
        }

        client.fetchQuery(['unasked'], failing(sent.unasked))
        client.fetchQuery(['asked'], failing(sent.asked), {
          retry: 2,
          retryDelay: 10,
        })
        tick(60_000)

        expect(sent).toEqual({ unasked: [0], asked: [0, 10, 20] })
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

    it('aborts the signal of the fetch it stops', () => {
      const contexts: QueryFunctionContext[] = []

      client.fetchQuery(['todos'], (context) => {
        contexts.push(context)

        return new Promise<string>(() => {})
      })
      client.cancelQueries({ queryKey: ['todos'] })

      expect(contexts[0].signal.aborted).toBe(true)
    })

    it("doesn't let a request that fails as its signal is aborted fail the fetch it stops", fakeAsync(() => {
      // The key holds data, stale at once, so fetchQuery() refetches it.
      client.setQueryData(['todos'], 'cached')

      const waiting = settled(
        client.fetchQuery(
          ['todos'],
          ({ signal }) =>
            new Observable<string>((subscriber) => {
              signal.addEventListener('abort', () =>
                subscriber.error(new Error('aborted')),
              )
            }),
        ),
      )

      client.cancelQueries({ queryKey: ['todos'] })
      flushMicrotasks()

      // Whoever waits gets what cancelling says: the data the key holds.
      expect(waiting).toEqual({ value: 'cached' })
    }))

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

    it('aborts the signal of a fetch in flight', () => {
      const contexts: QueryFunctionContext[] = []

      client.fetchQuery(['todos'], (context) => {
        contexts.push(context)

        return new Promise<string>(() => {})
      })
      client.removeQueries({ queryKey: ['todos'] })

      expect(contexts[0].signal.aborted).toBe(true)
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

  describe('clear', () => {
    it('empties the query cache and the mutation cache', () => {
      const save = TestBed.runInInjectionContext(() =>
        injectMutation(() => ({ mutationFn: () => new Subject<string>() })),
      )

      client.setQueryData(['todos'], ['a'])
      client.setQueryData(['user'], 'Ann')
      save.mutate()

      client.clear()

      expect(client.getQueryCache().getAll()).toEqual([])
      expect(client.getQueryData(['todos'])).toBeUndefined()
      expect(client.getMutationCache().getAll()).toEqual([])
      // The run goes on outside the cache, where nothing counts it.
      expect(client.isMutating()).toBe(0)
    })

    it('cancels the fetches in flight, and a fetchQuery() waiting for one rejects with a CancelledError', fakeAsync(() => {
      const response = new Subject<string[]>()
      const result = settled(client.fetchQuery(['todos'], () => response))

      client.clear()
      flushMicrotasks()

      expect(response.observed).toBe(false)
      expect(result.error).toBeInstanceOf(CancelledError)
      expect(client.isFetching()).toBe(0)
    }))

    it('leaves no timer of the removed queries behind', fakeAsync(() => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.returnValue(throwError(() => new Error('down')))

      // One waits to be collected, the other to try its failed fetch again.
      client.setQueryData(['todos'], ['a'])
      client.fetchQuery(['todo', 1], queryFn, { retry: 3, retryDelay: 1000 })

      client.clear()

      // Nothing is left to run, so flush() has no time to move on.
      expect(flush()).toBe(0)
      expect(queryFn).toHaveBeenCalledTimes(1)
    }))
  })

  // A client provided by an injector of its own goes with that injector: its
  // queries stop, so nothing of theirs keeps the app busy or runs on. A fetch
  // started on the client afterwards still runs, but doesn't keep the app
  // busy either.
  describe('when the injector that provides it is destroyed', () => {
    function provideInChild(): {
      injector: EnvironmentInjector
      child: QueryClient
    } {
      const injector = createEnvironmentInjector(
        [provideQueryClient()],
        TestBed.inject(EnvironmentInjector),
      )

      return { injector, child: injector.get(QueryClient) }
    }

    it('stops the fetches in flight, which no longer keep the app busy', fakeAsync(() => {
      const { injector, child } = provideInChild()
      const response = new Subject<string>()

      child.fetchQuery(['todos'], () => response)
      expect(appIsStable()).toBe(false)

      injector.destroy()

      expect(response.observed).toBe(false)
      expect(appIsStable()).toBe(true)
    }))

    it('leaves no timer of its queries behind', fakeAsync(() => {
      const { injector, child } = provideInChild()

      child.setQueryData(['todos'], ['a'])
      injector.destroy()

      // Nothing is left to run, so flush() has no time to move on.
      expect(flush()).toBe(0)
    }))

    it("doesn't let a fetch started afterwards keep the app busy, and still runs it", fakeAsync(() => {
      const { injector, child } = provideInChild()
      const response = new Subject<string>()
      let data: string | undefined

      // One while its injector was there, answered at once.
      child.fetchQuery(['todos'], () => of('a'))
      injector.destroy()
      child
        .fetchQuery(['todo', 1], () => response)
        .then((value) => (data = value))

      expect(appIsStable()).toBe(true)

      response.next('milk')
      response.complete()
      flushMicrotasks()

      expect(data).toBe('milk')
    }))

    // On the server, Angular tears the app down after each render: it marks
    // the app's injector destroyed first, then destroys the components, so a
    // component's DestroyRef callback runs with the client's injector gone.
    it('runs a fetch a component starts as the whole app is torn down', async () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('draft'))

      @Component({ selector: 'nsq-draft', template: '' })
      class Draft {
        constructor() {
          const client = inject(QueryClient)

          inject(DestroyRef).onDestroy(() => {
            client.fetchQuery(['draft'], queryFn)
          })
        }
      }

      const host = document.body.appendChild(
        document.createElement('nsq-draft'),
      )
      const app = await createApplication({
        providers: [provideZonelessChangeDetection(), provideQueryClient()],
      })

      app.bootstrap(Draft, host)

      expect(() => app.destroy()).not.toThrow()
      expect(queryFn).toHaveBeenCalledTimes(1)

      host.remove()
    })
  })

  // A route's providers make an environment injector below the app's, which
  // the router never destroys, not even with the app. As the app is torn down,
  // the client's own injector still counts as alive, but what the client
  // reaches through it from the app's injector is gone.
  describe('when the app above the injector that provides it is torn down', () => {
    it('runs a fetch a component starts as the app is torn down', async () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('draft'))

      @Component({ selector: 'nsq-draft', template: '' })
      class Draft {
        constructor() {
          const client = inject(QueryClient)

          inject(DestroyRef).onDestroy(() => {
            client.fetchQuery(['draft'], queryFn)
          })
        }
      }

      const host = document.body.appendChild(
        document.createElement('nsq-draft'),
      )
      const app = await createApplication({
        providers: [provideZonelessChangeDetection()],
      })
      // Made as the router makes a route's, with the client among its
      // providers.
      const route = createEnvironmentInjector(
        [provideQueryClient()],
        app.injector,
      )
      const draft = createComponent(Draft, {
        environmentInjector: route,
        hostElement: host,
      })

      app.attachView(draft.hostView)

      expect(() => app.destroy()).not.toThrow()
      expect(queryFn).toHaveBeenCalledTimes(1)

      // The router never destroys it; the spec does, to leave nothing behind.
      route.destroy()
      host.remove()
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

    it("setQueryData doesn't make the effect depend on the data it updates", () => {
      client.setQueryData(['count'], 0)

      const { fixture, runs } = inEffect(() =>
        client.setQueryData<number>(['count'], (count = 0) => count + 1),
      )

      expect(runs()).toBe(1)
      expect(client.getQueryData(['count'])).toBe(1)

      client.setQueryData(['count'], 100)
      fixture.detectChanges()

      expect(runs()).toBe(1)
      expect(client.getQueryData(['count'])).toBe(100)
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

    it("clear doesn't remove an entry created after it", () => {
      const { fixture } = inEffect(() => client.clear())

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
