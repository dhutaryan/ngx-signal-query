import {
  HttpBackend,
  HttpClient,
  type HttpEvent,
  HttpResponse,
  provideHttpClient,
} from '@angular/common/http'
import {
  ApplicationRef,
  Component,
  type EnvironmentProviders,
  ErrorHandler,
  InjectionToken,
  NgZone,
  PLATFORM_ID,
  type Provider,
  type Signal,
  createEnvironmentInjector,
  inject,
} from '@angular/core'
import {
  TestBed,
  fakeAsync,
  flush,
  flushMicrotasks,
  tick,
} from '@angular/core/testing'
import { createApplication } from '@angular/platform-browser'
import { type Observable, of, Subject, throwError } from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import { listOptions, server } from '../../spec-helpers/list-server'
import {
  goOfflineAndBack,
  leaveAndComeBack,
  pinVisible,
  restoreVisibility,
} from '../../spec-helpers/page-events'
import { settled } from '../../spec-helpers/promises'
import { appIsStable } from '../../spec-helpers/stability'
import {
  inTheBrowser,
  onTheServer,
  pageState,
} from '../../spec-helpers/transfer'
import { provideZonelessChangeDetection } from '../../spec-helpers/zoneless'
import { injectInfiniteQuery } from '../core/inject-infinite-query'
import { injectQueries } from '../core/inject-queries'
import { injectQuery } from '../core/inject-query'
import { provideQueryClient } from '../core/provider'
import { QueryClient } from '../core/query-client'
import type { QueryOptions, QuerySnapshot } from '../core/types'
import { deferred } from '../core/utils'
import { withHydration } from './with-hydration'
import { type QueryCacheConfig, withQueryCache } from './with-query-cache'

// A call of one of the callbacks, with what it got.
type Call =
  | { callback: 'onSuccess'; data: unknown; query: QuerySnapshot }
  | { callback: 'onError'; error: unknown; query: QuerySnapshot }
  | {
      callback: 'onSettled'
      data: unknown
      error: unknown
      query: QuerySnapshot
    }

// Which callbacks were called, in order.
function names(calls: Call[]): string[] {
  return calls.map((call) => call.callback)
}

// The data that each call of onSuccess got, in order.
function succeeded(calls: Call[]): unknown[] {
  return calls.flatMap((call) =>
    call.callback === 'onSuccess' ? [call.data] : [],
  )
}

// A queryFn whose requests stay in flight until answered by hand: respond()
// and fail() answer the latest one. A request the query lets go of is
// unsubscribed, and answering it reaches nobody.
function responses<T>(): {
  queryFn: () => Observable<T>
  sent: Array<Subject<T>>
  respond: (value: T) => void
  fail: (error: unknown) => void
} {
  const sent: Array<Subject<T>> = []

  return {
    queryFn: () => {
      const response = new Subject<T>()

      sent.push(response)

      return response
    },
    sent,
    respond: (value) => {
      const response = sent.at(-1)!

      response.next(value)
      response.complete()
    },
    fail: (error) => sent.at(-1)!.error(error),
  }
}

// Mounts injectQuery in a host component, with options that may read the
// host's input.required `value`, as in an app.
function mount<TData>(
  optionsFn: (value: Signal<number>) => QueryOptions<TData>,
  value = 1,
) {
  return mountHost(
    (hostValue: Signal<number>) => injectQuery(() => optionsFn(hostValue)),
    value,
  )
}

describe('withQueryCache', () => {
  let client: QueryClient
  let calls: Call[]

  // Sets up the client with callbacks that record each call in `calls`,
  // `config` replacing any of them, and with `providers` on top.
  function provide(
    config: QueryCacheConfig = {},
    ...providers: Array<Provider | EnvironmentProviders>
  ): void {
    const recorded: Call[] = []

    calls = recorded
    TestBed.configureTestingModule({
      providers: [
        provideQueryClient(
          withQueryCache({
            onSuccess: (data, query) =>
              recorded.push({ callback: 'onSuccess', data, query }),
            onError: (error, query) =>
              recorded.push({ callback: 'onError', error, query }),
            onSettled: (data, error, query) =>
              recorded.push({ callback: 'onSettled', data, error, query }),
            ...config,
          }),
        ),
        ...providers,
      ],
    })
    client = TestBed.inject(QueryClient)
  }

  // Polling waits while the page is hidden, so the specs mustn't depend on
  // what the test runner's window does.
  beforeEach(pinVisible)
  afterEach(restoreVisibility)

  describe('a fetch that fails', () => {
    // Two components show the same key, such as a list and a counter of it.
    it('calls onError once, after the retries, then onSettled, however many components show the query', fakeAsync(() => {
      provide()

      const api = responses<string[]>()
      const options = (id: Signal<number>): QueryOptions<string[]> => ({
        queryKey: ['todos', id()],
        queryFn: api.queryFn,
        retry: 2,
        retryDelay: 1000,
      })

      mount(options)
      mount(options)
      api.fail(new Error('attempt 1'))
      tick(1000)
      api.fail(new Error('attempt 2'))
      tick(1000)

      expect(api.sent.length).toBe(3)
      expect(calls).toEqual([])

      const error = new Error('attempt 3')

      api.fail(error)

      expect(names(calls)).toEqual(['onError', 'onSettled'])
      expect(calls[0]).toEqual(jasmine.objectContaining({ error }))
      expect(calls[1]).toEqual(
        jasmine.objectContaining({ data: undefined, error }),
      )
    }))

    it('hands onError the query as the fetch left it: its key, the hash, its state and the meta of its options', fakeAsync(() => {
      provide()

      const api = responses<string[]>()

      mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: api.queryFn,
        retry: 1,
        retryDelay: 1000,
        meta: { errorMessage: 'Could not load the todos' },
      }))
      api.fail(new Error('attempt 1'))
      tick(1000)

      const error = new Error('attempt 2')

      api.fail(error)

      expect(calls[0]).toEqual({
        callback: 'onError',
        error,
        query: {
          queryKey: ['todos', 1],
          queryHash: '["todos",1]',
          state: jasmine.objectContaining({
            data: undefined,
            status: 'error',
            error,
            isFetching: false,
            isInvalidated: false,
            failureCount: 2,
            failureReason: error,
            updatedAt: 0,
          }),
          meta: { errorMessage: 'Could not load the todos' },
        },
      })
    }))

    it('keeps the data the query had, in the query it hands over and in onSettled', fakeAsync(() => {
      provide()

      const api = responses<string[]>()
      const { created: todos } = mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: api.queryFn,
        retry: false,
      }))

      api.respond(['milk'])
      void todos.refetch()

      const error = new Error('offline')

      api.fail(error)
      flush()

      expect(names(calls)).toEqual([
        'onSuccess',
        'onSettled',
        'onError',
        'onSettled',
      ])
      expect(calls[2].query.state).toEqual(
        jasmine.objectContaining({ status: 'error', data: ['milk'], error }),
      )
      expect(calls[3]).toEqual(
        jasmine.objectContaining({ data: ['milk'], error }),
      )
    }))
  })

  describe('a fetch that lands', () => {
    it('calls onSuccess with the data and the query, then onSettled with the data and null', fakeAsync(() => {
      provide()

      const api = responses<string[]>()

      mount((id) => ({ queryKey: ['todos', id()], queryFn: api.queryFn }))

      expect(calls).toEqual([])

      api.respond(['milk'])

      const query = {
        queryKey: ['todos', 1],
        queryHash: '["todos",1]',
        state: jasmine.objectContaining({
          data: ['milk'],
          status: 'success',
          error: null,
          isFetching: false,
          isInvalidated: false,
          failureCount: 0,
          failureReason: null,
          updatedAt: Date.now(),
        }),
        meta: undefined,
      }

      expect(calls).toEqual([
        { callback: 'onSuccess', data: ['milk'], query },
        { callback: 'onSettled', data: ['milk'], error: null, query },
      ])
    }))
  })

  describe('whatever starts the fetch', () => {
    it('calls them for each query of injectQueries', fakeAsync(() => {
      provide()

      mountHost(() =>
        injectQueries(() => ({
          queries: [1, 2].map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => of(`todo ${id}`),
          })),
        })),
      )
      flush()

      expect(succeeded(calls)).toEqual(['todo 1', 'todo 2'])
    }))

    it('calls them once for each fetch of an infinite list, a refetch of all its pages included', fakeAsync(() => {
      provide()

      const api = server()
      const { created: list } = mountHost(() =>
        injectInfiniteQuery(() => listOptions(api)),
      )

      void list.fetchNextPage()
      flush()
      api.version = 1
      void list.refetch()
      flush()

      expect(api.sent).toEqual([0, 2, 0, 2])
      expect(succeeded(calls).length).toBe(3)
      expect(succeeded(calls)[2]).toEqual({
        pages: [api.page(0), api.page(2)],
        pageParams: [0, 2],
      })
    }))

    it('calls them for query(), infiniteQuery() and fetchQuery(), with no component showing the query', fakeAsync(() => {
      provide()

      void client.query({ queryKey: ['todos'], queryFn: () => of(['milk']) })
      void client.infiniteQuery(listOptions(server()))
      void client.fetchQuery(['todo', 1], () => of('milk'))
      flush()

      expect(
        calls.flatMap((call) =>
          call.callback === 'onSuccess' ? [call.query.queryKey] : [],
        ),
      ).toEqual([['todos'], ['list'], ['todo', 1]])
    }))

    it('calls onError for a query() that fails, which still rejects with the error', fakeAsync(() => {
      provide()

      const error = new Error('offline')
      const fetched = settled(
        client.query({
          queryKey: ['todos'],
          queryFn: () => throwError(() => error),
        }),
      )

      flush()

      expect(names(calls)).toEqual(['onError', 'onSettled'])
      expect(calls[0]).toEqual(jasmine.objectContaining({ error }))
      expect(fetched.error).toBe(error)
    }))

    it('calls them for the refetch an invalidation starts', fakeAsync(() => {
      provide()

      let version = 0

      mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: () => of(`v${++version}`),
      }))
      void client.invalidateQueries({ queryKey: ['todos'] })
      flush()

      expect(succeeded(calls)).toEqual(['v1', 'v2'])
    }))

    it("calls them for a component's refetch()", fakeAsync(() => {
      provide()

      let version = 0
      const { created: todos } = mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: () => of(`v${++version}`),
      }))

      void todos.refetch()
      flush()

      expect(succeeded(calls)).toEqual(['v1', 'v2'])
    }))

    it('calls them for each poll', fakeAsync(() => {
      provide()

      let version = 0
      const { fixture } = mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: () => of(`v${++version}`),
        refetchInterval: 1000,
      }))

      tick(1000)
      tick(1000)

      expect(succeeded(calls)).toEqual(['v1', 'v2', 'v3'])

      // Stops the polling.
      fixture.destroy()
      flush()
    }))

    it('calls them for a refetch on window focus and on reconnect', fakeAsync(() => {
      provide()

      let version = 0

      mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: () => of(`v${++version}`),
      }))
      leaveAndComeBack()
      flush()
      goOfflineAndBack()
      flush()

      expect(succeeded(calls)).toEqual(['v1', 'v2', 'v3'])
    }))
  })

  describe('calls none', () => {
    it('for a fetch that is cancelled', fakeAsync(() => {
      provide()

      const api = responses<string[]>()

      settled(client.query({ queryKey: ['todos'], queryFn: api.queryFn }))
      client.cancelQueries({ queryKey: ['todos'] })
      api.respond(['milk'])
      flush()

      expect(calls).toEqual([])
    }))

    it('for a fetch that a refetch replaces', fakeAsync(() => {
      provide()

      const api = responses<string>()
      const { created: todo } = mount((id) => ({
        queryKey: ['todo', id()],
        queryFn: api.queryFn,
      }))

      api.respond('v1')
      void todo.refetch()

      const replaced = api.sent.at(-1)!

      void todo.refetch()
      replaced.next('v2')
      api.respond('v3')
      flush()

      expect(names(calls)).toEqual([
        'onSuccess',
        'onSettled',
        'onSuccess',
        'onSettled',
      ])
      expect(succeeded(calls)).toEqual(['v1', 'v3'])
    }))

    it('for a query removed while it fetches', fakeAsync(() => {
      provide()

      const api = responses<string[]>()

      settled(client.query({ queryKey: ['todos'], queryFn: api.queryFn }))
      client.removeQueries({ queryKey: ['todos'] })
      api.respond(['milk'])
      flush()

      expect(calls).toEqual([])
    }))

    it('for data that setQueryData() or initialData writes', fakeAsync(() => {
      provide()

      client.setQueryData(['todos'], ['milk'])
      mount((id) => ({
        queryKey: ['todo', id()],
        queryFn: () => of('fetched'),
        initialData: 'seeded',
        staleTime: Infinity,
      }))
      flush()

      expect(calls).toEqual([])
    }))

    it('for the data that withHydration brings over from the server', fakeAsync(() => {
      onTheServer([provideQueryClient(withHydration())])
      void TestBed.inject(QueryClient).query({
        queryKey: ['todos'],
        queryFn: () => of(['milk']),
      })
      flush()

      const state = pageState()
      const onSuccess = jasmine.createSpy('onSuccess')

      inTheBrowser(state, [
        provideQueryClient(withHydration(), withQueryCache({ onSuccess })),
      ])

      expect(TestBed.inject(QueryClient).getQueryData(['todos'])).toEqual([
        'milk',
      ])
      expect(onSuccess).not.toHaveBeenCalled()
    }))
  })

  describe('meta', () => {
    it('is that of the query() call that fetches the query', fakeAsync(() => {
      provide()

      void client.query({
        queryKey: ['todos'],
        queryFn: () => of(['milk']),
        meta: { errorMessage: 'Could not load the todos' },
      })
      flush()

      expect(calls[0]?.query.meta).toEqual({
        errorMessage: 'Could not load the todos',
      })
    }))

    it('is that of the fetchQuery() call that fetches the query', fakeAsync(() => {
      provide()

      void client.fetchQuery(['todos'], () => of(['milk']), {
        meta: { errorMessage: 'Could not load the todos' },
      })
      flush()

      expect(calls[0]?.query.meta).toEqual({
        errorMessage: 'Could not load the todos',
      })
    }))

    it('is that of the query of injectQueries that the fetch is made for', fakeAsync(() => {
      provide()

      mountHost(() =>
        injectQueries(() => ({
          queries: [1, 2].map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => of(`todo ${id}`),
            meta: { errorMessage: `Could not load todo ${id}` },
          })),
        })),
      )
      flush()

      expect(
        calls.flatMap((call) =>
          call.callback === 'onSuccess' ? [call.query.meta] : [],
        ),
      ).toEqual([
        { errorMessage: 'Could not load todo 1' },
        { errorMessage: 'Could not load todo 2' },
      ])
    }))

    it("is that of the component's infinite list, for its next page too", fakeAsync(() => {
      provide()

      const api = server()
      const { created: list } = mountHost(() =>
        injectInfiniteQuery(() =>
          listOptions(api, {
            meta: { errorMessage: 'Could not load the list' },
          }),
        ),
      )

      void list.fetchNextPage()
      flush()

      expect(
        calls.flatMap((call) =>
          call.callback === 'onSuccess' ? [call.query.meta] : [],
        ),
      ).toEqual([
        { errorMessage: 'Could not load the list' },
        { errorMessage: 'Could not load the list' },
      ])
    }))

    it('is that of the infiniteQuery() call that fetches the list', fakeAsync(() => {
      provide()

      void client.infiniteQuery(
        listOptions(server(), {
          meta: { errorMessage: 'Could not load the list' },
        }),
      )
      flush()

      expect(calls[0]?.query.meta).toEqual({
        errorMessage: 'Could not load the list',
      })
    }))

    it('is that of the component an invalidation refetches the query for', fakeAsync(() => {
      provide()

      mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: () => of(['milk']),
        meta: { silent: true },
      }))
      void client.invalidateQueries({ queryKey: ['todos'] })
      flush()

      expect(names(calls)).toEqual([
        'onSuccess',
        'onSettled',
        'onSuccess',
        'onSettled',
      ])
      expect(calls[2].query.meta).toEqual({ silent: true })
    }))

    it('stays that of the fetch a query() call joins', fakeAsync(() => {
      provide()

      const api = responses<string[]>()

      mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: api.queryFn,
        meta: { errorMessage: 'Could not load the list' },
      }))
      void client.query({
        queryKey: ['todos', 1],
        queryFn: api.queryFn,
        meta: { errorMessage: 'Could not prefetch the list' },
      })
      api.respond(['milk'])
      flush()

      expect(api.sent.length).toBe(1)
      expect(calls[0]?.query.meta).toEqual({
        errorMessage: 'Could not load the list',
      })
    }))
  })

  describe('in the app', () => {
    const REPORTS = new InjectionToken<string[]>('REPORTS')

    it('runs them in the injection context of the injector that provides the client, not of the component', fakeAsync(() => {
      const reports: string[] = []
      const hostReports: string[] = []

      provide(
        { onSuccess: () => inject(REPORTS).push('success') },
        { provide: REPORTS, useValue: reports },
      )

      @Component({
        template: '',
        providers: [{ provide: REPORTS, useValue: hostReports }],
      })
      class TodoList {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: () => of(['milk']),
        }))
      }

      TestBed.createComponent(TodoList).detectChanges()
      flush()

      expect(reports).toEqual(['success'])
      expect(hostReports).toEqual([])
    }))

    // A route's providers make an environment injector below the app's,
    // which the router never destroys, not even with the app. The callbacks
    // belong to the app all the same.
    it('skips them for a fetch that lands once the app above a client provided below it is torn down', fakeAsync(() => {
      const onSuccess = jasmine.createSpy('onSuccess')
      const onSettled = jasmine.createSpy('onSettled')
      let app!: ApplicationRef

      void createApplication({
        providers: [provideZonelessChangeDetection()],
      }).then((created) => (app = created))
      flushMicrotasks()

      // Made as the router makes a route's, with the client among its
      // providers.
      const route = createEnvironmentInjector(
        [provideQueryClient(withQueryCache({ onSuccess, onSettled }))],
        app.injector,
      )
      const routeClient = route.get(QueryClient)

      // While the app is there, the callbacks run.
      void routeClient.query({ queryKey: ['todos'], queryFn: () => of(1) })
      flushMicrotasks()

      expect(onSuccess).toHaveBeenCalledTimes(1)

      const response = new Subject<string>()
      const fetched = settled(
        routeClient.query({ queryKey: ['draft'], queryFn: () => response }),
      )

      // The app is torn down while the fetch is in flight.
      app.destroy()
      response.next('milk')
      response.complete()
      flushMicrotasks()

      expect(fetched.value).toBe('milk')
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(onSettled).toHaveBeenCalledTimes(1)

      // The router never destroys it; the spec does, to leave nothing behind.
      route.destroy()
      flush()
    }))
  })

  // With zone.js, a fetch calls them where it was asked for from, where its
  // data comes back too.
  describe('with zone.js', () => {
    // Sets up callbacks that record which of them ran, and whether in
    // Angular's zone. Returns the record.
    function recordZones(): string[] {
      const zones: string[] = []
      const record = (callback: string) => (): void => {
        zones.push(`${callback} ${NgZone.isInAngularZone() ? 'in' : 'out'}`)
      }

      provide({
        onSuccess: record('onSuccess'),
        onError: record('onError'),
        onSettled: record('onSettled'),
      })

      return zones
    }

    it("runs them in Angular's zone for a component's fetch, though its response comes from outside it", fakeAsync(() => {
      const zones = recordZones()
      const todos = responses<string[]>()
      const user = responses<string>()

      mount((id) => ({ queryKey: ['todos', id()], queryFn: todos.queryFn }))
      mount((id) => ({
        queryKey: ['user', id()],
        queryFn: user.queryFn,
        retry: false,
      }))
      // Answered from here, outside the zone, where a response may come.
      todos.respond(['milk'])
      user.fail(new Error('offline'))
      flush()

      expect(zones).toEqual([
        'onSuccess in',
        'onSettled in',
        'onError in',
        'onSettled in',
      ])
    }))

    it("runs them outside Angular's zone for a poll", fakeAsync(() => {
      const zones = recordZones()

      let version = 0

      const { fixture } = mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: () => of(`v${++version}`),
        refetchInterval: 1000,
      }))

      tick(1000)

      // The first load, then the poll.
      expect(zones).toEqual([
        'onSuccess in',
        'onSettled in',
        'onSuccess out',
        'onSettled out',
      ])

      // Stops the polling.
      fixture.destroy()
      flush()
    }))
  })

  describe('a callback that fails', () => {
    it('reports its error to the ErrorHandler, keeps the data, still calls onSettled and lets the app settle', fakeAsync(() => {
      const failure = new ReferenceError('localStorage is not defined')

      provide({
        onSuccess: () => {
          throw failure
        },
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const fetched = settled(
        client.query({ queryKey: ['todos'], queryFn: () => of(['milk']) }),
      )

      flushMicrotasks()

      expect(fetched.value).toEqual(['milk'])
      expect(client.getQueryData(['todos'])).toEqual(['milk'])
      expect(names(calls)).toEqual(['onSettled'])
      expect(handleError).toHaveBeenCalledOnceWith(failure)
      expect(appIsStable()).toBe(true)
      flush()
    }))

    it("keeps the fetch's error when onError throws, and still calls onSettled", fakeAsync(() => {
      const failure = new Error('the toast service is down')

      provide({
        onError: () => {
          throw failure
        },
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('offline')
      const fetched = settled(
        client.query({
          queryKey: ['todos'],
          queryFn: () => throwError(() => error),
        }),
      )

      flush()

      expect(fetched.error).toBe(error)
      expect(names(calls)).toEqual(['onSettled'])
      expect(calls[0]).toEqual(jasmine.objectContaining({ error }))
      expect(handleError).toHaveBeenCalledOnceWith(failure)
    }))

    it('reports a promise it returns once that rejects, and waits for none', fakeAsync(() => {
      const logged = deferred()

      provide({ onSuccess: () => logged.promise })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const fetched = settled(
        client.query({ queryKey: ['todos'], queryFn: () => of(['milk']) }),
      )

      flushMicrotasks()

      expect(fetched.value).toEqual(['milk'])
      expect(names(calls)).toEqual(['onSettled'])
      expect(appIsStable()).toBe(true)
      expect(handleError).not.toHaveBeenCalled()

      const failure = new Error('the log server is down')

      logged.reject(failure)
      flushMicrotasks()

      expect(handleError).toHaveBeenCalledOnceWith(failure)
      flush()
    }))

    // Without zone.js, nothing catches an error that escapes the render
    // on its own: Node ends the process before the page is written out. A
    // callback that reaches for an API only the browser has is enough.
    it('reports its error during a server render without zone.js, and lets the render finish', fakeAsync(() => {
      const failure = new ReferenceError('localStorage is not defined')

      provide(
        {
          onSuccess: () => {
            throw failure
          },
        },
        provideZonelessChangeDetection(),
        { provide: PLATFORM_ID, useValue: 'server' },
      )

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')

      @Component({
        template: `
          {{ todos.status() }}
        `,
      })
      class TodoList {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: () => of(['milk']),
        }))
      }

      const fixture = TestBed.createComponent(TodoList)

      expect(appIsStable()).toBe(true)
      expect(fixture.nativeElement.textContent.trim()).toBe('success')
      expect(handleError).toHaveBeenCalledOnceWith(failure)
    }))
  })

  describe('timing', () => {
    it('calls them before code that awaits query() goes on', fakeAsync(() => {
      const order: string[] = []

      provide({
        onSuccess: () => order.push('onSuccess'),
        onSettled: () => order.push('onSettled'),
      })
      void client
        .query({ queryKey: ['todos'], queryFn: () => of(['milk']) })
        .then(() => order.push('awaited'))
      flush()

      expect(order).toEqual(['onSuccess', 'onSettled', 'awaited'])
    }))

    it('hands over the query as the fetch left it, which later changes leave alone', fakeAsync(() => {
      provide()

      void client.query({ queryKey: ['todos'], queryFn: () => of(['milk']) })
      flushMicrotasks()

      const query = calls[0]?.query

      client.setQueryData(['todos'], ['milk', 'bread'])
      void client.invalidateQueries({ queryKey: ['todos'] })

      expect(query?.state.data).toEqual(['milk'])
      expect(query?.state.isInvalidated).toBe(false)
      flush()
    }))

    // Nothing waits for a callback, but a server render waits for what keeps
    // the app busy, and HttpClient keeps it busy for each request it makes:
    // a request that reports the failure goes out before the page does.
    it('keeps the app busy for a request that a callback makes with HttpClient', fakeAsync(() => {
      // The log server, which answers when the spec says. Not
      // provideHttpClientTesting(): it makes requests leave the app's
      // stability alone, so that a test's whenStable() doesn't wait for them.
      const logged = new Subject<HttpEvent<unknown>>()

      provide(
        {
          onError: (error) => {
            inject(HttpClient).post('/api/log', String(error)).subscribe()
          },
        },
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: HttpBackend, useValue: { handle: () => logged } },
      )

      const response = new Subject<string[]>()
      let stable = false

      settled(client.query({ queryKey: ['todos'], queryFn: () => response }))
      void TestBed.inject(ApplicationRef)
        .whenStable()
        .then(() => (stable = true))
      response.error(new Error('offline'))
      tick()

      expect(logged.observed).toBe(true)
      expect(stable).toBe(false)

      logged.next(new HttpResponse({ status: 204 }))
      logged.complete()
      tick()

      expect(stable).toBe(true)
      flush()
    }))
  })

  // An invalidation while a query loads for the first time lets the load
  // land or fail, then refetches the query once, right after.
  describe('with a refetch queued during the first load', () => {
    it('hands onSuccess the query as the load left it, before the refetch starts', fakeAsync(() => {
      provide()

      const api = responses<string[]>()

      mount((id) => ({ queryKey: ['todos', id()], queryFn: api.queryFn }))
      void client.invalidateQueries({ queryKey: ['todos'] })
      api.respond(['milk'])

      expect(api.sent.length).toBe(2)
      expect(calls[0]?.query.state).toEqual(
        jasmine.objectContaining({
          status: 'success',
          data: ['milk'],
          isFetching: false,
        }),
      )

      api.respond(['milk', 'bread'])
      flush()
    }))

    it('hands onError the query as the load left it, before the refetch starts', fakeAsync(() => {
      provide()

      const api = responses<string[]>()
      const error = new Error('offline')

      mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: api.queryFn,
        retry: false,
      }))
      void client.invalidateQueries({ queryKey: ['todos'] })
      api.fail(error)

      expect(api.sent.length).toBe(2)
      expect(calls[0]?.query.state).toEqual(
        jasmine.objectContaining({ status: 'error', error, isFetching: false }),
      )

      api.respond(['milk'])
      flush()
    }))

    // A queryFn may answer at once, from a cache of its own say: the refetch
    // then lands while the load's handling is still going on.
    it("calls the load's callbacks before those of a refetch that answers at once", fakeAsync(() => {
      provide()

      const load = new Subject<string>()
      let requests = 0

      mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: (): Observable<string> => (++requests === 1 ? load : of('v2')),
      }))
      void client.invalidateQueries({ queryKey: ['todos'] })
      load.next('v1')
      load.complete()
      flush()

      expect(requests).toBe(2)
      expect(succeeded(calls)).toEqual(['v1', 'v2'])
    }))

    it('calls the last callbacks for the fetch that the query ends with', fakeAsync(() => {
      provide()

      const load = new Subject<string>()
      let requests = 0

      mount((id) => ({
        queryKey: ['todos', id()],
        retry: false,
        queryFn: (): Observable<string> =>
          ++requests === 1
            ? load
            : throwError(() => new Error('the session ended')),
      }))
      void client.invalidateQueries({ queryKey: ['todos'] })
      load.next('v1')
      load.complete()
      flush()

      expect(names(calls)).toEqual([
        'onSuccess',
        'onSettled',
        'onError',
        'onSettled',
      ])
      expect(client.getQueryCache().get(['todos', 1])?.state().status).toBe(
        'error',
      )
    }))

    // On a 401, say, an app signs the user out from onError and clears the
    // cache: nothing of the old session may go out after that.
    it("doesn't start the refetch once onError clears the cache", fakeAsync(() => {
      provide({ onError: () => inject(QueryClient).clear() })

      const api = responses<string[]>()

      mount((id) => ({
        queryKey: ['todos', id()],
        queryFn: api.queryFn,
        retry: false,
      }))
      void client.invalidateQueries({ queryKey: ['todos'] })
      api.fail(new Error('401 Unauthorized'))
      flush()

      expect(api.sent.length).toBe(1)
      expect(client.getQueryCache().getAll()).toEqual([])
    }))

    // An app may clear the cache once a response shows the session has
    // ended, the user's profile say.
    it("doesn't start the refetch once onSuccess clears the cache", fakeAsync(() => {
      provide({ onSuccess: () => inject(QueryClient).clear() })

      const api = responses<string[]>()

      mount((id) => ({ queryKey: ['todos', id()], queryFn: api.queryFn }))
      void client.invalidateQueries({ queryKey: ['todos'] })
      api.respond(['milk'])
      flush()

      expect(api.sent.length).toBe(1)
      expect(client.getQueryCache().getAll()).toEqual([])
    }))
  })

  // A callback may remove queries that the client is still busy with: the
  // query whose fetch just ended, or those that an invalidation, or the
  // user's return to the page, is about to refetch after it. A query removed
  // that way is done with.
  describe('a callback that removes queries', () => {
    it('leaves no timer of the query that onSuccess removes behind', fakeAsync(() => {
      provide({
        onSuccess: () =>
          inject(QueryClient).removeQueries({ queryKey: ['todos'] }),
      })

      void client.query({ queryKey: ['todos'], queryFn: () => of(['milk']) })

      // Nothing is left to run, so flush() has no time to move on.
      expect(flush()).toBe(0)
      expect(client.getQueryCache().getAll()).toEqual([])
    }))

    it('leaves no timer of the query that onError removes behind', fakeAsync(() => {
      provide({ onError: () => inject(QueryClient).clear() })

      settled(
        client.query({
          queryKey: ['todos'],
          queryFn: () => throwError(() => new Error('401 Unauthorized')),
        }),
      )

      expect(flush()).toBe(0)
      expect(client.getQueryCache().getAll()).toEqual([])
    }))

    // Components show the session, then the todos, both answering at once,
    // as data that an app keeps in memory does. Once the session has ended,
    // the session's refetch clears the cache from onSuccess. Returns the
    // queries fetched from then on.
    function endTheSession(): string[] {
      provide({
        onSuccess: (data) => {
          if (data === 'ended') inject(QueryClient).clear()
        },
      })

      let session = 'active'
      const fetched: string[] = []

      mount(() => ({
        queryKey: ['session'],
        queryFn: () => {
          fetched.push('session')

          return of(session)
        },
      }))
      mount(() => ({
        queryKey: ['todos'],
        queryFn: () => {
          fetched.push('todos')

          return of(['milk'])
        },
      }))
      flush()
      session = 'ended'
      fetched.length = 0

      return fetched
    }

    it("doesn't refetch the queries after one whose onSuccess clears the cache during an invalidation", fakeAsync(() => {
      const fetched = endTheSession()

      void client.invalidateQueries()
      flush()

      expect(fetched).toEqual(['session'])
    }))

    it("doesn't refetch the queries after one whose onSuccess clears the cache when the user comes back to the page", fakeAsync(() => {
      const fetched = endTheSession()

      leaveAndComeBack()
      flush()

      expect(fetched).toEqual(['session'])
    }))

    it("doesn't refetch the queries after one whose onSuccess clears the cache when the network comes back", fakeAsync(() => {
      const fetched = endTheSession()

      goOfflineAndBack()
      flush()

      expect(fetched).toEqual(['session'])
    }))
  })

  // An app may write its callbacks as a class, with state of its own in a
  // field, say.
  describe('a class as the config', () => {
    it('calls the callbacks as its methods, so they keep its this', fakeAsync(() => {
      class Reporter implements QueryCacheConfig {
        readonly calls: string[] = []

        onSuccess(): void {
          this.calls.push('onSuccess')
        }

        onError(): void {
          this.calls.push('onError')
        }

        onSettled(): void {
          this.calls.push('onSettled')
        }
      }

      const reporter = new Reporter()

      TestBed.configureTestingModule({
        providers: [provideQueryClient(withQueryCache(reporter))],
      })
      client = TestBed.inject(QueryClient)
      void client.query({ queryKey: ['todos'], queryFn: () => of(['milk']) })
      settled(
        client.query({
          queryKey: ['user'],
          queryFn: () => throwError(() => new Error('offline')),
        }),
      )
      flush()

      expect(reporter.calls).toEqual([
        'onSuccess',
        'onSettled',
        'onError',
        'onSettled',
      ])
    }))
  })
})
