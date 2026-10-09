import {
  Component,
  Injector,
  type OnInit,
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
  tick,
} from '@angular/core/testing'
import { type Observable, map, of, Subject, throwError, timer } from 'rxjs'

import { withDefaultOptions } from '../features/with-default-options'
import { injectQuery } from './inject-query'
import { keepPreviousData } from './keep-previous-data'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { DefaultQueryOptions, QueryOptions, QueryResult } from './types'

// Mounts injectQuery inside a host component so its effects are tied to a real
// view and flush on detectChanges(). The host is rendered from a parent
// template, as in an app, and gets `value` through an `input.required`
// binding: options may read it, although it has no value yet while the host
// is being constructed. Returns the result, the parent's `value` signal (set
// it and detectChanges() to push a new input) and the fixture (destroy it to
// unmount).
function mount<TData, TError = Error, TValue = number>(
  optionsFn: (value: Signal<TValue>) => QueryOptions<TData, TError>,
  value?: TValue,
): {
  fixture: ComponentFixture<unknown>
  result: QueryResult<TData, TError>
  value: WritableSignal<TValue>
} {
  @Component({ selector: 'app-host', template: '' })
  class Host {
    readonly value = input.required<TValue>()
    readonly result = injectQuery<TData, TError>(() => optionsFn(this.value))
  }

  @Component({ imports: [Host], template: '<app-host [value]="value()" />' })
  class Parent {
    readonly value = signal(value as TValue)
    readonly host = viewChild.required(Host)
  }

  const fixture = TestBed.createComponent(Parent)

  fixture.detectChanges()

  return {
    fixture,
    result: fixture.componentInstance.host().result,
    value: fixture.componentInstance.value,
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
// counts as in flight. resolve() answers the latest request.
function requests<T>(): {
  queryFn: jasmine.Spy<() => Observable<T>>
  inFlight: () => number
  cancelled: () => number
  resolve: (value: T) => void
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
  }
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
          effect(() => {
            runs++
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

    it('uses the latest options when the key does change', () => {
      const id = signal(1)
      const retry = signal(0)
      const spy = spyOn(QueryClient.prototype, 'fetchQuery').and.callThrough()
      const { fixture } = mount(() => ({
        queryKey: ['item', id()],
        queryFn: () => of(id()),
        retry: retry(),
      }))

      retry.set(5)
      id.set(2)
      fixture.detectChanges()

      const lastCall = spy.calls.mostRecent().args

      expect(lastCall[0]).toEqual(['item', 2])
      expect(lastCall[2]?.retry).toBe(5)
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
