import {
  Component,
  type EnvironmentProviders,
  ErrorHandler,
  Injector,
  NgZone,
  type OnInit,
  PLATFORM_ID,
  type Provider,
  type Signal,
  type WritableSignal,
  effect,
  input,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core'
import {
  type ComponentFixture,
  TestBed,
  fakeAsync,
  flush,
  flushMicrotasks,
  tick,
} from '@angular/core/testing'
import { type Observable, map, of, Subject, throwError, timer } from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import {
  goOfflineAndBack,
  leaveAndComeBack,
  pinVisible,
  restoreVisibility,
  setVisibility,
} from '../../spec-helpers/page-events'
import { settled } from '../../spec-helpers/promises'
import { withDefaultOptions } from '../features/with-default-options'
import { injectQuery } from './inject-query'
import { keepPreviousData } from './keep-previous-data'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type {
  DefaultQueryOptions,
  QueryKey,
  QueryOptions,
  QueryResult,
} from './types'
import { type Deferred, deferred } from './utils'

// Mounts injectQuery in a host component, as mountHost() mounts anything:
// its options may read the host's input.required `value`. Returns the result,
// the parent's `value` signal and the fixture.
function mount<TData, TError = Error, TValue = number>(
  optionsFn: (value: Signal<TValue>) => QueryOptions<TData, TError>,
  value?: TValue,
): {
  fixture: ComponentFixture<unknown>
  result: QueryResult<TData, TError>
  value: WritableSignal<TValue>
} {
  const mounted = mountHost(
    (hostValue: Signal<TValue>) =>
      injectQuery<TData, TError>(() => optionsFn(hostValue)),
    value,
  )

  return {
    fixture: mounted.fixture,
    result: mounted.created,
    value: mounted.value,
  }
}

// Mounts `count` hosts side by side, like several components on one page
// showing the same thing. Each gets `value` through its own input.required
// binding, so a key built from it puts them all on one query. Returns their
// results in template order, and the fixture.
function mountMany<TData, TError = Error, TValue = number>(
  count: number,
  optionsFn: (value: Signal<TValue>) => QueryOptions<TData, TError>,
  value?: TValue,
): {
  fixture: ComponentFixture<unknown>
  results: Array<QueryResult<TData, TError>>
} {
  @Component({ selector: 'app-host', template: '' })
  class Host {
    readonly value = input.required<TValue>()
    readonly result = injectQuery<TData, TError>(() => optionsFn(this.value))
  }

  @Component({
    imports: [Host],
    template: `
      @for (host of hosts; track $index) {
        <app-host [value]="value()" />
      }
    `,
  })
  class Parent {
    readonly hosts = Array.from({ length: count })
    readonly value = signal(value as TValue)
    readonly children = viewChildren(Host)
  }

  const fixture = TestBed.createComponent(Parent)

  fixture.detectChanges()

  return {
    fixture,
    results: fixture.componentInstance.children().map((host) => host.result),
  }
}

// A queryFn whose requests stay in flight until answered by hand. Every call
// is a new request; one the query cancels is unsubscribed, so it no longer
// counts as in flight. resolve() answers the latest request, and fail()
// fails it.
function requests<T>(): {
  queryFn: jasmine.Spy<() => Observable<T>>
  inFlight: () => number
  cancelled: () => number
  resolve: (value: T) => void
  fail: (error: Error) => void
} {
  const subjects: Array<Subject<T>> = []
  const answered = new Set<Subject<T>>()
  const queryFn = jasmine
    .createSpy<() => Observable<T>>('queryFn')
    .and.callFake(() => {
      const subject = new Subject<T>()

      subjects.push(subject)

      return subject
    })

  return {
    queryFn,
    inFlight: () => subjects.filter((subject) => subject.observed).length,
    cancelled: () =>
      subjects.filter((subject) => !subject.observed && !answered.has(subject))
        .length,
    resolve: (value) => {
      const subject = subjects.at(-1)!

      answered.add(subject)
      subject.next(value)
      subject.complete()
    },
    fail: (error) => {
      const subject = subjects.at(-1)!

      answered.add(subject)
      subject.error(error)
    },
  }
}

// A queryFn whose requests return promises answered by hand: requests[n]
// settles the n-th request sent. Unlike an Observable, a promise can't be
// aborted: a request the query lets go of still runs to the end.
function promiseRequests<T>(): {
  queryFn: jasmine.Spy<(...args: unknown[]) => Promise<T>>
  requests: Array<Deferred<T>>
} {
  const requests: Array<Deferred<T>> = []
  const queryFn = jasmine
    .createSpy<(...args: unknown[]) => Promise<T>>('queryFn')
    .and.callFake(() => {
      const request = deferred<T>()

      requests.push(request)

      return request.promise
    })

  return { queryFn, requests }
}

// A queryFn whose requests take `latency` ms each. `starts` records when each
// request was sent, in ms since timed() was called. Call it inside fakeAsync.
function timed(latency: number): {
  queryFn: jasmine.Spy<() => Observable<number>>
  starts: number[]
} {
  const start = Date.now()
  const starts: number[] = []
  const queryFn = jasmine
    .createSpy<() => Observable<number>>('queryFn')
    .and.callFake(() => {
      starts.push(Date.now() - start)

      return timer(latency).pipe(map(() => starts.length))
    })

  return { queryFn, starts }
}

// Advances fake time in 10 ms steps and runs change detection after each,
// as an app does after every task. An effect only sees a state change once
// change detection runs.
function elapse(
  ms: number,
  ...fixtures: Array<ComponentFixture<unknown>>
): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    tick(10)
    fixtures.forEach((fixture) => fixture.detectChanges())
  }
}

// A row of a cached list, for the specs that seed a detail query from it.
type Todo = { id: number; title: string }

describe('injectQuery', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
  })

  // Polling waits while the page is hidden, so the specs mustn't depend on
  // what the test runner's window does. A spec hides the page itself.
  beforeEach(pinVisible)
  afterEach(restoreVisibility)

  // Replaces the client every spec starts with by one with these providers.
  function reprovide(
    ...providers: Array<Provider | EnvironmentProviders>
  ): void {
    TestBed.resetTestingModule()
    TestBed.configureTestingModule({ providers })
    client = TestBed.inject(QueryClient)
  }

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
      // Pending, but not loading: nothing is in flight, so a spinner on
      // isLoading() doesn't spin forever while the query waits.
      expect(result.isFetching()).toBe(false)
      expect(result.isLoading()).toBe(false)
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

    // enabled governs automatic fetching only: refetch() is an explicit
    // instruction, which fetch-on-demand relies on.
    it('fetches on refetch() while disabled', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { result } = mount(() => ({
        queryKey: ['e'],
        queryFn,
        enabled: false,
      }))

      result.refetch()

      expect(queryFn).toHaveBeenCalledTimes(1)
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

    it('sends one request for a refetch() made in an effect', fakeAsync(() => {
      const { queryFn } = timed(100)
      const online = signal(false)
      let runs = 0

      @Component({ template: '' })
      class Host {
        readonly result = injectQuery(() => ({ queryKey: ['todos'], queryFn }))

        constructor() {
          // Refetches once the connection is back. Stopped after 20 runs, so
          // a loop fails the expectation rather than change detection.
          effect(() => {
            runs++

            if (runs > 20) return

            if (online()) this.result.refetch()
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      elapse(100, fixture)
      online.set(true)
      fixture.detectChanges()
      elapse(100, fixture)

      // One on mount, one for the reconnect.
      expect(queryFn).toHaveBeenCalledTimes(2)
    }))

    it("does not make an effect that calls refetch() track the query's options", fakeAsync(() => {
      const { queryFn } = timed(100)
      const online = signal(false)
      const page = signal(1)
      let runs = 0

      @Component({ template: '' })
      class Host {
        readonly result = injectQuery(() => ({
          queryKey: ['todos', page()],
          queryFn,
        }))

        constructor() {
          // Refetches once the connection is back. Stopped after 20 runs, so
          // a loop fails the expectation rather than change detection.
          effect(() => {
            runs++

            if (runs > 20) return

            if (online()) this.result.refetch()
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      elapse(100, fixture)
      online.set(true)
      fixture.detectChanges()
      elapse(100, fixture)
      page.set(2)
      fixture.detectChanges()
      elapse(100, fixture)

      // On mount and for the reconnect: the next page is the query's to load,
      // not a reason for the effect to refetch.
      expect(runs).toBe(2)
      // Page 1 on mount and for the reconnect, then page 2.
      expect(queryFn).toHaveBeenCalledTimes(3)
    }))

    // refetch() resolves with the data and the error the signals hold once
    // its fetch settles.
    describe('refetch() promise', () => {
      it('resolves once the response lands, with its data and no error', fakeAsync(() => {
        const { queryFn, resolve } = requests<string>()
        const { result } = mount(() => ({ queryKey: ['r'], queryFn }))

        resolve('a')

        const refetched = settled(result.refetch())

        flushMicrotasks()
        expect(refetched).toEqual({})

        resolve('b')
        flushMicrotasks()

        expect(refetched.value).toEqual({ data: 'b', error: null })
      }))

      it('resolves with the error instead of rejecting', fakeAsync(() => {
        const error = new Error('down')
        let fail = false
        const { result } = mount(() => ({
          queryKey: ['r'],
          queryFn: () => (fail ? throwError(() => error) : of('a')),
          retry: false,
        }))

        fail = true

        const refetched = settled(result.refetch())

        flushMicrotasks()

        // The data it had stays, next to the error.
        expect(refetched.error).toBeUndefined()
        expect(refetched.value).toEqual({ data: 'a', error })
      }))

      it('resolves with the data of a fetch that replaces it', fakeAsync(() => {
        const { queryFn, resolve, cancelled } = requests<string>()
        const { result } = mount(() => ({ queryKey: ['r'], queryFn }))

        resolve('a')

        const refetched = settled(result.refetch())

        // An invalidation replaces the request in flight with a new one.
        client.invalidateQueries({ queryKey: ['r'] })
        resolve('b')
        flushMicrotasks()

        expect(cancelled()).toBe(1)
        expect(refetched.value?.data).toBe('b')
      }))

      it('resolves when the component goes away before the response', fakeAsync(() => {
        const { queryFn } = requests<string>()
        const { fixture, result } = mount(() => ({ queryKey: ['r'], queryFn }))
        const refetched = settled(result.refetch())

        // The last component showing the query is gone, so its fetch is
        // cancelled before there's any data.
        fixture.destroy()
        flushMicrotasks()

        expect(refetched.error).toBeUndefined()
        expect(refetched.value).toEqual({ data: undefined, error: null })
      }))

      it('refetches a disabled query and resolves with its data', fakeAsync(() => {
        const { result } = mount(() => ({
          queryKey: ['r'],
          queryFn: () => of('a'),
          enabled: false,
        }))
        const refetched = settled(result.refetch())

        flushMicrotasks()

        expect(refetched.value?.data).toBe('a')
      }))

      it("doesn't surface a failure nobody waits for as an unhandled rejection", fakeAsync(() => {
        const { result } = mount(() => ({
          queryKey: ['r'],
          queryFn: () => throwError(() => new Error('down')),
          retry: false,
        }))

        result.refetch()

        // fakeAsync rethrows an unhandled rejection when microtasks run.
        expect(() => flushMicrotasks()).not.toThrow()
        expect(result.isError()).toBe(true)
      }))
    })
  })

  // One invalidateQueries() call costs one request per query, however many
  // components observe it. The scenarios resolve the refetch and run change
  // detection again: some of what can go wrong only happens once it lands.
  describe('invalidation', () => {
    it('makes one request for all observers of a key', () => {
      const { queryFn, inFlight, cancelled, resolve } = requests<string>()
      const { fixture, results } = mountMany(
        3,
        (id) => ({
          queryKey: ['todo', id()],
          queryFn,
          // Fresh until invalidated, so only the invalidation can fetch.
          staleTime: Infinity,
        }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()

      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()

      // One on mount, one for the invalidation.
      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(inFlight()).toBe(1)
      expect(cancelled()).toBe(0)

      resolve('v2')
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(results.map((result) => result.data())).toEqual(['v2', 'v2', 'v2'])
    })

    it('makes one request per invalidation at the default staleTime', () => {
      const { queryFn, inFlight, resolve } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()

      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      resolve('v2')
      fixture.detectChanges()

      // staleTime 0 makes the refetched data stale at once: anything that
      // wakes the fetch now, such as the invalidated flag clearing, would
      // send another request.
      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(inFlight()).toBe(0)
      expect(result.data()).toBe('v2')
    })

    it('makes one request for all observers at the default staleTime', () => {
      const { queryFn, inFlight, cancelled, resolve } = requests<string>()
      const { fixture, results } = mountMany(
        3,
        (id) => ({ queryKey: ['todo', id()], queryFn }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()

      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      resolve('v2')
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(cancelled()).toBe(0)
      expect(inFlight()).toBe(0)
      expect(results.map((result) => result.data())).toEqual(['v2', 'v2', 'v2'])
    })

    it('makes one request when queryFn is synchronous', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('v'))
      const { fixture } = mountMany(
        3,
        (id) => ({ queryKey: ['todo', id()], queryFn }),
        1,
      )
      // Each host fetches on mount: the request resolves at once, so at
      // staleTime 0 the next host finds stale data rather than a request to
      // share. Only what the invalidation adds is under test.
      const mounted = queryFn.calls.count()

      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()

      expect(queryFn.calls.count() - mounted).toBe(1)
    })

    it('restarts the refetch when invalidated again while it runs', () => {
      const { queryFn, inFlight, cancelled, resolve } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, staleTime: Infinity }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()

      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      // A second write lands while the first refetch is in flight. That
      // refetch may have read the data before the write, so it must not be
      // the one that clears the invalidation.
      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(3)
      expect(cancelled()).toBe(1)
      expect(inFlight()).toBe(1)

      resolve('v3')
      fixture.detectChanges()

      expect(result.data()).toBe('v3')
    })

    it('refetches again when invalidated as the refetch resolves', () => {
      const { queryFn, inFlight, resolve } = requests<string>()
      const { fixture } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, staleTime: Infinity }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()

      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      // The response and the next invalidation both arrive before change
      // detection runs again.
      resolve('v2')
      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(3)
      expect(inFlight()).toBe(1)
    })

    it('does not refetch for a disabled observer until it is enabled', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('fresh'))

      client.setQueryData(['todo', 1], 'cached')

      @Component({ selector: 'app-host', template: '' })
      class Host {
        readonly id = input.required<number>()

        readonly result = injectQuery(() => ({
          queryKey: ['todo', this.id()],
          queryFn,
          staleTime: Infinity,
          enabled: this.enabled(),
        }))

        // Declared after the query on purpose: it doesn't exist yet while the
        // query is being created.
        readonly enabled = signal(false)
      }

      @Component({ imports: [Host], template: '<app-host [id]="1" />' })
      class Parent {
        readonly host = viewChild.required(Host)
      }

      const fixture = TestBed.createComponent(Parent)

      fixture.detectChanges()

      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()

      expect(queryFn).not.toHaveBeenCalled()

      fixture.componentInstance.host().enabled.set(true)
      fixture.detectChanges()

      // The cached data is fresh for staleTime: Infinity, so only the pending
      // invalidation can make it fetch now.
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(fixture.componentInstance.host().result.data()).toBe('fresh')
    })

    it('refetches an invalidated query once a component uses it', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('fresh'))

      client.setQueryData(['todo', 1], 'cached')
      client.invalidateQueries({ queryKey: ['todo', 1] })

      const { result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, staleTime: Infinity }),
        1,
      )

      // Fresh for staleTime: Infinity, so only the invalidation makes it
      // fetch on mount.
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result.data()).toBe('fresh')
    })

    it('leaves the previous key alone when invalidated before the key switch', () => {
      // The key reads a plain signal, not an input: an input only changes
      // with change detection, and this has to happen before it.
      const id = signal(1)
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake(() => of(`v${id()}`))
      const { fixture } = mount(() => ({
        queryKey: ['item', id()],
        queryFn,
        staleTime: Infinity,
      }))

      // The key has moved on, but change detection hasn't switched the
      // observer to it yet: queryFn now fetches item 2.
      id.set(2)
      client.invalidateQueries({ queryKey: ['item', 1] })

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['item', 1])).toBe('v1')

      fixture.detectChanges()

      expect(client.getQueryData(['item', 1])).toBe('v1')
    })

    it('does not make an effect that invalidates track what queryFn reads', () => {
      const dep = signal(1)
      const queryFn = jasmine.createSpy('queryFn').and.callFake(() => of(dep()))
      let runs = 0

      @Component({ template: '' })
      class Host {
        readonly result = injectQuery(() => ({
          queryKey: ['dep'],
          queryFn,
          staleTime: Infinity,
        }))

        constructor() {
          // Stopped after 20 runs, so a loop fails the expectations rather
          // than hanging the test.
          effect(() => {
            runs++

            if (runs > 20) return

            client.invalidateQueries({ queryKey: ['dep'] })
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      // One on mount, one for the effect's invalidation.
      expect(queryFn).toHaveBeenCalledTimes(2)

      dep.set(2)
      fixture.detectChanges()

      expect(runs).toBe(1)
    })

    // invalidateQueries() resolves once the matching queries on screen have
    // their refetches back. Settled with no value is `{ value: undefined }`,
    // pending is `{}`.
    describe('invalidateQueries() promise', () => {
      it('resolves once every query on screen has its refetch back', fakeAsync(() => {
        const list = requests<string>()
        const count = requests<number>()

        mount(() => ({ queryKey: ['todos'], queryFn: list.queryFn }))
        mount(() => ({ queryKey: ['todos', 'count'], queryFn: count.queryFn }))
        list.resolve('a')
        count.resolve(1)

        const invalidated = settled(
          client.invalidateQueries({ queryKey: ['todos'] }),
        )

        list.resolve('b')
        flushMicrotasks()
        expect(invalidated).toEqual({})

        count.resolve(2)
        flushMicrotasks()
        expect(invalidated).toEqual({ value: undefined })
      }))

      it('resolves at once when no query on screen matches', fakeAsync(() => {
        const other = requests<string>()

        // On screen, still loading, under another key.
        mount(() => ({ queryKey: ['other'], queryFn: other.queryFn }))
        client.setQueryData(['todos'], 'cached')

        const invalidated = settled(
          client.invalidateQueries({ queryKey: ['todos'] }),
        )

        flushMicrotasks()

        expect(invalidated).toEqual({ value: undefined })
      }))

      it("doesn't reject when a refetch fails", fakeAsync(() => {
        const error = new Error('down')
        let fail = false
        const { result } = mount(() => ({
          queryKey: ['todos'],
          queryFn: () => (fail ? throwError(() => error) : of('a')),
          retry: false,
        }))

        fail = true

        const invalidated = settled(
          client.invalidateQueries({ queryKey: ['todos'] }),
        )

        flushMicrotasks()

        // The failure shows in the query, not in the promise.
        expect(invalidated).toEqual({ value: undefined })
        expect(result.error()).toBe(error)
      }))

      it('waits for the other refetches when one fails', fakeAsync(() => {
        const count = requests<number>()
        let fail = false

        mount(() => ({
          queryKey: ['todos'],
          queryFn: () => (fail ? throwError(() => new Error('down')) : of('a')),
          retry: false,
        }))
        mount(() => ({ queryKey: ['todos', 'count'], queryFn: count.queryFn }))
        count.resolve(1)
        fail = true

        const invalidated = settled(
          client.invalidateQueries({ queryKey: ['todos'] }),
        )

        flushMicrotasks()
        expect(invalidated).toEqual({})

        count.resolve(2)
        flushMicrotasks()
        expect(invalidated).toEqual({ value: undefined })
      }))

      it('waits for the refetch that replaces its own', fakeAsync(() => {
        const { queryFn, resolve, cancelled } = requests<string>()

        mount(() => ({ queryKey: ['todos'], queryFn }))
        resolve('a')

        const first = settled(client.invalidateQueries({ queryKey: ['todos'] }))
        // A second invalidation replaces the first one's refetch.
        const second = settled(
          client.invalidateQueries({ queryKey: ['todos'] }),
        )

        flushMicrotasks()
        expect(first).toEqual({})

        resolve('b')
        flushMicrotasks()

        expect(cancelled()).toBe(1)
        expect(first).toEqual({ value: undefined })
        expect(second).toEqual({ value: undefined })
      }))

      it("only marks the queries with refetchType: 'none'", fakeAsync(() => {
        const { queryFn, resolve } = requests<string>()

        mount(() => ({ queryKey: ['todos'], queryFn, staleTime: Infinity }))
        resolve('a')

        const invalidated = settled(
          client.invalidateQueries({
            queryKey: ['todos'],
            refetchType: 'none',
          }),
        )

        flushMicrotasks()

        expect(invalidated).toEqual({ value: undefined })
        expect(queryFn).toHaveBeenCalledTimes(1)

        // Marked stale, so the next component to show it refetches it,
        // although its staleTime would keep the data fresh.
        mount(() => ({ queryKey: ['todos'], queryFn, staleTime: Infinity }))

        expect(queryFn).toHaveBeenCalledTimes(2)
      }))

      it("doesn't surface a failed refetch nobody waits for as an unhandled rejection", fakeAsync(() => {
        let fail = false

        mount(() => ({
          queryKey: ['todos'],
          queryFn: () => (fail ? throwError(() => new Error('down')) : of('a')),
          retry: false,
        }))
        fail = true
        client.invalidateQueries({ queryKey: ['todos'] })

        // fakeAsync rethrows an unhandled rejection when microtasks run.
        expect(() => flushMicrotasks()).not.toThrow()
      }))
    })
  })

  // refetchQueries() refetches the matching queries on screen, fresh or not,
  // and leaves the rest as they are.
  describe('refetchQueries', () => {
    it('refetches a query on screen once, fresh as its data is', fakeAsync(() => {
      const { queryFn, resolve } = requests<string>()
      const { results } = mountMany(2, () => ({
        queryKey: ['todos'],
        queryFn,
        staleTime: Infinity,
      }))

      resolve('a')

      const refetched = settled(client.refetchQueries({ queryKey: ['todos'] }))

      // Two components show it, one request.
      expect(queryFn).toHaveBeenCalledTimes(2)

      flushMicrotasks()
      expect(refetched).toEqual({})

      resolve('b')
      flushMicrotasks()

      expect(refetched).toEqual({ value: undefined })
      expect(results[0].data()).toBe('b')
    }))

    it('refetches only the queries the filter matches', fakeAsync(() => {
      const todos = jasmine.createSpy('todos').and.returnValue(of('a'))
      const user = jasmine.createSpy('user').and.returnValue(of('Ann'))

      mount(() => ({
        queryKey: ['todos'],
        queryFn: todos,
        staleTime: Infinity,
      }))
      mount(() => ({ queryKey: ['user'], queryFn: user, staleTime: Infinity }))
      client.refetchQueries({ queryKey: ['todos'] })

      expect(todos).toHaveBeenCalledTimes(2)
      expect(user).toHaveBeenCalledTimes(1)
    }))

    it('leaves a query nobody shows alone, not even marked stale', fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('a'))

      client.setQueryData(['todos'], 'cached')

      const refetched = settled(client.refetchQueries({ queryKey: ['todos'] }))

      flushMicrotasks()

      expect(refetched).toEqual({ value: undefined })

      // Its data is still fresh for a component that keeps data fresh for
      // long, so showing it fetches nothing.
      mount(() => ({ queryKey: ['todos'], queryFn, staleTime: Infinity }))

      expect(queryFn).not.toHaveBeenCalled()
    }))

    it('skips a query whose components are all disabled', fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('a'))

      mount(() => ({ queryKey: ['todos'], queryFn, enabled: false }))

      const refetched = settled(client.refetchQueries({ queryKey: ['todos'] }))

      flushMicrotasks()

      expect(refetched).toEqual({ value: undefined })
      expect(queryFn).not.toHaveBeenCalled()
    }))

    it('replaces a fetch in flight', fakeAsync(() => {
      const { queryFn, resolve, cancelled } = requests<string>()

      // The first load is still in flight.
      mount(() => ({ queryKey: ['todos'], queryFn }))

      const refetched = settled(client.refetchQueries({ queryKey: ['todos'] }))

      resolve('b')
      flushMicrotasks()

      expect(cancelled()).toBe(1)
      expect(refetched).toEqual({ value: undefined })
    }))

    it("doesn't reject when a refetch fails", fakeAsync(() => {
      const error = new Error('down')
      let fail = false
      const { result } = mount(() => ({
        queryKey: ['todos'],
        queryFn: () => (fail ? throwError(() => error) : of('a')),
        retry: false,
      }))

      fail = true

      const refetched = settled(client.refetchQueries({ queryKey: ['todos'] }))

      flushMicrotasks()

      // The failure shows in the query, not in the promise.
      expect(refetched).toEqual({ value: undefined })
      expect(result.error()).toBe(error)
    }))
  })

  // A query that failed before it had any data reads like a first load while
  // it's tried again: 'pending', loading, no error. One that has data keeps
  // it, and its error, while it refetches.
  describe('after a failed fetch', () => {
    it("goes back to 'pending' with no error while refetch() tries again", () => {
      const { queryFn, fail } = requests<string>()
      const { result } = mount(() => ({
        queryKey: ['todos'],
        queryFn,
        retry: false,
      }))

      fail(new Error('first'))
      result.refetch()

      expect(result.status()).toBe('pending')
      expect(result.isLoading()).toBe(true)
      expect(result.isError()).toBe(false)
      expect(result.error()).toBeNull()
      expect(result.isFetching()).toBe(true)

      const second = new Error('second')

      fail(second)

      expect(result.status()).toBe('error')
      expect(result.error()).toBe(second)
    })

    it('reads as loading in every component while invalidateQueries() refetches it', () => {
      const { queryFn, fail, resolve } = requests<string>()
      const { results } = mountMany(
        2,
        (id) => ({ queryKey: ['todo', id()], queryFn, retry: false }),
        1,
      )

      fail(new Error('down'))
      client.invalidateQueries({ queryKey: ['todo'] })

      // One request for both components.
      expect(queryFn).toHaveBeenCalledTimes(2)

      for (const result of results) {
        expect(result.isLoading()).toBe(true)
        expect(result.error()).toBeNull()
      }

      resolve('a')

      for (const result of results) {
        expect(result.data()).toBe('a')
      }
    })

    it('renders as loading, not with the old error, in a component that starts showing it', () => {
      const { queryFn, fail } = requests<string>()

      @Component({
        selector: 'app-todo',
        template: `
          @if (todo.isLoading()) {
            Loading…
          } @else if (todo.isError()) {
            Failed: {{ todo.error()?.message }}
          } @else {
            {{ todo.data() }}
          }
        `,
      })
      class TodoView {
        readonly id = input.required<number>()
        readonly todo = injectQuery(() => ({
          queryKey: ['todo', this.id()],
          queryFn,
          retry: false,
        }))
      }

      @Component({
        imports: [TodoView],
        template: '@if (shown()) { <app-todo [id]="1" /> }',
      })
      class Page {
        readonly shown = signal(true)
      }

      const fixture = TestBed.createComponent(Page)
      const text = (): string => fixture.nativeElement.textContent.trim()

      fixture.detectChanges()
      fail(new Error('down'))
      fixture.detectChanges()

      expect(text()).toBe('Failed: down')

      // The user leaves the page and comes back to it.
      fixture.componentInstance.shown.set(false)
      fixture.detectChanges()
      fixture.componentInstance.shown.set(true)
      fixture.detectChanges()

      // The first render already shows the new attempt.
      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(text()).toBe('Loading…')
    })

    it('reads as loading while coming back to the tab refetches it', () => {
      const { queryFn, fail } = requests<string>()
      const { fixture, result } = mount(() => ({
        queryKey: ['todos'],
        queryFn,
        retry: false,
      }))

      fail(new Error('down'))
      leaveAndComeBack()
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(result.isLoading()).toBe(true)
      expect(result.error()).toBeNull()
    })

    it('shows placeholderData while it is tried again', () => {
      const { queryFn, fail } = requests<string>()
      const { result } = mount(() => ({
        queryKey: ['todos'],
        queryFn,
        retry: false,
        placeholderData: 'placeholder',
      }))

      fail(new Error('down'))
      result.refetch()

      expect(result.data()).toBe('placeholder')
      expect(result.isPlaceholderData()).toBe(true)
      expect(result.status()).toBe('success')
    })

    it("keeps its data, 'error' and the error while it refetches, if it has data", () => {
      const { queryFn, resolve, fail } = requests<string>()
      const { result } = mount(() => ({
        queryKey: ['todos'],
        queryFn,
        retry: false,
      }))
      const error = new Error('down')

      resolve('a')
      result.refetch()
      fail(error)
      result.refetch()

      expect(result.status()).toBe('error')
      expect(result.data()).toBe('a')
      expect(result.error()).toBe(error)
      expect(result.isLoading()).toBe(false)
      expect(result.isFetching()).toBe(true)

      resolve('b')

      expect(result.status()).toBe('success')
      expect(result.data()).toBe('b')
      expect(result.error()).toBeNull()
    })

    // A new attempt stopped with nothing in its place leaves the query as it
    // was before the attempt, apart from what was written into it meanwhile.
    describe('when the new attempt is stopped', () => {
      it('shows the error again, with its failure count, after cancelQueries()', fakeAsync(() => {
        const { queryFn, fail } = requests<string>()
        const { result } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: false,
        }))
        const error = new Error('down')

        fail(error)

        const refetched = settled(result.refetch())

        client.cancelQueries({ queryKey: ['todos'] })
        flushMicrotasks()

        expect(result.status()).toBe('error')
        expect(result.error()).toBe(error)
        expect(result.failureCount()).toBe(1)
        expect(result.failureReason()).toBe(error)
        expect(result.isFetching()).toBe(false)
        expect(refetched.value).toEqual({ data: undefined, error })
      }))

      it('keeps what setQueryData() wrote meanwhile after cancelQueries()', () => {
        const { queryFn, fail } = requests<string>()
        const { result } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: false,
        }))

        fail(new Error('down'))
        result.refetch()
        client.setQueryData(['todos'], 'written')
        client.cancelQueries({ queryKey: ['todos'] })

        expect(result.status()).toBe('success')
        expect(result.data()).toBe('written')
        expect(result.error()).toBeNull()
      })

      it('keeps showing the error it had once removeQueries() drops it', () => {
        const { queryFn, fail } = requests<string>()
        const { result } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: false,
        }))
        const error = new Error('down')

        fail(error)
        result.refetch()
        client.removeQueries({ queryKey: ['todos'] })

        expect(result.status()).toBe('error')
        expect(result.error()).toBe(error)
        expect(result.failureCount()).toBe(1)
        expect(result.isFetching()).toBe(false)
      })
    })
  })

  describe('options re-evaluation', () => {
    it('does not refetch when the options change but the key does not', () => {
      const version = signal(1)
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { fixture } = mount(() => ({
        queryKey: ['same'],
        queryFn,
        // Read in the options but not part of the key.
        retry: version(),
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)

      // staleTime defaults to 0, so the data is stale: a refetch here could
      // only come from the options object having been rebuilt.
      version.set(2)
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('uses the latest options when the key does change', fakeAsync(() => {
      const id = signal(1)
      const retry = signal(0)
      // Item 2 is down, so retry decides how often it's asked for.
      const fetchItem = jasmine
        .createSpy('fetchItem')
        .and.callFake((item: number) =>
          item === 1 ? of(1) : throwError(() => new Error('down')),
        )
      const { fixture } = mount(() => ({
        queryKey: ['item', id()],
        queryFn: () => fetchItem(id()),
        retry: retry(),
        retryDelay: 10,
      }))

      retry.set(5)
      id.set(2)
      fixture.detectChanges()
      tick(50)

      // Item 1 on mount; item 2 once, then the 5 retries the new options ask
      // for.
      expect(fetchItem.calls.allArgs().flat()).toEqual([1, 2, 2, 2, 2, 2, 2])
    }))
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

  // The last component showing a query leaves while its request is in
  // flight: it's destroyed, or its key moves on. Unsubscribing aborts an
  // Observable request, so that one stops. A promise can't be aborted: its
  // request runs to the end, and the response is kept for whoever shows the
  // key next. Nobody is left to want a failure tried again.
  describe('leaving while a request is in flight', () => {
    describe('with an Observable', () => {
      it('aborts the request and goes back to how it was before it', () => {
        const { queryFn, inFlight, cancelled } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        fixture.destroy()

        expect(cancelled()).toBe(1)
        expect(inFlight()).toBe(0)
        expect(client.getQueryCache().get(['todos'])?.state()).toEqual(
          jasmine.objectContaining({ status: 'pending', isFetching: false }),
        )
      })

      it('aborts the request of the key it moves away from', () => {
        const { queryFn, inFlight, cancelled } = requests<string>()
        const { fixture, value } = mount(
          (id) => ({ queryKey: ['todo', id()], queryFn }),
          1,
        )

        value.set(2)
        fixture.detectChanges()

        // Todo 1's request is aborted, todo 2's is in flight.
        expect(cancelled()).toBe(1)
        expect(inFlight()).toBe(1)
      })

      it('stops waiting for a retry at once', fakeAsync(() => {
        const { queryFn, fail } = requests<string>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: 3,
          retryDelay: 100,
        }))

        fail(new Error('down'))
        tick(50)
        fixture.destroy()

        expect(client.isFetching()).toBe(0)

        tick(1000)

        expect(queryFn).toHaveBeenCalledTimes(1)
      }))
    })

    describe('with a promise', () => {
      it('keeps the response and shows it at once when the key is shown again', fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()
        const options = (): QueryOptions<string> => ({
          queryKey: ['todos'],
          queryFn,
        })

        // The user leaves the page before the list loads...
        mount(options).fixture.destroy()
        requests[0].resolve('a')
        flushMicrotasks()

        // ...and comes back to it.
        const { result } = mount(options)

        expect(result.data()).toBe('a')
        expect(result.isLoading()).toBe(false)
      }))

      it('keeps the response of the key it moves away from', fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()
        const { fixture, result, value } = mount(
          (id) => ({ queryKey: ['todo', id()], queryFn }),
          1,
        )

        // The user picks todo 2 before todo 1 loads...
        value.set(2)
        fixture.detectChanges()
        requests[0].resolve('todo 1')
        requests[1].resolve('todo 2')
        flushMicrotasks()

        // ...then goes back to todo 1.
        value.set(1)
        fixture.detectChanges()

        expect(result.data()).toBe('todo 1')
      }))

      it('joins the request when the key is shown again before it lands, retries included', fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()
        const options = (): QueryOptions<string> => ({
          queryKey: ['todos'],
          queryFn,
          retry: 1,
          retryDelay: 100,
        })

        mount(options).fixture.destroy()

        const { result } = mount(options)

        // It waits for the request in flight rather than sending another.
        expect(queryFn).toHaveBeenCalledTimes(1)

        // The component showing the key wants the data, so a failure is
        // tried again.
        requests[0].reject(new Error('down'))
        tick(100)

        expect(queryFn).toHaveBeenCalledTimes(2)

        requests[1].resolve('a')
        flushMicrotasks()

        expect(result.data()).toBe('a')
      }))

      it('counts as fetching until the response lands', fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()

        mount(() => ({ queryKey: ['todos'], queryFn })).fixture.destroy()

        expect(client.isFetching()).toBe(1)

        requests[0].resolve('a')
        flushMicrotasks()

        expect(client.isFetching()).toBe(0)
      }))

      it("doesn't try a failure again once nothing shows the key", fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()
        const error = new Error('down')

        mount(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: 3,
          retryDelay: 100,
        })).fixture.destroy()
        requests[0].reject(error)
        flushMicrotasks()

        // It fails at once, with no wait for a retry.
        expect(client.getQueryCache().get(['todos'])?.state()).toEqual(
          jasmine.objectContaining({
            status: 'error',
            error,
            isFetching: false,
          }),
        )

        tick(1000)

        expect(queryFn).toHaveBeenCalledTimes(1)
      }))

      it('fails with the last error once the wait for a retry is over, without trying again', fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()
        const error = new Error('down')
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: 3,
          retryDelay: 100,
        }))

        // The first request fails, and the user leaves halfway through the
        // wait for the retry.
        requests[0].reject(error)
        tick(50)
        fixture.destroy()

        // The key may still be shown again in time for the retry.
        expect(client.isFetching()).toBe(1)

        tick(50)

        expect(queryFn).toHaveBeenCalledTimes(1)
        expect(client.getQueryCache().get(['todos'])?.state()).toEqual(
          jasmine.objectContaining({
            status: 'error',
            error,
            failureCount: 1,
            isFetching: false,
          }),
        )
      }))

      it('tries again on schedule when the key is shown again during the wait for a retry', fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()
        const options = (): QueryOptions<string> => ({
          queryKey: ['todos'],
          queryFn,
          retry: 3,
          retryDelay: 100,
        })
        const { fixture } = mount(options)

        requests[0].reject(new Error('down'))
        tick(30)
        fixture.destroy()
        tick(20)

        const { result } = mount(options)

        // It joins the wait rather than sending a request at once...
        expect(queryFn).toHaveBeenCalledTimes(1)

        // ...and the retry goes out when it was due.
        tick(50)
        expect(queryFn).toHaveBeenCalledTimes(2)

        requests[1].resolve('a')
        flushMicrotasks()

        expect(result.data()).toBe('a')
      }))

      it('tries a failure of a later request again as usual', fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()
        const options = (): QueryOptions<string> => ({
          queryKey: ['todos'],
          queryFn,
          retry: 1,
          retryDelay: 100,
        })

        mount(options).fixture.destroy()
        requests[0].resolve('a')
        flushMicrotasks()

        // Shown again, its stale data is refetched, and that request fails.
        mount(options)
        requests[1].reject(new Error('down'))
        tick(100)

        expect(queryFn).toHaveBeenCalledTimes(3)
      }))

      it('drops the response once cancelQueries() stops the request', fakeAsync(() => {
        const { queryFn, requests } = promiseRequests<string>()

        mount(() => ({ queryKey: ['todos'], queryFn })).fixture.destroy()
        client.cancelQueries({ queryKey: ['todos'] })
        requests[0].resolve('a')
        flushMicrotasks()

        expect(client.getQueryData(['todos'])).toBeUndefined()
        expect(client.isFetching()).toBe(0)
      }))
    })
  })

  // A queryFn that reads its key's value when it runs, as
  // `() => api(this.id())` does, asks for whatever the signal holds by then.
  // A retry of a key must still ask for that key, whichever component's
  // queryFn it runs and wherever that component has moved by then.
  describe('retrying a key a component moved away from', () => {
    const retryOptions = { retry: 1, retryDelay: 100 }

    // A panel showing the todo its `id` input names: its queryFn reads the
    // input when it runs. Mounted on todo 1.
    function panel(api: (id: number) => Promise<string>) {
      return mount(
        (id) => ({
          queryKey: ['todo', id()],
          queryFn: () => api(id()),
          ...retryOptions,
        }),
        1,
      )
    }

    // A widget pinned to todo 1.
    function widget(api: (id: number) => Promise<string>) {
      return mount(() => ({
        queryKey: ['todo', 1],
        queryFn: () => api(1),
        ...retryOptions,
      }))
    }

    it('asks for the key the components still showing it are on', fakeAsync(() => {
      const { queryFn: api, requests } = promiseRequests<string>()
      const shown = panel(api)
      const pinned = widget(api)

      // Todo 1's request fails while both show it, and the panel moves on to
      // todo 2 before the retry.
      requests[0].reject(new Error('down'))
      tick(50)
      shown.value.set(2)
      shown.fixture.detectChanges()
      requests[1].resolve('todo 2')
      tick(50)

      expect(api.calls.allArgs()).toEqual([[1], [2], [1]])

      requests[2].resolve('todo 1')
      flushMicrotasks()

      expect(pinned.result.data()).toBe('todo 1')
    }))

    it('asks for that key when the component that joined the request last moved away', fakeAsync(() => {
      const { queryFn: api, requests } = promiseRequests<string>()
      const pinned = widget(api)
      const shown = panel(api)

      requests[0].reject(new Error('down'))
      tick(50)
      shown.value.set(2)
      shown.fixture.detectChanges()
      requests[1].resolve('todo 2')
      tick(50)

      expect(api.calls.allArgs()).toEqual([[1], [2], [1]])

      requests[2].resolve('todo 1')
      flushMicrotasks()

      expect(pinned.result.data()).toBe('todo 1')
    }))

    it('asks for that key when a component shows it after the one that started the request moved away', fakeAsync(() => {
      const { queryFn: api, requests } = promiseRequests<string>()
      const shown = panel(api)

      // The panel moves on to todo 2 while todo 1's request is in flight,
      // then a widget pinned to todo 1 shows up, and that request fails.
      shown.value.set(2)
      shown.fixture.detectChanges()

      const pinned = widget(api)

      requests[0].reject(new Error('down'))
      tick(100)

      expect(api.calls.allArgs()).toEqual([[1], [2], [1]])

      requests[2].resolve('todo 1')
      flushMicrotasks()

      expect(pinned.result.data()).toBe('todo 1')
    }))

    it('asks for that key when fetchQuery() waits for it after the component that started the request moved away', fakeAsync(() => {
      const { queryFn: api, requests } = promiseRequests<string>()
      const shown = panel(api)

      shown.value.set(2)
      shown.fixture.detectChanges()

      // E.g. hovering a link to todo 1 prefetches it, and todo 1's request
      // fails.
      const prefetched = settled(client.fetchQuery(['todo', 1], () => api(1)))

      requests[0].reject(new Error('down'))
      tick(100)

      expect(api.calls.allArgs()).toEqual([[1], [2], [1]])

      requests[2].resolve('todo 1')
      flushMicrotasks()

      expect(prefetched.value).toBe('todo 1')
    }))
  })

  describe('after removeQueries', () => {
    // A component showing the removed key may keep what it shows: nothing
    // puts the key back on its own. Once something does, it shows what the
    // cache holds, as after a key change.

    it('keeps its data and brings nothing back on its own', () => {
      const { queryFn, resolve } = requests<string>()
      const { fixture, result } = mount(
        // At the default staleTime the data is stale at once, so anything
        // that refetched it after the removal would show up.
        (id) => ({ queryKey: ['todo', id()], queryFn }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()
      client.removeQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()

      expect(result.data()).toBe('v1')
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(client.getQueryCache().get(['todo', 1])).toBeUndefined()
    })

    it('stays without data when removed during its first load', () => {
      const { queryFn, inFlight, cancelled } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn }),
        1,
      )

      client.removeQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()

      // The removal cancels the request, and nothing sends another.
      expect(cancelled()).toBe(1)
      expect(inFlight()).toBe(0)
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result.isPending()).toBe(true)
      expect(result.isFetching()).toBe(false)
    })

    it('shows the refetched data once refetch() brings the key back', () => {
      const { queryFn, resolve } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, staleTime: Infinity }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()
      client.removeQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      result.refetch()
      fixture.detectChanges()
      resolve('v2')
      fixture.detectChanges()

      expect(result.data()).toBe('v2')
      expect(client.getQueryData(['todo', 1])).toBe('v2')
      expect(queryFn).toHaveBeenCalledTimes(2)
    })

    it('shows what setQueryData writes', () => {
      const { queryFn, resolve } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, staleTime: Infinity }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()
      client.removeQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      client.setQueryData(['todo', 1], 'edited')
      fixture.detectChanges()

      expect(result.data()).toBe('edited')
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    it('refetches on invalidateQueries once the key is back', () => {
      const { queryFn, resolve } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, staleTime: Infinity }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()
      client.removeQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      client.setQueryData(['todo', 1], 'edited')
      fixture.detectChanges()
      client.invalidateQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(2)

      resolve('v2')
      fixture.detectChanges()

      expect(result.data()).toBe('v2')
    })

    it('shows the same data as a component mounted after the removal', () => {
      const { queryFn, resolve } = requests<string>()
      const options = (id: Signal<number>): QueryOptions<string> => ({
        queryKey: ['todo', id()],
        queryFn,
        staleTime: Infinity,
      })
      const a = mount(options, 1)

      resolve('v1')
      a.fixture.detectChanges()
      client.removeQueries({ queryKey: ['todo', 1] })
      a.fixture.detectChanges()

      // The new component fetches the key; its request is still in flight
      // when the first one follows the key, which sends none of its own.
      const b = mount(options, 1)

      a.fixture.detectChanges()
      resolve('v2')
      a.fixture.detectChanges()
      b.fixture.detectChanges()

      expect(a.result.data()).toBe('v2')
      expect(b.result.data()).toBe('v2')
      expect(queryFn).toHaveBeenCalledTimes(2)
    })

    it('follows the key back with every component on it, in one request', () => {
      const { queryFn, inFlight, resolve } = requests<string>()
      const { fixture, results } = mountMany(
        3,
        (id) => ({ queryKey: ['todo', id()], queryFn, staleTime: Infinity }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()
      client.removeQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      results[0].refetch()
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(inFlight()).toBe(1)

      resolve('v2')
      fixture.detectChanges()

      expect(results.map((result) => result.data())).toEqual(['v2', 'v2', 'v2'])
    })

    it('keeps the removed data as previous data while the key reloads', () => {
      const { queryFn, resolve } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({
          queryKey: ['todo', id()],
          queryFn,
          staleTime: Infinity,
          placeholderData: keepPreviousData,
        }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()
      client.removeQueries({ queryKey: ['todo', 1] })
      fixture.detectChanges()
      result.refetch()
      fixture.detectChanges()

      expect(result.data()).toBe('v1')
      expect(result.isPlaceholderData()).toBe(true)
      expect(result.isFetching()).toBe(true)

      resolve('v2')
      fixture.detectChanges()

      expect(result.data()).toBe('v2')
      expect(result.isPlaceholderData()).toBe(false)
    })

    it('seeds initialData into the entry it follows, as on a key change', () => {
      const { queryFn, resolve } = requests<string>()
      const a = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, initialData: 'seed' }),
        1,
      )

      // The seed is stale at once: replaced by the fetch on mount.
      resolve('v1')
      a.fixture.detectChanges()
      client.removeQueries({ queryKey: ['todo', 1] })
      a.fixture.detectChanges()

      // Another component brings the key back with a request in flight.
      mount((id) => ({ queryKey: ['todo', id()], queryFn }), 1)
      a.fixture.detectChanges()

      expect(a.result.data()).toBe('seed')
      expect(queryFn).toHaveBeenCalledTimes(2)
    })

    it('polls the key back into the cache', fakeAsync(() => {
      const { queryFn, starts } = timed(30)
      const { fixture, result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, refetchInterval: 100 }),
        1,
      )

      elapse(50, fixture)
      client.removeQueries({ queryKey: ['todo', 1] })
      // The next poll is due 100 ms after the response at 30.
      elapse(150, fixture)

      expect(starts).toEqual([0, 130])
      expect(client.getQueryData(['todo', 1])).toBe(2)
      expect(result.data()).toBe(2)

      fixture.destroy()
    }))

    it('polls once per interval with a component mounted after the removal', fakeAsync(() => {
      const { queryFn, starts } = timed(30)
      const options = (id: Signal<number>): QueryOptions<number> => ({
        queryKey: ['todo', id()],
        queryFn,
        refetchInterval: 100,
      })
      const a = mount(options, 1)

      elapse(50, a.fixture)
      client.removeQueries({ queryKey: ['todo', 1] })

      // It fetches the key at once, and both poll it from then on.
      const b = mount(options, 1)

      elapse(400, a.fixture, b.fixture)

      // 100 ms after each response at 80, 210 and 340.
      expect(starts).toEqual([0, 50, 180, 310, 440])
      expect(a.result.data()).toBe(b.result.data())

      a.fixture.destroy()
      b.fixture.destroy()
    }))

    it('shows nothing once a sign-out removes the key it is gated on', () => {
      const signedIn = signal(true)
      const { queryFn, resolve } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({
          queryKey: ['todo', id()],
          queryFn,
          enabled: signedIn(),
        }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()
      signedIn.set(false)
      client.removeQueries()
      fixture.detectChanges()

      expect(result.data()).toBeUndefined()
      expect(queryFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('after clear()', () => {
    // clear() removes every query, as removeQueries() does.

    it('keeps its data, then shows what the cache holds once the key is back', () => {
      const { queryFn, resolve } = requests<string>()
      const { fixture, result } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn, staleTime: Infinity }),
        1,
      )

      resolve('v1')
      fixture.detectChanges()
      client.clear()
      fixture.detectChanges()

      expect(result.data()).toBe('v1')
      expect(client.getQueryData(['todo', 1])).toBeUndefined()

      client.setQueryData(['todo', 1], 'edited')
      fixture.detectChanges()

      expect(result.data()).toBe('edited')
      expect(queryFn).toHaveBeenCalledTimes(1)
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

      // staleTime defaults to 0 → the seed is stale at once → background
      // refetch, but the seeded data is shown meanwhile.
      expect(result.isSuccess()).toBe(true)
      expect(result.data()).toBe('init')
      expect(result.isFetching()).toBe(true)
      expect(result.isLoading()).toBe(false)

      subject.next('fresh')
      subject.complete()
      tick()

      expect(result.data()).toBe('fresh')
    }))

    it('honours staleTime for the seed (no refetch while fresh)', () => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.returnValue(of('fetched'))
      const { result } = mount(() => ({
        queryKey: ['id3'],
        queryFn,
        initialData: 'init',
        staleTime: 60_000,
      }))

      // The seed is stamped with the current time, so staleTime applies to it.
      expect(result.data()).toBe('init')
      expect(queryFn).not.toHaveBeenCalled()
    })

    it('refetches when initialDataUpdatedAt says the seed is old', () => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.returnValue(of('fetched'))
      const { result } = mount(() => ({
        queryKey: ['id4'],
        queryFn,
        initialData: 'init',
        initialDataUpdatedAt: Date.now() - 120_000, // two minutes ago
        staleTime: 60_000,
      }))

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result.data()).toBe('fetched')
    })

    it('seeds each new key, not just the first one', () => {
      // The fetch never resolves, so the data shown can only be the seed.
      const { fixture, result, value } = mount(
        (id) => ({
          queryKey: ['todo', id()],
          queryFn: () => new Subject<string>(),
          initialData: () => `seed-${id()}`,
        }),
        1,
      )

      expect(result.data()).toBe('seed-1')

      value.set(2)
      fixture.detectChanges()

      expect(result.data()).toBe('seed-2')
      expect(result.isSuccess()).toBe(true)
    })

    it('seeds a key that another component is loading for the first time', () => {
      const { queryFn } = requests<string>()
      const loading = mount(() => ({ queryKey: ['todo'], queryFn }))

      expect(loading.result.isLoading()).toBe(true)

      const seeded = mount(() => ({
        queryKey: ['todo'],
        queryFn,
        initialData: 'seed',
      }))

      // One query: both show the seed while the first load runs on.
      expect(seeded.result.data()).toBe('seed')
      expect(loading.result.data()).toBe('seed')
      expect(queryFn).toHaveBeenCalledTimes(1)
    })

    // A function that returns undefined has nothing to seed: the query loads
    // as if it had no initialData. That's how a detail query seeded from a
    // cached list skips a row the list lacks, or a list too old to trust.

    it('stays pending and fetches when the function returns undefined', () => {
      const { queryFn, resolve } = requests<string>()
      const { result } = mount(() => ({
        queryKey: ['todo'],
        queryFn,
        initialData: () => undefined,
      }))

      expect(result.status()).toBe('pending')
      expect(result.isLoading()).toBe(true)
      expect(queryFn).toHaveBeenCalledTimes(1)

      resolve('fetched')

      expect(result.data()).toBe('fetched')
    })

    it('fetches despite a staleTime when the function returns undefined', () => {
      const { queryFn, resolve } = requests<string>()
      const { result } = mount(() => ({
        queryKey: ['todo'],
        queryFn,
        initialData: () => undefined,
        // Nothing was seeded, so there's nothing to keep fresh.
        staleTime: 60_000,
      }))

      expect(result.status()).toBe('pending')
      expect(result.isLoading()).toBe(true)
      expect(queryFn).toHaveBeenCalledTimes(1)

      resolve('fetched')

      expect(result.data()).toBe('fetched')
    })

    it('seeds a row from a cached list and loads one the list lacks', () => {
      const { queryFn, resolve } = requests<Todo>()

      client.setQueryData<Todo[]>(['todos'], [{ id: 1, title: 'listed' }])

      // Explicit TData: a seed function that may return undefined must
      // type-check.
      const { fixture, result, value } = mount<Todo>(
        (id) => ({
          queryKey: ['todo', id()],
          queryFn,
          initialData: () =>
            client
              .getQueryData<Todo[]>(['todos'])
              ?.find((todo) => todo.id === id()),
          staleTime: 60_000,
        }),
        1,
      )

      expect(result.data()).toEqual({ id: 1, title: 'listed' })
      expect(queryFn).not.toHaveBeenCalled()

      value.set(3)
      fixture.detectChanges()

      expect(result.status()).toBe('pending')
      expect(result.isLoading()).toBe(true)
      expect(queryFn).toHaveBeenCalledTimes(1)

      resolve({ id: 3, title: 'fetched' })

      expect(result.data()).toEqual({ id: 3, title: 'fetched' })
    })

    it('seeds from a list only while it is fresh', fakeAsync(() => {
      const { queryFn, resolve } = requests<Todo>()

      client.setQueryData<Todo[]>(
        ['todos'],
        [
          { id: 1, title: 'listed' },
          { id: 2, title: 'listed' },
        ],
      )

      const { fixture, result, value } = mount<Todo>(
        (id) => ({
          queryKey: ['todo', id()],
          queryFn,
          // Older than 10 s? Don't seed: fetch instead.
          initialData: () => {
            const list = client.getQueryCache().get(['todos'])

            if (Date.now() - (list?.state().updatedAt ?? 0) > 10_000) {
              return undefined
            }

            return client
              .getQueryData<Todo[]>(['todos'])
              ?.find((todo) => todo.id === id())
          },
        }),
        1,
      )

      expect(result.data()).toEqual({ id: 1, title: 'listed' })

      tick(20_000)
      value.set(2)
      fixture.detectChanges()

      expect(result.status()).toBe('pending')
      expect(result.isLoading()).toBe(true)

      resolve({ id: 2, title: 'fetched' })

      expect(result.data()).toEqual({ id: 2, title: 'fetched' })
    }))

    it('seeds null: only undefined means no initial data', () => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.returnValue(of('fetched'))
      const { result } = mount(() => ({
        queryKey: ['todo'],
        queryFn,
        initialData: () => null,
        staleTime: Infinity,
      }))

      expect(result.status()).toBe('success')
      expect(result.data()).toBeNull()
      expect(queryFn).not.toHaveBeenCalled()
    })

    it("doesn't call the function for a key that already has data", () => {
      const initialData = jasmine
        .createSpy('initialData')
        .and.returnValue('seed')

      client.setQueryData(['todo'], 'cached')

      const { fixture, result, value } = mount((filter) => {
        // Read only so that changing it re-evaluates the options.
        filter()

        return {
          queryKey: ['todo'],
          queryFn: () => of('fetched'),
          initialData,
          staleTime: Infinity,
        }
      }, 'a')

      value.set('b')
      fixture.detectChanges()

      expect(result.data()).toBe('cached')
      expect(initialData).not.toHaveBeenCalled()
    })

    it("doesn't seed a key whose data is null: only undefined means no data", () => {
      client.setQueryData<string | null>(['todo'], null)

      const { result } = mount<string | null>(() => ({
        queryKey: ['todo'],
        queryFn: () => new Subject<string | null>(),
        initialData: 'seed',
      }))

      expect(result.data()).toBeNull()
    })

    // A query whose fetch failed before it had any data has none to show
    // either, so it's seeded as a new one is. Say a detail opened while
    // offline is opened again once the list has loaded.
    describe('a key whose last fetch failed before it had data', () => {
      // Shows the key in a component whose request fails, then leaves: the
      // query stays in the cache, in 'error' with no data.
      function failedEarlier(key: QueryKey): void {
        const { fixture, result } = mount(() => ({
          queryKey: key,
          queryFn: () => throwError(() => new Error('offline')),
          retry: false,
        }))

        expect(result.status()).toBe('error')
        fixture.destroy()
      }

      it('is seeded, and refetched in the background', () => {
        failedEarlier(['todo', 1])

        const { queryFn } = requests<string>()
        const { result } = mount(() => ({
          queryKey: ['todo', 1],
          queryFn,
          initialData: 'from the list',
        }))

        expect(result.status()).toBe('success')
        expect(result.data()).toBe('from the list')
        expect(result.error()).toBeNull()
        // The seed is stale at the default staleTime: it shows while the
        // refetch runs.
        expect(result.isFetching()).toBe(true)
        expect(result.isLoading()).toBe(false)
        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it('shows a row from a list that has loaded since, even when the request fails again', () => {
        const error = new Error('offline')
        const detail = (id: Signal<number>): QueryOptions<Todo> => ({
          queryKey: ['todo', id()],
          queryFn: () => throwError(() => error),
          retry: false,
          initialData: () =>
            client
              .getQueryData<Todo[]>(['todos'])
              ?.find((todo) => todo.id === id()),
        })

        // Opened before the list loaded: nothing to seed, and the request
        // fails.
        const first = mount<Todo>(detail, 1)

        expect(first.result.status()).toBe('error')
        first.fixture.destroy()

        client.setQueryData<Todo[]>(['todos'], [{ id: 1, title: 'listed' }])

        const { result } = mount<Todo>(detail, 1)

        expect(result.data()).toEqual({ id: 1, title: 'listed' })
        expect(result.error()).toBe(error)
      })

      it("isn't refetched while the seed is fresh", () => {
        failedEarlier(['todo', 1])

        const queryFn = jasmine
          .createSpy('queryFn')
          .and.returnValue(of('fetched'))
        const { result } = mount(() => ({
          queryKey: ['todo', 1],
          queryFn,
          initialData: 'from the list',
          staleTime: 60_000,
        }))

        expect(result.data()).toBe('from the list')
        expect(queryFn).not.toHaveBeenCalled()
      })

      it('is seeded when the component switches back to it', () => {
        const { queryFn, fail } = requests<Todo>()
        const { fixture, result, value } = mount<Todo>(
          (id) => ({
            queryKey: ['todo', id()],
            queryFn,
            retry: false,
            initialData: () =>
              client
                .getQueryData<Todo[]>(['todos'])
                ?.find((todo) => todo.id === id()),
          }),
          1,
        )

        fail(new Error('offline'))

        expect(result.status()).toBe('error')

        value.set(2)
        fixture.detectChanges()
        client.setQueryData<Todo[]>(['todos'], [{ id: 1, title: 'listed' }])
        value.set(1)
        fixture.detectChanges()

        expect(result.status()).toBe('success')
        expect(result.data()).toEqual({ id: 1, title: 'listed' })
        expect(result.isFetching()).toBe(true)
      })

      it("isn't seeded once it has data, even if its refetch failed", () => {
        client.setQueryData(['todo', 1], 'cached')

        const first = mount<string>(() => ({
          queryKey: ['todo', 1],
          queryFn: () => throwError(() => new Error('offline')),
          retry: false,
        }))

        expect(first.result.status()).toBe('error')
        first.fixture.destroy()

        const initialData = jasmine
          .createSpy('initialData')
          .and.returnValue('seed')
        const { result } = mount(() => ({
          queryKey: ['todo', 1],
          queryFn: () => new Subject<string>(),
          initialData,
        }))

        expect(result.data()).toBe('cached')
        expect(initialData).not.toHaveBeenCalled()
      })

      it('loads as it does now when the function returns undefined', () => {
        failedEarlier(['todo', 1])

        const { queryFn } = requests<string>()
        const { result } = mount(() => ({
          queryKey: ['todo', 1],
          queryFn,
          initialData: () => undefined,
          // Nothing was seeded, so there's nothing to keep fresh.
          staleTime: 60_000,
        }))

        expect(result.status()).toBe('pending')
        expect(result.isLoading()).toBe(true)
        expect(queryFn).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('placeholderData', () => {
    it('shows placeholder as success while pending, then real data', fakeAsync(() => {
      const subject = new Subject<string>()
      const { result } = mount(() => ({
        queryKey: ['ph'],
        queryFn: () => subject,
        placeholderData: 'placeholder',
      }))

      expect(result.status()).toBe('success')
      expect(result.data()).toBe('placeholder')
      expect(result.isPlaceholderData()).toBe(true)
      expect(result.isPending()).toBe(false)
      // The real fetch is still in flight; only the loading flag is masked.
      expect(result.isFetching()).toBe(true)
      expect(result.isLoading()).toBe(false)

      subject.next('real')
      subject.complete()
      tick()

      expect(result.data()).toBe('real')
      expect(result.isPlaceholderData()).toBe(false)
    }))

    it('does not write the placeholder to the cache', () => {
      mount(() => ({
        queryKey: ['ph-cache'],
        queryFn: () => new Subject<string>(),
        placeholderData: 'placeholder',
      }))

      expect(client.getQueryData(['ph-cache'])).toBeUndefined()
    })

    it('keepPreviousData keeps the old page while the next one loads', fakeAsync(() => {
      const page = signal(1)
      const subjects = new Map<number, Subject<string>>()
      const queryFn = jasmine.createSpy('queryFn').and.callFake(() => {
        const subject = new Subject<string>()

        subjects.set(page(), subject)

        return subject
      })

      const { fixture, result } = mount(() => ({
        queryKey: ['todos', page()],
        queryFn,
        placeholderData: keepPreviousData,
      }))

      subjects.get(1)!.next('page1')
      subjects.get(1)!.complete()
      tick()

      expect(result.data()).toBe('page1')

      page.set(2)
      fixture.detectChanges()

      // Page 2 is pending, but page 1 stays visible as placeholder.
      expect(result.data()).toBe('page1')
      expect(result.isPlaceholderData()).toBe(true)
      expect(result.isPending()).toBe(false)
      expect(result.isFetching()).toBe(true)

      subjects.get(2)!.next('page2')
      subjects.get(2)!.complete()
      tick()

      expect(result.data()).toBe('page2')
      expect(result.isPlaceholderData()).toBe(false)
    }))

    it('feeds the latest defined data to the placeholder function across keys', fakeAsync(() => {
      const page = signal(1)
      const subjects = new Map<number, Subject<string>>()
      const { fixture, result } = mount(() => ({
        queryKey: ['t', page()],
        queryFn: () => {
          const subject = new Subject<string>()

          subjects.set(page(), subject)

          return subject
        },
        placeholderData: keepPreviousData,
      }))

      subjects.get(1)!.next('page1')
      subjects.get(1)!.complete()
      tick()

      // Page 2 never resolves; page 3 must still fall back to page 1's data.
      page.set(2)
      fixture.detectChanges()
      page.set(3)
      fixture.detectChanges()

      expect(result.data()).toBe('page1')
      expect(result.isPlaceholderData()).toBe(true)
    }))

    it('stays pending when the placeholder function returns undefined', () => {
      const { result } = mount(() => ({
        queryKey: ['ph-undef'],
        queryFn: () => new Subject<string>(),
        // No previous data on first load → keepPreviousData yields undefined.
        placeholderData: keepPreviousData,
      }))

      expect(result.isPending()).toBe(true)
      expect(result.isLoading()).toBe(true)
      expect(result.data()).toBeUndefined()
      expect(result.isPlaceholderData()).toBe(false)
    })

    it('is ignored when initialData seeds the cache', () => {
      const { result } = mount(() => ({
        queryKey: ['ph-init'],
        queryFn: () => new Subject<string>(),
        initialData: 'init',
        placeholderData: 'placeholder',
        staleTime: Infinity,
      }))

      expect(result.data()).toBe('init')
      expect(result.isPlaceholderData()).toBe(false)
    })

    it("keeps the previous data while a key initialData can't seed loads", () => {
      const { queryFn, resolve } = requests<Todo>()

      client.setQueryData<Todo[]>(['todos'], [{ id: 1, title: 'listed' }])

      const { fixture, result, value } = mount(
        (id) => ({
          queryKey: ['todo', id()],
          queryFn,
          initialData: () =>
            client
              .getQueryData<Todo[]>(['todos'])
              ?.find((todo) => todo.id === id()),
          placeholderData: keepPreviousData,
          staleTime: 60_000,
        }),
        1,
      )

      value.set(3)
      fixture.detectChanges()

      expect(result.data()).toEqual({ id: 1, title: 'listed' })
      expect(result.isPlaceholderData()).toBe(true)

      resolve({ id: 3, title: 'fetched' })

      expect(result.data()).toEqual({ id: 3, title: 'fetched' })
      expect(result.isPlaceholderData()).toBe(false)
    })

    it('drops the placeholder when the query errors', () => {
      const err = new Error('boom')
      const { result } = mount<string>(() => ({
        queryKey: ['ph-err'],
        queryFn: () => throwError(() => err),
        placeholderData: 'placeholder',
        retry: false,
      }))

      expect(result.isError()).toBe(true)
      expect(result.data()).toBeUndefined()
      expect(result.isPlaceholderData()).toBe(false)
    })
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

    // The timer restarts when the observed query, enabled or the interval
    // changes, not whenever the options re-evaluate.
    describe('timer restarts', () => {
      it('keeps polling while a value the options read changes', fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of([]))
        // Only the status is part of the key, but the options read the whole
        // filter, which a search box changes on every keystroke.
        const { fixture, value } = mount(
          (filter) => ({
            queryKey: ['orders', filter().status],
            queryFn,
            refetchInterval: 100,
          }),
          { status: 'open', search: '' },
        )

        // A keystroke every 50 ms, twice per interval.
        for (const search of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
          tick(50)
          value.update((filter) => ({ ...filter, search }))
          fixture.detectChanges()
        }

        // 250 ms in: the fetch on mount, then polls at 100 and 200.
        expect(queryFn).toHaveBeenCalledTimes(3)

        fixture.destroy()
      }))

      it('restarts the timer when the interval changes', fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const { fixture, value } = mount(
          (interval) => ({
            queryKey: ['todos'],
            queryFn,
            refetchInterval: interval(),
          }),
          100,
        )

        tick(50)
        value.set(300)
        fixture.detectChanges()

        // The old 100 ms timer would have fired by now.
        tick(250)
        expect(queryFn).toHaveBeenCalledTimes(1)

        // 300 ms after the change.
        tick(50)
        expect(queryFn).toHaveBeenCalledTimes(2)

        fixture.destroy()
      }))

      it('stops polling while disabled and restarts the timer once enabled', fakeAsync(() => {
        const enabled = signal(true)
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
          // Fresh data: enabling the query doesn't fetch, only polling does.
          staleTime: Infinity,
          enabled: enabled(),
        }))

        tick(50)
        enabled.set(false)
        fixture.detectChanges()
        tick(200)
        expect(queryFn).toHaveBeenCalledTimes(1)

        enabled.set(true)
        fixture.detectChanges()

        // The timer from before disabling would fire here.
        tick(50)
        expect(queryFn).toHaveBeenCalledTimes(1)

        // 100 ms after enabling.
        tick(50)
        expect(queryFn).toHaveBeenCalledTimes(2)

        fixture.destroy()
      }))

      it('restarts the timer for the new key and stops polling the old one', fakeAsync(() => {
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.callFake((id: number) => of(id))
        const { fixture, value } = mount(
          (id) => ({
            queryKey: ['todo', id()],
            queryFn: () => queryFn(id()),
            refetchInterval: 100,
          }),
          1,
        )

        tick(50)
        value.set(2)
        fixture.detectChanges()

        // Todo 2 is fetched on the switch, and nothing is polled at 100.
        tick(50)
        expect(queryFn.calls.allArgs()).toEqual([[1], [2]])

        // 100 ms after the switch: todo 2 is polled, todo 1 isn't.
        tick(50)
        expect(queryFn.calls.allArgs()).toEqual([[1], [2], [2]])

        fixture.destroy()
      }))

      it('stops polling once the interval function turns false', fakeAsync(() => {
        let version = 0
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.callFake(() => of(++version))
        const { fixture } = mount<number>(() => ({
          queryKey: ['job'],
          queryFn,
          // Poll until the job reports done, in its third response.
          refetchInterval: ({ state }) =>
            (state.data ?? 0) >= 3 ? false : 100,
        }))

        elapse(500, fixture)

        expect(queryFn).toHaveBeenCalledTimes(3)

        fixture.destroy()
      }))

      it('resumes polling once the interval function returns a number again', fakeAsync(() => {
        let status = 'done'
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.callFake(() => of({ status }))
        const { fixture, result } = mount<{ status: string }>(() => ({
          queryKey: ['job'],
          queryFn,
          // Poll while the job runs.
          refetchInterval: ({ state }) =>
            state.data?.status === 'running' ? 100 : false,
        }))

        // Done on mount: nothing to poll.
        elapse(200, fixture)
        expect(queryFn).toHaveBeenCalledTimes(1)

        // A refetch finds the job running again.
        status = 'running'
        result.refetch()
        fixture.detectChanges()

        // Polled 100 and 200 ms after the refetch.
        tick(200)
        expect(queryFn).toHaveBeenCalledTimes(4)

        fixture.destroy()
      }))

      it('tracks the signals the interval function reads', fakeAsync(() => {
        const paused = signal(false)
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: () => (paused() ? false : 100),
        }))

        tick(50)
        paused.set(true)
        fixture.detectChanges()

        // Paused before the first poll was due.
        tick(200)
        expect(queryFn).toHaveBeenCalledTimes(1)

        paused.set(false)
        fixture.detectChanges()

        // 100 ms after resuming.
        tick(100)
        expect(queryFn).toHaveBeenCalledTimes(2)

        fixture.destroy()
      }))
    })

    // Each poll comes refetchInterval ms after the query's last update, as in
    // TanStack, which restarts the timer on every update. So a fetch made for
    // any reason (refetch(), an invalidation, another observer's poll) pushes
    // the next poll back.
    describe('cadence', () => {
      it('counts each poll from the last response', fakeAsync(() => {
        const { queryFn, starts } = timed(30)
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
        }))

        elapse(400, fixture)

        // Requests take 30 ms; each poll goes 100 ms after the response.
        expect(starts).toEqual([0, 130, 260, 390])

        fixture.destroy()
      }))

      it('counts each poll from the last response with an interval function', fakeAsync(() => {
        const { queryFn, starts } = timed(30)
        const { fixture } = mount<number>(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: () => 100,
        }))

        elapse(400, fixture)

        expect(starts).toEqual([0, 130, 260, 390])

        fixture.destroy()
      }))

      it('counts the next poll from a refetch in between', fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const { fixture, result } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
        }))

        tick(60)
        result.refetch()
        expect(queryFn).toHaveBeenCalledTimes(2)

        // The data is 40 ms old: no poll at 100.
        tick(40)
        expect(queryFn).toHaveBeenCalledTimes(2)

        // 100 ms after the refetch.
        tick(60)
        expect(queryFn).toHaveBeenCalledTimes(3)

        fixture.destroy()
      }))

      it('counts the next poll from an invalidation in between', fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
        }))

        tick(60)
        client.invalidateQueries({ queryKey: ['todos'] })
        expect(queryFn).toHaveBeenCalledTimes(2)

        // The data is 40 ms old: no poll at 100.
        tick(40)
        expect(queryFn).toHaveBeenCalledTimes(2)

        // 100 ms after the refetch.
        tick(60)
        expect(queryFn).toHaveBeenCalledTimes(3)

        fixture.destroy()
      }))

      it('counts the next poll from a cache write in between', fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
        }))

        tick(60)
        client.setQueryData(['todos'], 2)

        // The data is 40 ms old: no poll at 100.
        tick(40)
        expect(queryFn).toHaveBeenCalledTimes(1)

        // 100 ms after the write.
        tick(60)
        expect(queryFn).toHaveBeenCalledTimes(2)

        fixture.destroy()
      }))

      it('makes one request per interval for all observers of a key', fakeAsync(() => {
        // Two components polling the same key, the second one shown 50 ms
        // later: their timers are out of step.
        const { queryFn, starts } = timed(20)
        const options = (): QueryOptions<number> => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
        })
        const first = mount(options)

        elapse(50, first.fixture)

        const second = mount(options)

        elapse(400, first.fixture, second.fixture)

        // Each fetches on mount (staleTime 0). Then one poll 100 ms after
        // each response, whichever timer comes due first.
        expect(starts).toEqual([0, 50, 170, 290, 410])

        first.fixture.destroy()
        second.fixture.destroy()
      }))

      it("polls at the shortest interval among a key's observers, then at the next one once that observer is gone", fakeAsync(() => {
        const { queryFn, starts } = timed(30)
        const options = (interval: Signal<number>): QueryOptions<number> => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: interval(),
        })
        // Two components on one key, asking for different intervals.
        const fast = mount(options, 100)
        const slow = mount(options, 300)

        elapse(1000, fast.fixture, slow.fixture)

        // The 100 ms one sets the pace: the 300 ms one adds no requests.
        expect(starts).toEqual([0, 130, 260, 390, 520, 650, 780, 910])

        fast.fixture.destroy()
        elapse(1500, slow.fixture)

        // 300 ms after the last response (at 940), then every 330 ms.
        expect(starts.slice(8)).toEqual([1240, 1570, 1900, 2230])

        slow.fixture.destroy()
      }))

      it('joins a request still in flight instead of sending another', fakeAsync(() => {
        // The request hangs: polls that come due meanwhile mustn't pile up.
        const { queryFn, inFlight, cancelled } = requests<number>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
        }))

        elapse(350, fixture)

        expect(queryFn).toHaveBeenCalledTimes(1)
        expect(inFlight()).toBe(1)
        expect(cancelled()).toBe(0)

        fixture.destroy()
      }))

      it('keeps its schedule while requests fail', fakeAsync(() => {
        // Only new data pushes the next poll back: a request that fails
        // doesn't (TanStack counts from the failure).
        const start = Date.now()
        const starts: number[] = []
        const queryFn = jasmine.createSpy('queryFn').and.callFake(() => {
          starts.push(Date.now() - start)

          return timer(30).pipe(
            map(() => {
              throw new Error('down')
            }),
          )
        })
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
          retry: false,
        }))

        elapse(300, fixture)

        expect(starts).toEqual([0, 100, 200, 300])

        fixture.destroy()
      }))
    })

    // A change reaches the effects only with change detection, which a
    // zoneless app runs a moment after the signal write, so a poll can come
    // due in between. It has to go by the live options.
    describe('before change detection', () => {
      it("does not store the next key's data under the previous one", fakeAsync(() => {
        // The key reads a plain signal: an input only changes with change
        // detection, and this has to happen before it.
        const id = signal(1)
        const { fixture } = mount(() => ({
          queryKey: ['item', id()],
          queryFn: () => of(`v${id()}`),
          refetchInterval: 100,
        }))

        // The key has moved on, but change detection hasn't switched the
        // observer to it yet: queryFn already fetches item 2.
        id.set(2)
        tick(100)

        expect(client.getQueryData(['item', 1])).toBe('v1')

        fixture.destroy()
      }))

      it('does not poll once disabled', fakeAsync(() => {
        const enabled = signal(true)
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchInterval: 100,
          enabled: enabled(),
        }))

        enabled.set(false)
        tick(100)

        expect(queryFn).toHaveBeenCalledTimes(1)

        fixture.destroy()
      }))
    })

    it('does not poll without an interval, or with one no timer can hold', async () => {
      // false, 0 and no interval mean no polling. A browser runs a timer with
      // any of the other delays at once, over and over; TanStack skips
      // Infinity and negative intervals too. fakeAsync doesn't mimic the
      // browser here, hence real timers.
      const intervals: Array<number | false | undefined> = [
        false,
        0,
        undefined,
        Infinity,
        -1,
        2 ** 31,
      ]
      const fetched: typeof intervals = []
      const fixtures = intervals.map(
        (interval) =>
          mount(() => ({
            queryKey: ['todos', String(interval)],
            queryFn: () => {
              fetched.push(interval)

              return of(1)
            },
            refetchInterval: interval,
          })).fixture,
      )

      await new Promise((resolve) => setTimeout(resolve, 50))
      fixtures.forEach((fixture) => fixture.destroy())

      // Each fetched once, on mount.
      expect(fetched).toEqual(intervals)
    })

    // Nobody sees a hidden page, so its polls wait, unless the query asks to
    // keep polling there. The timer keeps its schedule meanwhile: coming back
    // refetches stale data at once, and otherwise the poll due next goes out.
    describe('in a hidden tab', () => {
      it("doesn't poll while the page is hidden", fakeAsync(() => {
        const { queryFn, starts } = timed(30)
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: 100,
        }))

        elapse(50, fixture)
        setVisibility('hidden')
        elapse(400, fixture)

        // Fetched on mount only.
        expect(starts).toEqual([0])

        fixture.destroy()
      }))

      it('refetches stale data as the page shows again, then polls an interval after that response', fakeAsync(() => {
        const { queryFn, starts } = timed(30)
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: 100,
        }))

        elapse(50, fixture)
        setVisibility('hidden')
        elapse(350, fixture)
        setVisibility('visible')
        elapse(200, fixture)

        // Back at 400: the refetch on coming back, then a poll 100 ms after
        // its response at 430.
        expect(starts).toEqual([0, 400, 530])

        fixture.destroy()
      }))

      it('polls when the next poll is due once the page shows again, without refetching on coming back', fakeAsync(() => {
        const { queryFn, starts } = timed(30)
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: 100,
          refetchOnWindowFocus: false,
        }))

        elapse(50, fixture)
        setVisibility('hidden')
        elapse(350, fixture)
        setVisibility('visible')
        elapse(150, fixture)

        // Back at 400. The polls due at 130, 230 and 330 were skipped, not
        // made up for at once, and the one due at 430 goes out.
        expect(starts).toEqual([0, 430])

        fixture.destroy()
      }))

      it('keeps polling with refetchIntervalInBackground', fakeAsync(() => {
        const { queryFn, starts } = timed(30)
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: 100,
          refetchIntervalInBackground: true,
        }))

        elapse(50, fixture)
        setVisibility('hidden')
        elapse(350, fixture)

        expect(starts).toEqual([0, 130, 260, 390])

        fixture.destroy()
      }))

      it('keeps polling with refetchIntervalInBackground set for the app', fakeAsync(() => {
        reprovide(
          provideQueryClient(
            withDefaultOptions({
              queries: { refetchIntervalInBackground: true },
            }),
          ),
        )

        const { queryFn, starts } = timed(30)
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: 100,
        }))

        elapse(50, fixture)
        setVisibility('hidden')
        elapse(350, fixture)

        expect(starts).toEqual([0, 130, 260, 390])

        fixture.destroy()
      }))

      it('reads refetchIntervalInBackground when a poll comes due', fakeAsync(() => {
        const background = signal(false)
        const { queryFn, starts } = timed(30)
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: 100,
          refetchIntervalInBackground: background(),
        }))

        elapse(50, fixture)
        setVisibility('hidden')
        elapse(250, fixture)
        background.set(true)
        elapse(100, fixture)

        // Turned on at 300: the poll due at 330 goes out, on the timer's
        // schedule, which the change didn't restart.
        expect(starts).toEqual([0, 330])

        fixture.destroy()
      }))

      it('polls in a page that is neither visible nor hidden', fakeAsync(() => {
        // jsdom, which many test setups run in, says 'prerender' unless it's
        // told to pretend to be visual.
        setVisibility('prerender' as DocumentVisibilityState)

        const { queryFn, starts } = timed(30)
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: 100,
        }))

        elapse(400, fixture)

        expect(starts).toEqual([0, 130, 260, 390])

        fixture.destroy()
      }))

      it('still loads a query that polls when it mounts in a hidden page, and refetches it on an invalidation', fakeAsync(() => {
        // Say a link opened in a background tab, and a push message
        // invalidating the data while the user is still elsewhere.
        setVisibility('hidden')

        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const { fixture, result } = mount(() => ({
          queryKey: ['prices'],
          queryFn,
          refetchInterval: 100,
        }))

        expect(result.data()).toBe(1)

        elapse(150, fixture)
        client.invalidateQueries({ queryKey: ['prices'] })
        elapse(150, fixture)

        // On mount and on the invalidation; no poll.
        expect(queryFn).toHaveBeenCalledTimes(2)

        fixture.destroy()
      }))
    })

    // The page shows one fetch: the browser polls once it takes over.
    describe('on the server', () => {
      beforeEach(() =>
        reprovide(provideQueryClient(), {
          provide: PLATFORM_ID,
          useValue: 'server',
        }),
      )

      it("doesn't poll, whatever the interval", fakeAsync(() => {
        const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
        const intervals = [100, () => 100]
        const fixtures = intervals.map(
          (interval, index) =>
            mount(() => ({
              queryKey: ['prices', index],
              queryFn,
              refetchInterval: interval,
            })).fixture,
        )

        elapse(1_000, ...fixtures)

        // Each fetched once, on mount.
        expect(queryFn).toHaveBeenCalledTimes(intervals.length)

        fixtures.forEach((fixture) => fixture.destroy())
      }))

      it('leaves no polling timer that would hold up a server render', () => {
        const { fixture } = mount(() => ({
          queryKey: ['prices'],
          queryFn: () => of(1),
          refetchInterval: 100,
        }))

        // With zone.js, a server render writes out the page only once no
        // timer is pending.
        expect(TestBed.inject(NgZone).hasPendingMacrotasks).toBe(false)

        fixture.destroy()
      })
    })
  })

  describe('focus and reconnect', () => {
    afterEach(restoreVisibility)

    describe('refetchOnWindowFocus', () => {
      it('refetches stale data when the user comes back to the page', () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture, result } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
        }))

        resolve('v1')
        fixture.detectChanges()

        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
        // The data on screen stays while the refetch runs.
        expect(result.data()).toBe('v1')
        expect(result.isFetching()).toBe(true)

        resolve('v2')
        fixture.detectChanges()

        expect(result.data()).toBe('v2')
      })

      it("doesn't refetch when the user leaves the page", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        resolve('v1')
        fixture.detectChanges()

        setVisibility('hidden')
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it("doesn't refetch on the window's focus event", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        resolve('v1')
        fixture.detectChanges()

        // It also fires when an alert or a file picker closes, or on coming
        // back from DevTools, with the user on the page all along.
        window.dispatchEvent(new Event('focus'))
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it("doesn't refetch fresh data", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          staleTime: Infinity,
        }))

        resolve('v1')
        fixture.detectChanges()

        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it("refetches fresh data too with 'always'", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          staleTime: Infinity,
          refetchOnWindowFocus: 'always',
        }))

        resolve('v1')
        fixture.detectChanges()

        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
      })

      it("doesn't refetch with false", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchOnWindowFocus: false,
        }))

        resolve('v1')
        fixture.detectChanges()

        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it('makes one request for all components showing the key', () => {
        const { queryFn, inFlight, cancelled, resolve } = requests<string>()
        const { fixture, results } = mountMany(3, () => ({
          queryKey: ['todos'],
          queryFn,
        }))

        resolve('v1')
        fixture.detectChanges()

        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
        expect(inFlight()).toBe(1)
        expect(cancelled()).toBe(0)

        resolve('v2')
        fixture.detectChanges()

        expect(results.map((result) => result.data())).toEqual([
          'v2',
          'v2',
          'v2',
        ])
      })

      it('keeps a request in flight instead of sending another', () => {
        const { queryFn, inFlight, cancelled } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        // The first load is still in flight.
        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
        expect(inFlight()).toBe(1)
        expect(cancelled()).toBe(0)
      })

      it('refetches when any of the components showing the key wants it', () => {
        const { queryFn, resolve } = requests<string>()
        const first = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchOnWindowFocus: false,
        }))

        resolve('v1')
        first.fixture.detectChanges()

        const second = mount(() => ({ queryKey: ['todos'], queryFn }))

        // The refetch the second component started on mount.
        resolve('v2')
        second.fixture.detectChanges()

        leaveAndComeBack()
        second.fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(3)
      })

      it("doesn't refetch a disabled query", () => {
        const { queryFn } = requests<string>()

        client.setQueryData(['todos'], 'cached')

        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          enabled: false,
        }))

        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).not.toHaveBeenCalled()
      })

      it("doesn't refetch the query a component is leaving with the next key's queryFn", () => {
        // A signal, not an input: an input reaches the component only on
        // change detection, and this is the moment before it.
        const id = signal(1)
        const fetched: number[] = []
        const { fixture, result } = mount(() => ({
          queryKey: ['todo', id()],
          queryFn: () => {
            fetched.push(id())

            return of(`todo ${id()}`)
          },
        }))

        // The key changes, and the user comes back before change detection
        // moves the component to the new query.
        id.set(2)
        leaveAndComeBack()

        expect(fetched).toEqual([1])
        expect(client.getQueryData(['todo', 1])).toBe('todo 1')

        fixture.detectChanges()

        expect(fetched).toEqual([1, 2])
        expect(result.data()).toBe('todo 2')
      })

      it('refetches a query that failed', () => {
        let down = true
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.callFake(() =>
            down ? throwError(() => new Error('down')) : of('v1'),
          )
        const { fixture, result } = mount<string>(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: false,
        }))

        expect(result.isError()).toBe(true)

        down = false
        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
        expect(result.data()).toBe('v1')
      })

      it('takes the default from withDefaultOptions', () => {
        reprovide(
          provideQueryClient(
            withDefaultOptions({ queries: { refetchOnWindowFocus: false } }),
          ),
        )

        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        resolve('v1')
        fixture.detectChanges()

        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it("lets a query's own option override the default", () => {
        reprovide(
          provideQueryClient(
            withDefaultOptions({ queries: { refetchOnWindowFocus: false } }),
          ),
        )

        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchOnWindowFocus: true,
        }))

        resolve('v1')
        fixture.detectChanges()

        leaveAndComeBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
      })
    })

    describe('refetchOnReconnect', () => {
      it('refetches stale data when the network comes back', () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture, result } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
        }))

        resolve('v1')
        fixture.detectChanges()

        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
        expect(result.data()).toBe('v1')
        expect(result.isFetching()).toBe(true)

        resolve('v2')
        fixture.detectChanges()

        expect(result.data()).toBe('v2')
      })

      it("doesn't refetch when the network goes away", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        resolve('v1')
        fixture.detectChanges()

        window.dispatchEvent(new Event('offline'))
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it("doesn't refetch fresh data", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          staleTime: Infinity,
        }))

        resolve('v1')
        fixture.detectChanges()

        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it("refetches fresh data too with 'always'", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          staleTime: Infinity,
          refetchOnReconnect: 'always',
        }))

        resolve('v1')
        fixture.detectChanges()

        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
      })

      it("doesn't refetch with false", () => {
        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn,
          refetchOnReconnect: false,
        }))

        resolve('v1')
        fixture.detectChanges()

        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it('makes one request for all components showing the key', () => {
        const { queryFn, inFlight, cancelled, resolve } = requests<string>()
        const { fixture, results } = mountMany(3, () => ({
          queryKey: ['todos'],
          queryFn,
        }))

        resolve('v1')
        fixture.detectChanges()

        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
        expect(inFlight()).toBe(1)
        expect(cancelled()).toBe(0)

        resolve('v2')
        fixture.detectChanges()

        expect(results.map((result) => result.data())).toEqual([
          'v2',
          'v2',
          'v2',
        ])
      })

      it('keeps a request in flight instead of sending another', () => {
        const { queryFn, inFlight, cancelled } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        // The first load is still in flight.
        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
        expect(inFlight()).toBe(1)
        expect(cancelled()).toBe(0)
      })

      it('refetches a query that failed while offline', () => {
        let offline = true
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.callFake(() =>
            offline ? throwError(() => new Error('offline')) : of('v1'),
          )
        const { fixture, result } = mount<string>(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: false,
        }))

        expect(result.isError()).toBe(true)

        offline = false
        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
        expect(result.data()).toBe('v1')
      })

      it('takes the default from withDefaultOptions', () => {
        reprovide(
          provideQueryClient(
            withDefaultOptions({ queries: { refetchOnReconnect: false } }),
          ),
        )

        const { queryFn, resolve } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        resolve('v1')
        fixture.detectChanges()

        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
      })

      it('makes one request when the user comes back and the network does at once', () => {
        const { queryFn, inFlight, cancelled, resolve } = requests<string>()
        const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

        resolve('v1')
        fixture.detectChanges()

        // As when a laptop wakes up.
        leaveAndComeBack()
        goOfflineAndBack()
        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(2)
        expect(inFlight()).toBe(1)
        expect(cancelled()).toBe(0)
      })
    })

    it('refetches nothing on the server, whatever the page or the network does', () => {
      reprovide(provideQueryClient(), {
        provide: PLATFORM_ID,
        useValue: 'server',
      })

      const { queryFn, resolve } = requests<string>()
      const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

      resolve('v1')
      fixture.detectChanges()

      leaveAndComeBack()
      goOfflineAndBack()
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(1)
    })
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

    it('refetch() cancels an in-flight fetch and starts a fresh one', () => {
      const { queryFn, inFlight, cancelled, resolve } = requests<string>()
      const { result } = mount(() => ({ queryKey: ['c'], queryFn }))

      result.refetch()

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(cancelled()).toBe(1)
      expect(inFlight()).toBe(1)

      resolve('fresh')

      expect(result.data()).toBe('fresh')
    })
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

  // optionsFn may read what a component only has once it's rendered: its
  // inputs, and fields declared after the query. So it must not run while the
  // host is being constructed.
  describe('options evaluation', () => {
    it('does not call optionsFn while the host is being constructed', () => {
      const optionsFn = jasmine
        .createSpy('optionsFn')
        .and.returnValue({ queryKey: ['lazy'], queryFn: () => of(1) })

      @Component({ template: '' })
      class Host {
        readonly result = injectQuery<number>(optionsFn)
      }

      const fixture = TestBed.createComponent(Host)

      expect(optionsFn).not.toHaveBeenCalled()

      fixture.detectChanges()

      expect(optionsFn).toHaveBeenCalled()
      expect(fixture.componentInstance.result.data()).toBe(1)
    })

    it('reads an input.required bound by the parent template', () => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(`todo-${id}`))
      const { fixture, result, value } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn: () => queryFn(id()) }),
        1,
      )

      expect(result.data()).toBe('todo-1')

      value.set(2)
      fixture.detectChanges()

      expect(result.data()).toBe('todo-2')
      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])
    })

    it('reads a field declared after the query', () => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('ready'))

      @Component({ template: '' })
      class Host {
        readonly result = injectQuery(() => ({
          queryKey: ['later'],
          queryFn,
          enabled: this.ready(),
        }))

        // Declared after the query on purpose: it doesn't exist yet while the
        // query is being created.
        readonly ready = signal(false)
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      expect(queryFn).not.toHaveBeenCalled()

      fixture.componentInstance.ready.set(true)
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(fixture.componentInstance.result.data()).toBe('ready')
    })

    it('sees cached data and initialData when read before the first effect run', () => {
      // staleTime 0: once the fetch effect runs, both refetch in the
      // background. That no fetch has happened yet by ngOnInit is the proof
      // that the read came first.
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('fresh'))
      let seenInOnInit: unknown[] = []

      client.setQueryData(['cached', 1], 'from cache')

      @Component({ selector: 'app-host', template: '' })
      class Host implements OnInit {
        readonly id = input.required<number>()

        readonly cached = injectQuery(() => ({
          queryKey: ['cached', this.id()],
          queryFn,
        }))

        readonly seeded = injectQuery(() => ({
          queryKey: ['seeded', this.id()],
          queryFn,
          initialData: 'from initialData',
        }))

        ngOnInit(): void {
          seenInOnInit = [
            queryFn.calls.count(),
            this.cached.data(),
            this.seeded.data(),
          ]
        }
      }

      @Component({ imports: [Host], template: '<app-host [id]="1" />' })
      class Parent {}

      TestBed.createComponent(Parent).detectChanges()

      expect(seenInOnInit).toEqual([0, 'from cache', 'from initialData'])
      expect(queryFn).toHaveBeenCalledTimes(2)
    })

    it('keeps the previous query until change detection switches the key', () => {
      // As in TanStack's Angular adapter: the result follows a key change when
      // the effects run, not the moment the signal is set.
      const id = signal(1)
      const { fixture, result } = mount(() => ({
        queryKey: ['item', id()],
        queryFn: () => (id() === 1 ? of('v1') : new Subject<string>()),
      }))

      id.set(2)

      expect(result.data()).toBe('v1')
      expect(result.isSuccess()).toBe(true)

      fixture.detectChanges()

      expect(result.data()).toBeUndefined()
      expect(result.isPending()).toBe(true)
      expect(result.isFetching()).toBe(true)
    })
  })

  describe('an options function that throws', () => {
    // A detail panel still alive during sign-out: its item disappears before
    // Angular destroys the view. Capture the id in queryFn so the request itself
    // remains valid even when the options callback can no longer read the item.
    function mountPanel(
      request: (id: number) => Observable<string>,
      options: Partial<QueryOptions<string>> = {},
    ) {
      @Component({ template: '' })
      class Panel {
        readonly item = signal<{ id: number } | null>({ id: 1 })
        readonly query = injectQuery(() => {
          const id = this.item()!.id

          return {
            queryKey: ['item', id],
            queryFn: () => request(id),
            retry: false,
            ...options,
          }
        })
      }

      const fixture = TestBed.createComponent(Panel)

      fixture.detectChanges()

      return fixture
    }

    it('keeps retrying the original request and shares the server error', fakeAsync(() => {
      const serverError = new Error('server unavailable')
      const request = jasmine
        .createSpy('request')
        .and.returnValue(throwError(() => serverError))
      const fixture = mountPanel(request, { retry: 2, retryDelay: 100 })
      const query = client.getQueryCache().get(['item', 1])!

      expect(request).toHaveBeenCalledTimes(1)
      expect(query.state().failureReason).toBe(serverError)

      // During the first wait, sign-out invalidates the component's options.
      fixture.componentInstance.item.set(null)
      tick(100)

      expect(request).toHaveBeenCalledTimes(2)
      expect(query.state().failureReason).toBe(serverError)

      tick(100)

      expect(request.calls.allArgs()).toEqual([[1], [1], [1]])
      expect(query.state()).toEqual(
        jasmine.objectContaining({
          status: 'error',
          isFetching: false,
          failureCount: 3,
          failureReason: serverError,
          error: serverError,
        }),
      )
      expect(fixture.componentInstance.query.error()).toBe(serverError)
    }))

    it('retries through another component still showing the key', fakeAsync(() => {
      const serverError = new Error('server unavailable')
      const request = jasmine
        .createSpy('request')
        .and.returnValue(throwError(() => serverError))
      const fixture = mountPanel(request, { retry: 2, retryDelay: 100 })
      const validRequest = jasmine
        .createSpy('validRequest')
        .and.returnValue(of('recovered'))
      const valid = mountHost(() =>
        injectQuery(() => ({
          queryKey: ['item', 1],
          queryFn: validRequest,
        })),
      )

      // Joining makes validRequest the fallback. Replace that fallback so
      // success must come from selecting the live observer, past the bad one.
      void client.fetchQuery(['item', 1], () => request(1))
      fixture.componentInstance.item.set(null)
      tick(100)

      expect(request).toHaveBeenCalledTimes(1)
      expect(validRequest).toHaveBeenCalledTimes(1)
      expect(valid.created.data()).toBe('recovered')
      expect(valid.created.error()).toBeNull()
      expect(valid.created.failureReason()).toBeNull()
    }))

    for (const method of ['invalidateQueries', 'refetchQueries'] as const) {
      it(`${method} skips the broken component and refetches other queries`, fakeAsync(() => {
        const request = jasmine.createSpy('request').and.returnValue(of('item'))
        const fixture = mountPanel(request)
        const otherRequest = jasmine
          .createSpy('otherRequest')
          .and.returnValue(of('other'))

        mountHost(() =>
          injectQuery(() => ({ queryKey: ['other'], queryFn: otherRequest })),
        )
        fixture.componentInstance.item.set(null)

        let completed = false

        expect(() => {
          void client[method]().then(() => {
            completed = true
          })
        }).not.toThrow()
        tick()

        expect(completed).toBe(true)
        expect(request).toHaveBeenCalledTimes(1)
        expect(otherRequest).toHaveBeenCalledTimes(2)
      }))

      it(`${method} uses another valid observer of the same key`, fakeAsync(() => {
        const request = jasmine.createSpy('request').and.returnValue(of('item'))
        const fixture = mountPanel(request)
        const validRequest = jasmine
          .createSpy('validRequest')
          .and.returnValue(of('fresh'))

        mountHost(() =>
          injectQuery(() => ({ queryKey: ['item', 1], queryFn: validRequest })),
        )
        validRequest.calls.reset()
        fixture.componentInstance.item.set(null)

        expect(() => {
          void client[method]()
        }).not.toThrow()
        tick()

        expect(request).toHaveBeenCalledTimes(1)
        expect(validRequest).toHaveBeenCalledTimes(1)
        expect(client.getQueryData(['item', 1])).toBe('fresh')
      }))
    }

    for (const [event, dispatch] of [
      ['focus', leaveAndComeBack],
      ['reconnect', goOfflineAndBack],
    ] as const) {
      it(`${event} skips the broken component, then refetches valid observers and other queries`, fakeAsync(() => {
        const request = jasmine.createSpy('request').and.returnValue(of('item'))
        const fixture = mountPanel(request)
        const otherRequest = jasmine
          .createSpy('otherRequest')
          .and.returnValue(of('other'))

        mountHost(() =>
          injectQuery(() => ({ queryKey: ['other'], queryFn: otherRequest })),
        )
        fixture.componentInstance.item.set(null)

        expect(dispatch).not.toThrow()
        // RxJS reports listener errors on a later task: dispatch alone cannot
        // prove that there was no uncaught error from the browser event.
        tick()

        expect(request).toHaveBeenCalledTimes(1)
        expect(otherRequest).toHaveBeenCalledTimes(2)

        const validRequest = jasmine
          .createSpy('validRequest')
          .and.returnValue(of('fresh'))

        mountHost(() =>
          injectQuery(() => ({ queryKey: ['item', 1], queryFn: validRequest })),
        )
        validRequest.calls.reset()

        expect(dispatch).not.toThrow()
        tick()

        expect(validRequest).toHaveBeenCalledTimes(1)
        expect(otherRequest).toHaveBeenCalledTimes(3)
        expect(client.getQueryData(['item', 1])).toBe('fresh')
      }))
    }

    it('skips polls while options throw and resumes when the item returns', fakeAsync(() => {
      const request = jasmine.createSpy('request').and.returnValue(of('item'))
      const fixture = mountPanel(request, { refetchInterval: 100 })

      fixture.componentInstance.item.set(null)

      expect(() => tick(300)).not.toThrow()
      expect(request).toHaveBeenCalledTimes(1)

      fixture.componentInstance.item.set({ id: 1 })
      tick(100)

      expect(request).toHaveBeenCalledTimes(2)

      fixture.destroy()
    }))

    it('still skips disabled and changed-key observers alongside a broken one', fakeAsync(() => {
      const fixture = mountPanel(() => of('item'))
      const disabledRequest = jasmine
        .createSpy('disabledRequest')
        .and.returnValue(of('disabled'))
      const movedRequest = jasmine
        .createSpy('movedRequest')
        .and.returnValue(of('moved'))
      const id = signal(1)

      mountHost(() =>
        injectQuery(() => ({
          queryKey: ['disabled'],
          queryFn: disabledRequest,
          enabled: false,
        })),
      )
      mountHost(() =>
        injectQuery(() => ({
          queryKey: ['moved', id()],
          queryFn: movedRequest,
        })),
      )
      fixture.componentInstance.item.set(null)
      id.set(2)

      // None of these background paths should reuse the old key's observer
      // before change detection switches it to the new key.
      void client.invalidateQueries()
      void client.refetchQueries()
      leaveAndComeBack()
      goOfflineAndBack()
      tick()

      expect(disabledRequest).not.toHaveBeenCalled()
      expect(movedRequest).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['moved', 1])).toBe('moved')
      expect(client.getQueryData(['moved', 2])).toBeUndefined()
    }))

    it('still reports the component effect error through Angular ErrorHandler', fakeAsync(() => {
      const handleError = jasmine.createSpy('handleError')

      // Let Angular's scheduler run change detection and report its error.
      // Disable TestBed's extra rethrow so the handler's calls can be inspected.
      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(),
          { provide: ErrorHandler, useValue: { handleError } },
        ],
        rethrowApplicationErrors: false,
      })

      const fixture = mountPanel(() => of('item'))
      const currentClient = TestBed.inject(QueryClient)

      fixture.autoDetectChanges()
      fixture.componentInstance.item.set(null)

      expect(() => {
        void currentClient.invalidateQueries()
      }).not.toThrow()
      tick()

      expect(handleError).toHaveBeenCalledWith(jasmine.any(TypeError))
    }))
  })

  // Every response is a new object, as JSON parsing makes. Structural sharing
  // keeps what didn't change from the data the query already holds, so data()
  // keeps its reference when a refetch brings the same data, and nothing that
  // reads it runs again.
  describe('structural sharing', () => {
    type Row = { id: number; title: string; tags: string[] }

    // What the server returns: a fresh array of fresh rows on every call.
    const rows = (): Row[] => [
      { id: 1, title: 'a', tags: ['x'] },
      { id: 2, title: 'b', tags: ['y'] },
    ]

    // Mounts a component showing the query with an effect that reads data(),
    // as one rendering it or filling a form from it does. Returns what the
    // effect has read, one entry per run.
    function mountWithEffect<TData>(optionsFn: () => QueryOptions<TData>): {
      fixture: ComponentFixture<unknown>
      result: QueryResult<TData>
      reads: Array<TData | undefined>
    } {
      const reads: Array<TData | undefined> = []

      @Component({ template: '' })
      class Host {
        readonly result = injectQuery(optionsFn)

        constructor() {
          effect(() => {
            reads.push(this.result.data())
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      return { fixture, result: fixture.componentInstance.result, reads }
    }

    // Provides a client with these default query options.
    function provideDefaults(queries: DefaultQueryOptions): void {
      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [provideQueryClient(withDefaultOptions({ queries }))],
      })
      client = TestBed.inject(QueryClient)
    }

    it("keeps data() when a refetch brings the same data, so an effect reading it doesn't run again", () => {
      const { fixture, result, reads } = mountWithEffect(() => ({
        queryKey: ['rows'],
        queryFn: () => of(rows()),
      }))
      const first = result.data()
      const runs = reads.length

      result.refetch()
      fixture.detectChanges()

      expect(result.data()).toBe(first)
      expect(reads.length).toBe(runs)
    })

    it("keeps the parts of the data that didn't change", () => {
      let response = rows()
      const { fixture, result } = mount(() => ({
        queryKey: ['rows'],
        queryFn: () => of(response),
      }))
      const before = result.data()!

      response = rows()
      response[1] = { ...response[1], title: 'b2' }
      result.refetch()
      fixture.detectChanges()

      const after = result.data()!

      expect(after).not.toBe(before)
      expect(after[0]).toBe(before[0])
      expect(after[1]).not.toBe(before[1])
      expect(after[1].title).toBe('b2')
      expect(after[1].tags).toBe(before[1].tags)
    })

    it("doesn't overwrite an edit made in a form that an effect fills from data() when a poll brings the same data", fakeAsync(() => {
      const queryFn = jasmine
        .createSpy<() => Observable<Todo>>('queryFn')
        .and.callFake(() => of({ id: 1, title: 'Buy milk' }))
      const title = signal('')

      @Component({ template: '' })
      class Editor {
        readonly todo = injectQuery(() => ({
          queryKey: ['todo', 1],
          queryFn,
          refetchInterval: 1000,
        }))

        constructor() {
          // Fills the form field whenever the todo changes.
          effect(() => {
            const todo = this.todo.data()

            if (todo) title.set(todo.title)
          })
        }
      }

      const fixture = TestBed.createComponent(Editor)

      fixture.detectChanges()
      title.set('Buy oat milk')
      elapse(3000, fixture)

      expect(queryFn).toHaveBeenCalledTimes(4)
      expect(title()).toBe('Buy oat milk')

      fixture.destroy()
      flush()
    }))

    it('keeps data() when an invalidation refetch brings the same data', () => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake(() => of(rows()))
      const { fixture, result } = mount(() => ({
        queryKey: ['rows'],
        queryFn,
      }))
      const first = result.data()

      client.invalidateQueries({ queryKey: ['rows'] })
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(result.data()).toBe(first)
    })

    it('merges a response with the data the query holds when it lands, a write made during the fetch included', () => {
      const server = requests<Row[]>()
      const { fixture, result } = mount(() => ({
        queryKey: ['rows'],
        queryFn: server.queryFn,
      }))

      server.resolve(rows())
      result.refetch()

      // An optimistic write while the refetch is in flight, which the
      // response then confirms.
      const added = (): Row => ({ id: 3, title: 'c', tags: [] })

      client.setQueryData<Row[]>(['rows'], (current = []) => [
        ...current,
        added(),
      ])

      const optimistic = client.getQueryData<Row[]>(['rows'])

      server.resolve([...rows(), added()])
      fixture.detectChanges()

      expect(result.data()).toBe(optimistic)
    })

    it('merges with a structuralSharing function, which gets the cached data and the response', () => {
      const calls: Array<[Row[] | undefined, Row[]]> = []
      const { fixture, result } = mount(() => ({
        queryKey: ['rows'],
        queryFn: () => of(rows()),
        // Its parameters are typed from queryFn.
        structuralSharing: (oldData, newData) => {
          calls.push([oldData, newData])

          return newData
        },
      }))
      const first = result.data()

      result.refetch()
      fixture.detectChanges()

      expect(calls.length).toBe(2)
      expect(calls[0][0]).toBeUndefined()
      expect(calls[1][0]).toBe(first)
      // What the function returns is stored, though the data is the same.
      expect(result.data()).toBe(calls[1][1])
    })

    it('fails the fetch when the structuralSharing function throws, and keeps the data', fakeAsync(() => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake(() => of(rows()))
      const error = new Error('cannot merge')
      const { fixture, result } = mount(() => ({
        queryKey: ['rows'],
        queryFn,
        retry: 3,
        retryDelay: 10,
        structuralSharing: (oldData, newData) => {
          if (oldData) throw error

          return newData
        },
      }))
      const first = result.data()

      result.refetch()
      tick(100)
      fixture.detectChanges()

      expect(result.status()).toBe('error')
      expect(result.error()).toBe(error)
      expect(result.isFetching()).toBe(false)
      expect(result.data()).toBe(first)
      // The response arrived; merging it isn't retried.
      expect(queryFn).toHaveBeenCalledTimes(2)
    }))

    it('gives every response a new reference with structuralSharing: false', () => {
      const { fixture, result } = mount(() => ({
        queryKey: ['rows'],
        queryFn: () => of(rows()),
        structuralSharing: false,
      }))
      const first = result.data()

      result.refetch()
      fixture.detectChanges()

      expect(result.data()).not.toBe(first)
      expect(result.data()).toEqual(first)
    })

    it("doesn't pass initialData to a structuralSharing function", () => {
      const structuralSharing = jasmine
        .createSpy('structuralSharing')
        .and.callFake((_oldData: Row[] | undefined, newData: Row[]) => newData)

      mount(() => ({
        queryKey: ['rows'],
        queryFn: () => of(rows()),
        initialData: rows(),
        staleTime: Infinity,
        structuralSharing,
      }))

      expect(structuralSharing).not.toHaveBeenCalled()
    })

    describe('with default options', () => {
      it('gives every response a new reference with a default of false', () => {
        provideDefaults({ structuralSharing: false })

        const { fixture, result } = mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
        }))
        const first = result.data()

        result.refetch()
        fixture.detectChanges()

        expect(result.data()).not.toBe(first)
      })

      it('lets a query set structuralSharing: true over a default of false', () => {
        provideDefaults({ structuralSharing: false })

        const { fixture, result } = mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          structuralSharing: true,
        }))
        const first = result.data()

        result.refetch()
        fixture.detectChanges()

        expect(result.data()).toBe(first)
      })
    })

    // setQueryData has no options of its own: it merges as the query showing
    // the key says; with none showing it, the way the data the query holds
    // was fetched; or by the default if it never was.
    describe('setQueryData', () => {
      it("keeps data() when it writes the same data, so an effect reading it doesn't run again", () => {
        const { fixture, result, reads } = mountWithEffect(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          staleTime: Infinity,
        }))
        const first = result.data()
        const runs = reads.length

        // e.g. a save whose response repeats what the cache holds
        client.setQueryData(['rows'], rows())
        fixture.detectChanges()

        expect(result.data()).toBe(first)
        expect(reads.length).toBe(runs)
      })

      it('keeps the data of a key nothing has fetched yet when it writes the same data', () => {
        // e.g. seeding a detail query from a row of a list
        client.setQueryData(['row', 1], rows()[0])

        const first = client.getQueryData(['row', 1])

        client.setQueryData(['row', 1], rows()[0])

        expect(client.getQueryData(['row', 1])).toBe(first)
      })

      it('follows structuralSharing: false of the query showing the key', () => {
        const { fixture, result } = mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          structuralSharing: false,
        }))
        const first = result.data()

        client.setQueryData(['rows'], rows())
        fixture.detectChanges()

        expect(result.data()).not.toBe(first)
      })

      it('follows structuralSharing: false of the query once the component showing it is gone', () => {
        const { fixture } = mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          structuralSharing: false,
        }))
        const first = client.getQueryData(['rows'])

        fixture.destroy()
        client.setQueryData(['rows'], rows())

        expect(client.getQueryData(['rows'])).not.toBe(first)
      })

      it('follows structuralSharing: false of the query while it is disabled', () => {
        const editing = signal(false)
        const { fixture, result } = mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          structuralSharing: false,
          enabled: !editing(),
        }))
        const first = result.data()

        editing.set(true)
        fixture.detectChanges()
        client.setQueryData(['rows'], rows())
        fixture.detectChanges()

        expect(result.data()).not.toBe(first)
      })

      it("follows structuralSharing: false of a query showing the key though it hasn't fetched it", () => {
        // e.g. a key only a socket fills, through setQueryData
        mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          structuralSharing: false,
          enabled: false,
        }))

        client.setQueryData(['rows'], rows())

        const first = client.getQueryData(['rows'])

        client.setQueryData(['rows'], rows())

        expect(client.getQueryData(['rows'])).not.toBe(first)
      })

      it('keeps following the query showing the key after a prefetch without the option', () => {
        const { fixture, result } = mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          structuralSharing: false,
        }))

        client.fetchQuery(['rows'], () => of(rows()), { staleTime: 0 })

        const first = result.data()

        client.setQueryData(['rows'], rows())
        fixture.detectChanges()

        expect(result.data()).not.toBe(first)
      })

      it('keeps following the fetch the data came from when a later fetch fails', () => {
        const { fixture } = mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          structuralSharing: false,
        }))

        fixture.destroy()
        // A prefetch without the option fails: the data the query holds is
        // still the one fetched with false.
        client.fetchQuery(
          ['rows'],
          () => throwError(() => new Error('offline')),
          {
            staleTime: 0,
            retry: false,
          },
        )

        const first = client.getQueryData(['rows'])

        client.setQueryData(['rows'], rows())

        expect(client.getQueryData(['rows'])).not.toBe(first)
      })

      it('throws to its caller when the structuralSharing function throws, and keeps the data', () => {
        const error = new Error('cannot merge')
        const { result } = mount(() => ({
          queryKey: ['rows'],
          queryFn: () => of(rows()),
          structuralSharing: (oldData, newData) => {
            if (oldData) throw error

            return newData
          },
        }))
        const first = result.data()

        expect(() => client.setQueryData(['rows'], rows())).toThrow(error)
        expect(result.data()).toBe(first)
      })

      it('follows a default of false for a key nothing has fetched yet', () => {
        provideDefaults({ structuralSharing: false })

        client.setQueryData(['row', 1], rows()[0])

        const first = client.getQueryData(['row', 1])

        client.setQueryData(['row', 1], rows()[0])

        expect(client.getQueryData(['row', 1])).not.toBe(first)
      })
    })
  })

  // An unused query stays in the cache for gcTime, then it's removed. A query
  // is in use while a component shows it or a fetch of it is in flight. The
  // Caching docs page states these, so a change here goes there too.
  describe('garbage collection', () => {
    it('removes a query gcTime after the last component showing it is gone', fakeAsync(() => {
      const { fixture } = mount(() => ({
        queryKey: ['todos'],
        queryFn: () => of('v1'),
        gcTime: 60_000,
      }))

      fixture.destroy()

      tick(59_999)
      expect(client.getQueryData(['todos'])).toBe('v1')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it('keeps a query while a component shows it, however long', fakeAsync(() => {
      mount(() => ({
        queryKey: ['todos'],
        queryFn: () => of('v1'),
        gcTime: 1000,
      }))

      tick(60 * 60_000)

      expect(client.getQueryData(['todos'])).toBe('v1')
    }))

    it('keeps a query with gcTime Infinity, or one no timer can hold, once the last component showing it is gone', async () => {
      // A browser runs a timer it can't hold at once, as if its delay were 0.
      // fakeAsync doesn't mimic the browser here, hence real timers.
      const gcTimes = [Infinity, 2 ** 31]
      const fixtures = gcTimes.map(
        (gcTime) =>
          mount(() => ({
            queryKey: ['todos', String(gcTime)],
            queryFn: () => of('v1'),
            gcTime,
          })).fixture,
      )

      fixtures.forEach((fixture) => fixture.destroy())
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(client.getQueryData(['todos', 'Infinity'])).toBe('v1')
      expect(client.getQueryData(['todos', String(2 ** 31)])).toBe('v1')
    })

    it('keeps a query for the longest gcTime of the components showing it, whichever came last', fakeAsync(() => {
      const show = (key: string, gcTime: number): ComponentFixture<unknown> =>
        mount(() => ({ queryKey: [key], queryFn: () => of('v1'), gcTime }))
          .fixture
      const fixtures = [
        show('longer first', 10 * 60_000),
        show('longer first', 1000),
        show('shorter first', 1000),
        show('shorter first', 10 * 60_000),
      ]

      fixtures.forEach((fixture) => fixture.destroy())

      tick(10 * 60_000 - 1)
      expect(client.getQueryData(['longer first'])).toBe('v1')
      expect(client.getQueryData(['shorter first'])).toBe('v1')

      tick(1)
      expect(client.getQueryData(['longer first'])).toBeUndefined()
      expect(client.getQueryData(['shorter first'])).toBeUndefined()
    }))

    it('keeps the longest gcTime a component asked for after that component is gone', fakeAsync(() => {
      const show = (gcTime: number): void =>
        mount(() => ({
          queryKey: ['todos'],
          queryFn: () => of('v1'),
          gcTime,
        })).fixture.destroy()

      show(10 * 60_000)
      show(1000)

      tick(10 * 60_000 - 1)
      expect(client.getQueryData(['todos'])).toBe('v1')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it('keeps a prefetched query for the default gcTime at least, whatever shorter one a component showing it asks for', fakeAsync(() => {
      const show = (id: number): ComponentFixture<unknown> =>
        mount(() => ({
          queryKey: ['todo', id],
          queryFn: () => of(`todo ${id}`),
          gcTime: 1000,
        })).fixture

      // Todo 1 is prefetched before a component shows it, todo 2 while one
      // does.
      client.fetchQuery(['todo', 1], () => of('todo 1'))

      const fixtures = [show(1), show(2)]

      client.fetchQuery(['todo', 2], () => of('todo 2'))
      fixtures.forEach((fixture) => fixture.destroy())

      tick(5 * 60_000 - 1)
      expect(client.getQueryData(['todo', 1])).toBe('todo 1')
      expect(client.getQueryData(['todo', 2])).toBe('todo 2')

      tick(1)
      expect(client.getQueryData(['todo', 1])).toBeUndefined()
      expect(client.getQueryData(['todo', 2])).toBeUndefined()
    }))

    it("doesn't remove a query while a prefetch of it is in flight", fakeAsync(() => {
      const response = new Subject<string>()
      const { fixture } = mount(() => ({
        queryKey: ['todo', 1],
        queryFn: () => of('v1'),
      }))

      // The user leaves the page, and hovers a link back to it just before
      // the query would be removed.
      fixture.destroy()
      tick(5 * 60_000 - 100)
      client.fetchQuery(['todo', 1], () => response)
      tick(100)

      response.next('v2')
      response.complete()

      expect(client.getQueryData(['todo', 1])).toBe('v2')
    }))

    it('removes a query gcTime after the response of a request its component left lands', fakeAsync(() => {
      const { queryFn, requests } = promiseRequests<string>()

      mount(() => ({
        queryKey: ['todos'],
        queryFn,
        gcTime: 1000,
      })).fixture.destroy()
      tick(500)
      requests[0].resolve('a')
      flushMicrotasks()

      tick(999)
      expect(client.getQueryData(['todos'])).toBe('a')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it('removes a query its component created but was gone before showing', fakeAsync(() => {
      @Component({ template: '' })
      class TodoCount {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: () => of(['a']),
        }))

        // Read while the component is being constructed, which creates the
        // query before any change detection.
        readonly initial = this.todos.data()
      }

      TestBed.createComponent(TodoCount).destroy()

      tick(5 * 60_000 - 1)
      expect(client.getQueryCache().get(['todos'])).toBeDefined()

      tick(1)
      expect(client.getQueryCache().get(['todos'])).toBeUndefined()
    }))

    // The cache lives as long as the app that renders the request.
    describe('on the server', () => {
      beforeEach(() =>
        reprovide(provideQueryClient(), {
          provide: PLATFORM_ID,
          useValue: 'server',
        }),
      )

      it('keeps a query once the last component showing it is gone, whatever its gcTime', fakeAsync(() => {
        const { fixture } = mount(() => ({
          queryKey: ['todos'],
          queryFn: () => of('v1'),
          gcTime: 1000,
        }))

        fixture.destroy()
        tick(60 * 60_000)

        expect(client.getQueryData(['todos'])).toBe('v1')
      }))

      it('leaves no timer behind that would hold up a server render', () => {
        @Component({ template: '' })
        class TodoPage {
          constructor() {
            client.setQueryData(['user'], 'Ann')
            client.fetchQuery(['todos'], () => of(['a']))
          }
        }

        TestBed.createComponent(TodoPage).detectChanges()

        // With zone.js, a server render writes out the page only once no
        // timer is pending.
        expect(TestBed.inject(NgZone).hasPendingMacrotasks).toBe(false)
      })
    })
  })

  // What a query does when it sets none of these options. The Important
  // Defaults docs page states each of them, so a change here goes there too.
  describe('built-in defaults', () => {
    it('removes a query 5 minutes after the last component showing it is gone', fakeAsync(() => {
      const { fixture } = mount(() => ({
        queryKey: ['todos'],
        queryFn: () => of('v1'),
      }))

      fixture.destroy()

      tick(5 * 60_000 - 1)
      expect(client.getQueryData(['todos'])).toBe('v1')

      tick(1)
      expect(client.getQueryData(['todos'])).toBeUndefined()
    }))

    it('retries a failing query 3 times, 1 s, 2 s and 4 s apart, and shows the error after the last', fakeAsync(() => {
      const start = Date.now()
      const sent: number[] = []
      const { result } = mount<string>(() => ({
        queryKey: ['todos'],
        queryFn: () => {
          sent.push(Date.now() - start)

          return throwError(() => new Error('down'))
        },
      }))

      tick(6_999)
      expect(result.isError()).toBe(false)
      expect(result.failureCount()).toBe(3)

      tick(1)
      expect(result.isError()).toBe(true)
      expect(result.failureCount()).toBe(4)

      tick(60_000)
      expect(sent).toEqual([0, 1_000, 3_000, 7_000])
    }))

    it('refetches cached data in the background when another component shows the key', () => {
      const { queryFn, resolve } = requests<string>()
      const first = mount(() => ({ queryKey: ['todos'], queryFn }))

      resolve('v1')
      first.fixture.detectChanges()

      const second = mount(() => ({ queryKey: ['todos'], queryFn }))

      expect(queryFn).toHaveBeenCalledTimes(2)
      // The cached data shows while the refetch runs.
      expect(second.result.data()).toBe('v1')
      expect(second.result.isFetching()).toBe(true)
    })

    it('refetches cached data in the background when the key switches back to it', () => {
      const { queryFn, resolve } = requests<string>()
      const { fixture, result, value } = mount(
        (id) => ({ queryKey: ['todo', id()], queryFn }),
        1,
      )

      resolve('todo 1')
      fixture.detectChanges()
      value.set(2)
      fixture.detectChanges()
      resolve('todo 2')
      fixture.detectChanges()
      value.set(1)
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(3)
      expect(result.data()).toBe('todo 1')
      expect(result.isFetching()).toBe(true)
    })

    it('refetches cached data in the background when enabled turns true', () => {
      const { queryFn } = requests<string>()

      client.setQueryData(['todos'], 'cached')

      const { fixture, result, value } = mount<string, Error, boolean>(
        (enabled) => ({ queryKey: ['todos'], queryFn, enabled: enabled() }),
        false,
      )

      expect(queryFn).not.toHaveBeenCalled()

      value.set(true)
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result.data()).toBe('cached')
      expect(result.isFetching()).toBe(true)
    })

    it("doesn't refetch the data on screen as time passes", fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('v1'))
      const { fixture } = mount(() => ({ queryKey: ['todos'], queryFn }))

      for (let minute = 1; minute <= 10; minute++) {
        tick(60_000)
        fixture.detectChanges()
      }

      expect(queryFn).toHaveBeenCalledTimes(1)
    }))

    // A render waits for no retry: the page shows the error, and the browser
    // tries again once it takes over. A retry the query or the app asks for
    // still applies.
    describe('on the server', () => {
      beforeEach(() =>
        reprovide(provideQueryClient(), {
          provide: PLATFORM_ID,
          useValue: 'server',
        }),
      )

      it("doesn't retry a failing query, so the page shows the error at once", () => {
        const error = new Error('down')
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.callFake(() => throwError(() => error))
        const { fixture, result } = mount<string>(() => ({
          queryKey: ['todos'],
          queryFn,
        }))

        expect(result.isError()).toBe(true)
        expect(result.error()).toBe(error)
        expect(queryFn).toHaveBeenCalledTimes(1)
        // With zone.js, a server render writes out the page only once no
        // timer is pending.
        expect(TestBed.inject(NgZone).hasPendingMacrotasks).toBe(false)

        fixture.destroy()
      })

      it('retries a failing query as the query asks', fakeAsync(() => {
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.callFake(() => throwError(() => new Error('down')))
        const { result } = mount<string>(() => ({
          queryKey: ['todos'],
          queryFn,
          retry: 1,
        }))

        tick(999)
        expect(result.isError()).toBe(false)

        tick(1)
        expect(result.isError()).toBe(true)
        expect(queryFn).toHaveBeenCalledTimes(2)
      }))

      it('retries a failing query as the app asks', fakeAsync(() => {
        reprovide(
          provideQueryClient(withDefaultOptions({ queries: { retry: 1 } })),
          { provide: PLATFORM_ID, useValue: 'server' },
        )

        const queryFn = jasmine
          .createSpy('queryFn')
          .and.callFake(() => throwError(() => new Error('down')))
        const { result } = mount<string>(() => ({
          queryKey: ['todos'],
          queryFn,
        }))

        tick(999)
        expect(result.isError()).toBe(false)

        tick(1)
        expect(result.isError()).toBe(true)
        expect(queryFn).toHaveBeenCalledTimes(2)
      }))
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
