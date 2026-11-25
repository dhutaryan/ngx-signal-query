import {
  ApplicationRef,
  Component,
  computed,
  Injector,
  type OnInit,
  PLATFORM_ID,
  type Signal,
  type WritableSignal,
  input,
  signal,
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
  leaveAndComeBack,
  pinVisible,
  restoreVisibility,
  setVisibility,
} from '../../spec-helpers/page-events'
import { settled } from '../../spec-helpers/promises'
import { withQueryCache } from '../features/with-query-cache'
import { injectQueries, type InjectQueriesOptions } from './inject-queries'
import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { QueryKey, QueryOptions, QueryResult } from './types'

// Mounts injectQueries in a host component, as mountHost() mounts anything:
// its options may read the host's input.required `value`. Returns the results
// signal, the parent's `value` signal and the fixture.
function mount<TData, TError = Error, TValue = number[]>(
  optionsFn: (value: Signal<TValue>) => InjectQueriesOptions<TData, TError>,
  value?: TValue,
): {
  fixture: ComponentFixture<unknown>
  results: Signal<Array<QueryResult<TData, TError>>>
  value: WritableSignal<TValue>
} {
  const mounted = mountHost(
    (hostValue: Signal<TValue>) =>
      injectQueries<TData, TError>(() => optionsFn(hostValue)),
    value,
  )

  return {
    fixture: mounted.fixture,
    results: mounted.created,
    value: mounted.value,
  }
}

describe('injectQueries', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
  })

  // Polling waits while the page is hidden, so the specs mustn't depend on
  // what the test runner's window does. A spec hides the page itself.
  beforeEach(pinVisible)
  afterEach(restoreVisibility)

  it('returns one result per query, each with its own data', () => {
    const { results } = mount(() => ({
      queries: [1, 2, 3].map((id) => ({
        queryKey: ['todo', id],
        queryFn: () => of(`todo-${id}`),
      })),
    }))

    expect(results().length).toBe(3)
    expect(results().map((todo) => todo.data())).toEqual([
      'todo-1',
      'todo-2',
      'todo-3',
    ])
    expect(results().every((todo) => todo.isSuccess())).toBe(true)
  })

  it('hands each queryFn the key of its own query', () => {
    const keys: QueryKey[] = []

    mount(() => ({
      queries: [1, 2].map((id) => ({
        queryKey: ['todo', id],
        queryFn: ({ queryKey }) => {
          keys.push(queryKey)

          return of(`todo-${id}`)
        },
      })),
    }))

    expect(keys).toEqual([
      ['todo', 1],
      ['todo', 2],
    ])
  })

  it('returns an empty array for no queries', () => {
    const { results } = mount<number>(() => ({ queries: [] }))

    expect(results()).toEqual([])
  })

  it('is populated synchronously, before effects run', () => {
    const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))

    @Component({ template: '' })
    class Host {
      readonly results = injectQueries(() => ({
        queries: [{ queryKey: ['sync'], queryFn }],
      }))
    }

    const fixture = TestBed.createComponent(Host)
    const results = fixture.componentInstance.results

    // No change detection yet: the entry exists, the fetch hasn't started.
    expect(results().length).toBe(1)
    expect(results()[0].isPending()).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('shares cache entries and in-flight requests with injectQuery', () => {
    const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('x'))

    @Component({ template: '' })
    class Host {
      readonly one = injectQuery(() => ({
        queryKey: ['shared'],
        queryFn,
        staleTime: Infinity,
      }))

      readonly many = injectQueries(() => ({
        queries: [{ queryKey: ['shared'], queryFn, staleTime: Infinity }],
      }))
    }

    const fixture = TestBed.createComponent(Host)

    fixture.detectChanges()

    const host = fixture.componentInstance

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(host.one.data()).toBe('x')
    expect(host.many()[0].data()).toBe('x')
    expect(client.getQueryCache().get(['shared'])?.observerCount).toBe(2)
  })

  it('makes one request per invalidation for a key shared with injectQuery', () => {
    const subjects: Array<Subject<string>> = []
    const queryFn = jasmine.createSpy('queryFn').and.callFake(() => {
      const subject = new Subject<string>()

      subjects.push(subject)

      return subject
    })

    @Component({ template: '' })
    class Host {
      readonly one = injectQuery(() => ({
        queryKey: ['shared'],
        queryFn,
        staleTime: Infinity,
      }))

      readonly many = injectQueries(() => ({
        queries: [{ queryKey: ['shared'], queryFn, staleTime: Infinity }],
      }))
    }

    const fixture = TestBed.createComponent(Host)

    fixture.detectChanges()
    subjects[0].next('v1')
    subjects[0].complete()
    fixture.detectChanges()

    client.invalidateQueries({ queryKey: ['shared'] })
    fixture.detectChanges()

    // One new request, still running: a cancelled one is unsubscribed.
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(subjects[1].observed).toBe(true)
  })

  it('lets the first load of a query it shows land when the query is invalidated, then refetches it once', fakeAsync(() => {
    const subjects: Array<Subject<string>> = []
    const queryFn = jasmine.createSpy('queryFn').and.callFake(() => {
      const subject = new Subject<string>()

      subjects.push(subject)

      return subject
    })
    const { results } = mount(() => ({
      queries: [{ queryKey: ['todo', 1], queryFn }],
    }))

    client.invalidateQueries({ queryKey: ['todo', 1] })

    expect(subjects[0].observed).toBe(true)

    subjects[0].next('first')
    subjects[0].complete()
    tick()

    expect(results()[0].data()).toBe('first')
    expect(queryFn).toHaveBeenCalledTimes(2)
  }))

  it('refetches its queries when the user comes back to the page, once per key shared with injectQuery', () => {
    const subjects: Array<Subject<string>> = []
    const queryFn = jasmine.createSpy('queryFn').and.callFake(() => {
      const subject = new Subject<string>()

      subjects.push(subject)

      return subject
    })

    @Component({ template: '' })
    class Host {
      readonly one = injectQuery(() => ({ queryKey: ['shared'], queryFn }))

      readonly many = injectQueries(() => ({
        queries: [
          { queryKey: ['shared'], queryFn },
          { queryKey: ['own'], queryFn },
        ],
      }))
    }

    const fixture = TestBed.createComponent(Host)

    fixture.detectChanges()
    subjects.forEach((subject) => {
      subject.next('v1')
      subject.complete()
    })
    fixture.detectChanges()

    leaveAndComeBack()
    fixture.detectChanges()

    // One request per key on mount, then one more per key, still running.
    expect(queryFn).toHaveBeenCalledTimes(4)
    expect(subjects.slice(2).every((subject) => subject.observed)).toBe(true)
  })

  it('isolates errors per query', () => {
    const err = new Error('boom')
    const { results } = mount<number>(() => ({
      queries: [
        { queryKey: ['ok'], queryFn: () => of(1) },
        {
          queryKey: ['bad'],
          queryFn: () => throwError(() => err),
          retry: false,
        },
      ],
    }))

    expect(results()[0].isSuccess()).toBe(true)
    expect(results()[0].data()).toBe(1)
    expect(results()[1].isError()).toBe(true)
    expect(results()[1].error()).toBe(err)
  })

  it('retries each query as its own options say', fakeAsync(() => {
    let attempts = 0
    const flaky = (): Observable<string> => {
      attempts++

      return attempts === 1
        ? throwError(() => new Error('blip'))
        : of('second try')
    }
    const down = new Error('down')
    const { results } = mount<string>(() => ({
      queries: [
        { queryKey: ['flaky'], queryFn: flaky, retry: 1, retryDelay: 10 },
        {
          queryKey: ['down'],
          queryFn: () => throwError(() => down),
          retry: false,
        },
      ],
    }))

    tick(10)

    expect(attempts).toBe(2)
    expect(results()[0].data()).toBe('second try')
    expect(results()[1].error()).toBe(down)
    expect(results()[1].failureCount()).toBe(1)
  }))

  describe('reactive list', () => {
    it('adds a query when a key appears, without refetching the others', () => {
      const ids = signal([1, 2])
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(`todo-${id}`))
      const { fixture, results } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['todo', id],
          queryFn: () => queryFn(id),
        })),
      }))

      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])

      ids.set([1, 2, 3])
      fixture.detectChanges()

      expect(results().length).toBe(3)
      expect(results()[2].data()).toBe('todo-3')
      // staleTime defaults to 0, so a refetch of 1 and 2 would show up here.
      expect(queryFn.calls.allArgs()).toEqual([[1], [2], [3]])
    })

    it('removes a query when its key disappears and releases its observer', () => {
      const ids = signal([1, 2, 3])
      const { fixture, results } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['todo', id],
          queryFn: () => of(id),
          staleTime: Infinity,
        })),
      }))
      const cache = client.getQueryCache()
      const [, second, third] = results()

      expect(cache.get(['todo', 1])?.observerCount).toBe(1)

      ids.set([2, 3])
      fixture.detectChanges()

      // Matched by key, not by position: the survivors keep their results.
      expect(results().length).toBe(2)
      expect(results()[0]).toBe(second)
      expect(results()[1]).toBe(third)
      expect(cache.get(['todo', 1])?.observerCount).toBe(0)
      expect(cache.get(['todo', 2])?.observerCount).toBe(1)
      expect(cache.get(['todo', 3])?.observerCount).toBe(1)
    })

    it('keeps result identity across reordering', () => {
      const ids = signal([1, 2, 3])
      const { fixture, results } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['todo', id],
          queryFn: () => of(id),
        })),
      }))
      const [first, second, third] = results()

      ids.set([3, 1, 2])
      fixture.detectChanges()

      expect(results()[0]).toBe(third)
      expect(results()[1]).toBe(first)
      expect(results()[2]).toBe(second)
      expect(results().map((todo) => todo.data())).toEqual([3, 1, 2])
    })

    it('gives each query its own dataUpdatedAt, kept across reordering', fakeAsync(() => {
      const ids = signal([1, 2])
      const { fixture, results } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['todo', id],
          // Todo 1 lands after 100 ms, todo 2 after 200 ms.
          queryFn: () => timer(id * 100).pipe(map(() => id)),
        })),
      }))
      const start = Date.now()

      tick(200)

      expect(results().map((todo) => todo.dataUpdatedAt())).toEqual([
        start + 100,
        start + 200,
      ])

      ids.set([2, 1])
      fixture.detectChanges()

      expect(results().map((todo) => todo.dataUpdatedAt())).toEqual([
        start + 200,
        start + 100,
      ])
    }))

    it('gives each query its own isFetchedAfterMount, kept across reordering', () => {
      void client.query({ queryKey: ['todo', 3], queryFn: () => of(3) })

      const waiting = new Map<number, Subject<number>>()
      const ids = signal([1, 2])
      const { fixture, results } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['todo', id],
          // Todo 1 comes back at once; todo 2 waits for an answer.
          queryFn: () => {
            if (id !== 2) return of(id)

            const response = new Subject<number>()

            waiting.set(id, response)

            return response
          },
          // Nothing is fetched again: a query that started over on the
          // reordering would stay false.
          staleTime: Infinity,
        })),
      }))
      const fetchedAfterMount = () =>
        results().map((todo) => todo.isFetchedAfterMount())

      expect(fetchedAfterMount()).toEqual([true, false])

      ids.set([2, 1])
      fixture.detectChanges()

      expect(fetchedAfterMount()).toEqual([false, true])

      // Todo 3 was fetched before the list showed it.
      ids.set([2, 1, 3])
      fixture.detectChanges()

      expect(results()[2].isFetched()).toBe(true)
      expect(fetchedAfterMount()).toEqual([false, true, false])

      waiting.get(2)!.next(2)

      expect(fetchedAfterMount()).toEqual([true, true, false])
    })

    it('keeps the same array when only options change', () => {
      const version = signal(1)
      const { fixture, results } = mount(() => ({
        queries: [1, 2].map((id) => ({
          queryKey: ['todo', id],
          queryFn: () => of(id),
          retry: version(),
        })),
      }))
      const before = results()

      version.set(2)
      fixture.detectChanges()

      expect(results()).toBe(before)
    })

    it('keeps polling a query while the list changes around it', fakeAsync(() => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(id))
      const { fixture, value } = mount(
        (ids) => ({
          queries: ids().map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => queryFn(id),
            // Only the first todo polls.
            refetchInterval: id === 1 ? 100 : false,
          })),
        }),
        [1],
      )

      // A todo joins the list every 50 ms, twice per interval.
      for (let next = 2; next <= 6; next++) {
        tick(50)
        value.update((ids) => [...ids, next])
        fixture.detectChanges()
      }

      // 250 ms in: todo 1 was fetched on mount, then polled at 100 and 200.
      const first = queryFn.calls.allArgs().filter(([id]) => id === 1)

      expect(first.length).toBe(3)

      fixture.destroy()
    }))

    it('forwards changed options to the matching query', () => {
      const enabled = signal(false)
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of(1))
      const { fixture, results } = mount(() => ({
        queries: [{ queryKey: ['gated'], queryFn, enabled: enabled() }],
      }))

      expect(queryFn).not.toHaveBeenCalled()
      expect(results()[0].isPending()).toBe(true)

      enabled.set(true)
      fixture.detectChanges()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(results()[0].data()).toBe(1)
    })

    it('pairs duplicate keys one-to-one', () => {
      const count = signal(2)
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('dup'))
      const { fixture, results } = mount(() => ({
        queries: Array.from({ length: count() }, () => ({
          queryKey: ['dup'],
          queryFn,
          staleTime: Infinity,
        })),
      }))
      const query = client.getQueryCache().get(['dup'])

      // Two observers on one cache entry, one request.
      expect(results().length).toBe(2)
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(query?.observerCount).toBe(2)

      count.set(1)
      fixture.detectChanges()

      expect(results().length).toBe(1)
      expect(query?.observerCount).toBe(1)
    })

    it('follows a list whose array of queries changes in place', () => {
      // The options kept in a signal: adding a todo pushes it into their
      // array, and the options object around it is new.
      const options = signal<InjectQueriesOptions<string>>({
        queries: [{ queryKey: ['todo', 1], queryFn: () => of('todo-1') }],
      })
      const { fixture, results } = mount(() => options())

      options.update((current) => {
        current.queries.push({
          queryKey: ['todo', 2],
          queryFn: () => of('todo-2'),
        })

        return { ...current }
      })
      fixture.detectChanges()

      expect(results().map((todo) => todo.data())).toEqual(['todo-1', 'todo-2'])
    })
  })

  // The library goes by the options that the list gives each query's key
  // right now, even before change detection updates the results: a queryFn
  // that reads a signal when it runs, like `() => api(this.id())` does,
  // already asks for what the signal holds by then.
  describe('for a query of the list', () => {
    // A todo API that answers each request at once with the todo that it
    // asks for: `api.calls.allArgs()` lists the ids that it was asked for.
    const todoApi = () =>
      jasmine
        .createSpy<(id: number) => Observable<string>>('api')
        .and.callFake((id) => of(`todo ${id}`))

    // Once a key has left the list, nothing fetches its query for the list
    // any more, whether change detection has run since or not.
    describe('once its key has left the list', () => {
      // A list with a query for the todo that `id` names, as a page showing
      // the selected todo holds it: its queryFn reads `id` when it runs. `id`
      // is a signal of the spec's own, so the list moves on to the next todo
      // the moment it's set, before change detection.
      function selected(
        api: (id: number) => Observable<string>,
        options: Partial<QueryOptions<string>> = {},
      ) {
        const id = signal(1)
        const { fixture, results } = mount(() => ({
          queries: [
            { queryKey: ['todo', id()], queryFn: () => api(id()), ...options },
          ],
        }))

        return { fixture, results, id }
      }

      it('fails with the last error when a retry comes due before change detection', fakeAsync(() => {
        const api = todoApi()
        const down = new Error('down')

        // Todo 1 is down.
        api.withArgs(1).and.returnValue(throwError(() => down))

        const { id, results } = selected(api, { retry: 1, retryDelay: 100 })

        // In an app without zone.js, a timer that moves the list on, a
        // debounce say, may run while the retry waits, and the retry may come
        // due before change detection runs.
        tick(50)
        id.set(2)
        tick(50)

        expect(api.calls.allArgs()).toEqual([[1]])
        expect(results()[0].error()).toBe(down)
      }))

      it("doesn't refetch it when it's invalidated before change detection", () => {
        const api = todoApi()
        const { id } = selected(api)

        // As a click handler that selects the next todo and refreshes the
        // todos would.
        id.set(2)
        void client.invalidateQueries({ queryKey: ['todo'] })

        expect(api.calls.allArgs()).toEqual([[1]])
        expect(client.getQueryData(['todo', 1])).toBe('todo 1')
      })

      it("doesn't poll it before change detection", fakeAsync(() => {
        const api = todoApi()
        const { fixture, id } = selected(api, { refetchInterval: 100 })

        tick(99)
        id.set(2)
        tick(1)

        expect(api.calls.allArgs()).toEqual([[1]])
        expect(client.getQueryData(['todo', 1])).toBe('todo 1')

        fixture.destroy()
        flush()
      }))

      it("doesn't refetch it when the user comes back to the page before change detection", () => {
        const api = todoApi()
        const { id } = selected(api)

        id.set(2)
        leaveAndComeBack()

        expect(api.calls.allArgs()).toEqual([[1]])
        expect(client.getQueryData(['todo', 1])).toBe('todo 1')
      })

      it('drops the refetch that an invalidation queued during its first load', () => {
        const api = todoApi()
        const load = new Subject<string>()

        // Todo 1's first load is still in flight.
        api.withArgs(1).and.returnValue(load)

        const { id } = selected(api)

        void client.invalidateQueries({ queryKey: ['todo'] })
        id.set(2)
        // The load lands before change detection.
        load.next('todo 1')
        load.complete()

        expect(api.calls.allArgs()).toEqual([[1]])
        expect(client.getQueryData(['todo', 1])).toBe('todo 1')
      })

      it('drops the refetch that its refetch() asked for during its first load', fakeAsync(() => {
        const api = todoApi()
        const load = new Subject<string>()

        // Todo 1's first load is still in flight.
        api.withArgs(1).and.returnValue(load)

        const { id, results } = selected(api)
        const refetched = settled(results()[0].refetch())

        id.set(2)
        // The load lands before change detection.
        load.next('todo 1')
        load.complete()
        flushMicrotasks()

        expect(api.calls.allArgs()).toEqual([[1]])
        expect(client.getQueryData(['todo', 1])).toBe('todo 1')
        expect(refetched.value).toEqual({ data: 'todo 1', error: null })
      }))

      it('leaves it to the component still showing it how setQueryData merges into it', () => {
        const listMerge = jasmine
          .createSpy('listMerge')
          .and.callFake((_previous: unknown, data: unknown) => data)
        const otherMerge = jasmine
          .createSpy('otherMerge')
          .and.callFake((_previous: unknown, data: unknown) => data)
        const { id } = selected(() => of('todo 1'), {
          staleTime: Infinity,
          structuralSharing: listMerge,
        })

        // Another component shows todo 1, with a merge of its own.
        mountHost(() =>
          injectQuery(() => ({
            queryKey: ['todo', 1],
            queryFn: () => of('todo 1'),
            staleTime: Infinity,
            structuralSharing: otherMerge,
          })),
        )
        listMerge.calls.reset()

        id.set(2)
        client.setQueryData(['todo', 1], 'edited')

        expect(listMerge).not.toHaveBeenCalled()
        expect(otherMerge).toHaveBeenCalledOnceWith('todo 1', 'edited')
      })

      it('makes no request for refetch() of its result before change detection', fakeAsync(() => {
        const api = todoApi()
        const { id, results } = selected(api)

        id.set(2)

        const refetched = settled(results()[0].refetch())

        flushMicrotasks()

        expect(api.calls.allArgs()).toEqual([[1]])
        expect(refetched.value).toEqual({ data: 'todo 1', error: null })
      }))

      it('makes no request for refetch() of its result after change detection', fakeAsync(() => {
        const api = todoApi()
        const { fixture, id, results } = selected(api)
        const [first] = results()

        id.set(2)
        fixture.detectChanges()

        const refetched = settled(first.refetch())

        flushMicrotasks()

        // Only the load of todo 2, by the query that took its place.
        expect(api.calls.allArgs()).toEqual([[1], [2]])
        expect(refetched.value).toEqual({ data: 'todo 1', error: null })
      }))
    })

    describe('while its key stays in the list', () => {
      // A page showing the selected todo, todo 1, next to the one before it,
      // todo 2: each queryFn reads its signal when it runs, and so do the
      // `options` a spec adds to each query, which learn which of the two it
      // shows. Going back trades their keys, and `back()` does it before
      // change detection.
      function selectedAndPrevious(
        api: (id: number) => Observable<string>,
        options: (
          id: () => number,
          shows: 'selected' | 'previous',
        ) => Partial<QueryOptions<string>> = () => ({}),
      ) {
        const current = signal(1)
        const previous = signal(2)
        const { fixture, results } = mount(() => ({
          queries: [
            {
              queryKey: ['todo', current()],
              queryFn: () => api(current()),
              ...options(current, 'selected'),
            },
            {
              queryKey: ['todo', previous()],
              queryFn: () => api(previous()),
              ...options(previous, 'previous'),
            },
          ],
        }))
        const back = (): void => {
          current.set(2)
          previous.set(1)
        }

        return { fixture, results, back }
      }

      it('refetches it with the queryFn that the list gives its key now', () => {
        const api = todoApi()
        const { back } = selectedAndPrevious(api)

        back()
        void client.invalidateQueries({ queryKey: ['todo'] })

        expect(api.calls.allArgs()).toEqual([[1], [2], [1], [2]])
        expect(client.getQueryData(['todo', 1])).toBe('todo 1')
        expect(client.getQueryData(['todo', 2])).toBe('todo 2')
      })

      it('refetches it by hand with the queryFn that the list gives its key now', fakeAsync(() => {
        const api = todoApi()
        const { results, back } = selectedAndPrevious(api)
        // The result of todo 1.
        const [first] = results()

        back()

        const refetched = settled(first.refetch())

        flushMicrotasks()

        expect(api.calls.allArgs()).toEqual([[1], [2], [1]])
        expect(refetched.value).toEqual({ data: 'todo 1', error: null })
      }))

      it('seeds it with the initialData that the list gives its key now when refetch() puts it back', () => {
        const api = todoApi()
        // Each todo shows a summary from elsewhere until it loads.
        const { results, back } = selectedAndPrevious(api, (id) => ({
          initialData: () => `summary ${id()}`,
        }))
        // The result of todo 1.
        const [first] = results()

        client.removeQueries({ queryKey: ['todo', 1], exact: true })
        back()
        // The refetch is still in flight.
        api.and.returnValue(new Subject<string>())
        void first.refetch()

        expect(client.getQueryData(['todo', 1])).toBe('summary 1')
      })

      it('seeds it with the initialData that the list gives its key now when a poll puts it back', fakeAsync(() => {
        const api = todoApi()
        // Each todo shows a summary from elsewhere until it loads, and polls.
        const { fixture, back } = selectedAndPrevious(api, (id) => ({
          initialData: () => `summary ${id()}`,
          refetchInterval: 100,
        }))

        client.removeQueries({ queryKey: ['todo', 1], exact: true })
        back()
        // The poll is still in flight.
        api.and.returnValue(new Subject<string>())
        tick(100)

        expect(client.getQueryData(['todo', 1])).toBe('summary 1')

        fixture.destroy()
        flush()
      }))

      it('retries it with the queryFn that the list gives its key now, also when that query is turned off', fakeAsync(() => {
        const api = todoApi()
        const down = new Error('down')

        // Todo 1's first request fails.
        api.withArgs(1).and.returnValues(
          throwError(() => down),
          of('todo 1'),
        )

        // The todo before the selected one shows what the cache holds, and
        // fetches nothing.
        const { back } = selectedAndPrevious(api, (_id, shows) => ({
          retry: 1,
          retryDelay: 100,
          enabled: shows === 'selected',
        }))

        tick(50)
        // Going back moves todo 1 to the query that is turned off, while its
        // retry waits.
        back()
        tick(50)

        expect(api.calls.allArgs()).toEqual([[1], [1]])
        expect(client.getQueryData(['todo', 1])).toBe('todo 1')
      }))

      it("doesn't refetch it when it's invalidated after the list turned it off", () => {
        const api = todoApi()
        const enabled = signal(true)

        mount(() => ({
          queries: [
            {
              queryKey: ['todo', 1],
              queryFn: () => api(1),
              enabled: enabled(),
            },
          ],
        }))

        // As a click handler that turns the todo off and refreshes the todos
        // would, before change detection.
        enabled.set(false)
        void client.invalidateQueries({ queryKey: ['todo'] })

        expect(api.calls.allArgs()).toEqual([[1]])
      })

      it('refetches it when the user comes back to the page, as the list asks now', () => {
        const api = todoApi()
        // A setting that has the todo refreshed whenever the user comes back
        // to the page; off, it's kept as it is.
        const refresh = signal(false)

        mount(() => ({
          queries: [
            {
              queryKey: ['todo', 1],
              queryFn: () => api(1),
              staleTime: refresh() ? 0 : Infinity,
              refetchOnWindowFocus: refresh(),
            },
          ],
        }))

        // Turned on, and the user leaves and comes back, before change
        // detection.
        refresh.set(true)
        leaveAndComeBack()

        expect(api.calls.allArgs()).toEqual([[1], [1]])
      })

      it('retries a refetch of it as many times as the list says now', fakeAsync(() => {
        const api = todoApi()
        const down = new Error('down')
        const retries = signal(0)

        // The load works, the refetch fails once, and its retry works.
        api.and.returnValues(
          of('todo 1'),
          throwError(() => down),
          of('todo 1 again'),
        )

        mount(() => ({
          queries: [
            {
              queryKey: ['todo', 1],
              queryFn: () => api(1),
              retry: retries(),
              retryDelay: 100,
            },
          ],
        }))

        // The list asks for a retry and the todos are refreshed, before
        // change detection.
        retries.set(1)
        void client.invalidateQueries({ queryKey: ['todo'] })
        tick(100)

        expect(api).toHaveBeenCalledTimes(3)
        expect(client.getQueryData(['todo', 1])).toBe('todo 1 again')
      }))

      it("hands the app's callbacks the meta that the list gives it now", fakeAsync(() => {
        const metas: unknown[] = []

        TestBed.resetTestingModule()
        TestBed.configureTestingModule({
          providers: [
            provideQueryClient(
              withQueryCache({
                onSuccess: (_data, query) => metas.push(query.meta),
              }),
            ),
          ],
        })

        const page = signal(1)

        mount(() => ({
          queries: [
            {
              queryKey: ['todo', 1],
              queryFn: () => of('todo 1'),
              meta: { page: page() },
            },
          ],
        }))

        // The list moves to another page and the todos are refreshed, before
        // change detection.
        page.set(2)
        void TestBed.inject(QueryClient).invalidateQueries({
          queryKey: ['todo'],
        })
        flush()

        // The load on mount, then the refetch.
        expect(metas).toEqual([{ page: 1 }, { page: 2 }])
      }))

      it('refetches a key listed twice when only its second query is enabled', () => {
        const api = todoApi()

        // Only the second one is enabled: it loads todo 1, and it refetches
        // todo 1 when it's invalidated.
        mount(() => ({
          queries: [false, true].map((enabled) => ({
            queryKey: ['todo', 1],
            queryFn: () => api(1),
            enabled,
          })),
        }))
        void client.invalidateQueries({ queryKey: ['todo', 1] })

        expect(api.calls.allArgs()).toEqual([[1], [1]])
      })

      it('refetches each query of a key listed twice with its own queryFn, also once the list has changed', () => {
        const api = jasmine.createSpy('api').and.returnValue(of('todo 1'))
        const retries = signal(0)
        const { fixture, results } = mount(() => ({
          queries: ['first', 'second'].map((name) => ({
            queryKey: ['todo', 1],
            queryFn: () => api(name),
            staleTime: Infinity,
            retry: retries(),
          })),
        }))

        // The list changes, its keys the same.
        retries.set(1)
        fixture.detectChanges()
        api.calls.reset()

        void results()[0].refetch()
        void results()[1].refetch()

        expect(api.calls.allArgs()).toEqual([['first'], ['second']])
      })

      it('makes no request for refetch() of the second query of a key once the list holds the key only once', fakeAsync(() => {
        const api = todoApi()
        const count = signal(2)
        const { results } = mount(() => ({
          queries: Array.from({ length: count() }, () => ({
            queryKey: ['todo', 1],
            queryFn: () => api(1),
            staleTime: Infinity,
          })),
        }))

        // The list drops the second one, before change detection.
        count.set(1)

        const refetched = settled(results()[1].refetch())

        flushMicrotasks()

        expect(api.calls.allArgs()).toEqual([[1]])
        expect(refetched.value).toEqual({ data: 'todo 1', error: null })
      }))
    })

    // Like a detail page whose item is gone on sign-out before Angular
    // destroys it: the options function throws until it has an item again.
    describe('while the options function throws', () => {
      it("doesn't refetch it when it's invalidated, and does once the options function gives options again", () => {
        const api = todoApi()
        const item = signal<{ id: number } | null>({ id: 1 })

        mount(() => {
          // The queryFn takes the id along, so the request it makes stands
          // even when the options function can't read the item.
          const { id } = item()!

          return {
            queries: [{ queryKey: ['todo', id], queryFn: () => api(id) }],
          }
        })

        item.set(null)
        void client.invalidateQueries({ queryKey: ['todo'] })

        expect(api.calls.allArgs()).toEqual([[1]])

        item.set({ id: 1 })
        void client.invalidateQueries({ queryKey: ['todo'] })

        expect(api.calls.allArgs()).toEqual([[1], [1]])
      })
    })
  })

  describe('aggregation', () => {
    it('composes with computed', () => {
      const subjects = [new Subject<number>(), new Subject<number>()]
      const { results } = mount(() => ({
        queries: subjects.map((subject, index) => ({
          queryKey: ['agg', index],
          queryFn: () => subject,
        })),
      }))
      const isPending = computed(() =>
        results().some((item) => item.isPending()),
      )
      const total = computed(() =>
        results().reduce((sum, item) => sum + (item.data() ?? 0), 0),
      )

      expect(isPending()).toBe(true)
      expect(total()).toBe(0)

      subjects[0].next(1)
      subjects[0].complete()

      expect(isPending()).toBe(true)
      expect(total()).toBe(1)

      subjects[1].next(2)
      subjects[1].complete()

      expect(isPending()).toBe(false)
      expect(total()).toBe(3)
    })
  })

  describe('lifecycle', () => {
    it('releases every observer when the host is destroyed', () => {
      const { fixture } = mount(() => ({
        queries: [1, 2].map((id) => ({
          queryKey: ['d', id],
          queryFn: () => of(id),
          staleTime: Infinity,
        })),
      }))
      const cache = client.getQueryCache()

      expect(cache.get(['d', 1])?.observerCount).toBe(1)
      expect(cache.get(['d', 2])?.observerCount).toBe(1)

      fixture.destroy()

      expect(cache.get(['d', 1])?.observerCount).toBe(0)
      expect(cache.get(['d', 2])?.observerCount).toBe(0)
    })

    it('stops polling for a removed query', fakeAsync(() => {
      const ids = signal([1, 2])
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(id))
      const { fixture } = mount(() => ({
        queries: ids().map((id) => ({
          queryKey: ['p', id],
          queryFn: () => queryFn(id),
          refetchInterval: 100,
        })),
      }))

      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])

      ids.set([1])
      fixture.detectChanges()
      queryFn.calls.reset()

      tick(100)

      // Only the surviving query polls.
      expect(queryFn.calls.allArgs()).toEqual([[1]])

      fixture.destroy()
      flush()
    }))
  })

  describe('after removeQueries', () => {
    it('follows a query of the list back into the cache', () => {
      const { fixture, results } = mount(
        (ids) => ({
          queries: ids().map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => of(`todo-${id}`),
            staleTime: Infinity,
          })),
        }),
        [1, 2],
      )

      client.removeQueries({ queryKey: ['todo', 1], exact: true })
      fixture.detectChanges()
      client.setQueryData(['todo', 1], 'edited')
      fixture.detectChanges()

      expect(results().map((todo) => todo.data())).toEqual(['edited', 'todo-2'])
    })
  })

  // optionsFn may read what a component only has once it's rendered: its
  // inputs, and fields declared after the call. So it must not run while the
  // host is being constructed.
  describe('options evaluation', () => {
    it('does not call optionsFn while the host is being constructed', () => {
      const optionsFn = jasmine.createSpy('optionsFn').and.returnValue({
        queries: [{ queryKey: ['lazy'], queryFn: () => of(1) }],
      })

      @Component({ template: '' })
      class Host {
        readonly results = injectQueries<number>(optionsFn)
      }

      const fixture = TestBed.createComponent(Host)

      expect(optionsFn).not.toHaveBeenCalled()

      fixture.detectChanges()

      expect(optionsFn).toHaveBeenCalled()
      expect(fixture.componentInstance.results()[0].data()).toBe(1)
    })

    it('reads an input.required bound by the parent template', () => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(`todo-${id}`))
      const { fixture, results, value } = mount(
        (ids) => ({
          queries: ids().map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => queryFn(id),
          })),
        }),
        [1, 2],
      )

      expect(results().map((todo) => todo.data())).toEqual(['todo-1', 'todo-2'])

      value.set([1, 2, 3])
      fixture.detectChanges()

      expect(results().map((todo) => todo.data())).toEqual([
        'todo-1',
        'todo-2',
        'todo-3',
      ])
      expect(queryFn.calls.allArgs()).toEqual([[1], [2], [3]])
    })

    it('reads a field declared after the call', () => {
      @Component({ template: '' })
      class Host {
        readonly results = injectQueries(() => ({
          queries: this.ids().map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => of(`todo-${id}`),
          })),
        }))

        // Declared after the call on purpose: it doesn't exist yet while the
        // queries are being created.
        readonly ids = signal([1, 2])
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      expect(
        fixture.componentInstance.results().map((todo) => todo.data()),
      ).toEqual(['todo-1', 'todo-2'])
    })

    it('sees cached data and initialData when read before the first effect run', () => {
      // staleTime 0: once the fetch effects run, both refetch in the
      // background. That no fetch has happened yet by ngOnInit is the proof
      // that the read came first.
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('fresh'))
      let seenInOnInit: unknown[] = []

      client.setQueryData(['cached', 1], 'from cache')

      @Component({ selector: 'app-host', template: '' })
      class Host implements OnInit {
        readonly id = input.required<number>()

        readonly results = injectQueries(() => ({
          queries: [
            { queryKey: ['cached', this.id()], queryFn },
            {
              queryKey: ['seeded', this.id()],
              queryFn,
              initialData: 'from initialData',
            },
          ],
        }))

        ngOnInit(): void {
          seenInOnInit = [
            queryFn.calls.count(),
            ...this.results().map((result) => result.data()),
          ]
        }
      }

      @Component({ imports: [Host], template: '<app-host [id]="1" />' })
      class Parent {}

      TestBed.createComponent(Parent).detectChanges()

      expect(seenInOnInit).toEqual([0, 'from cache', 'from initialData'])
      expect(queryFn).toHaveBeenCalledTimes(2)
    })

    it('creates nothing when first read after the host is destroyed', () => {
      const optionsFn = jasmine.createSpy('optionsFn').and.returnValue({
        queries: [{ queryKey: ['gone'], queryFn: () => of(1) }],
      })

      @Component({ template: '' })
      class Host {
        readonly results = injectQueries<number>(optionsFn)
      }

      const fixture = TestBed.createComponent(Host)
      const { results } = fixture.componentInstance

      // Destroyed before change detection ever ran, and before any read.
      fixture.destroy()

      expect(results()).toEqual([])
      expect(optionsFn).not.toHaveBeenCalled()
      expect(client.getQueryCache().get(['gone'])).toBeUndefined()
    })

    it('runs the options function once per change of what it reads', () => {
      const ids = signal([1])
      let runs = 0
      const { fixture } = mount(() => {
        runs++

        return {
          queries: ids().map((id) => ({
            queryKey: ['todo', id],
            queryFn: () => of(`todo-${id}`),
          })),
        }
      })

      expect(runs).toBe(1)

      // The library reads the list in between: an invalidation.
      ids.set([1, 2])
      void client.invalidateQueries({ queryKey: ['todo'] })
      fixture.detectChanges()

      expect(runs).toBe(2)
    })

    describe('when it gives a query a new key on every run', () => {
      // Like a key with the current time in it would: each run of the options
      // function gives the query another key.
      function mountReport(queryFn: () => Observable<string>) {
        let runs = 0

        @Component({ template: '' })
        class Host {
          readonly results = injectQueries<string>(() => ({
            queries: [{ queryKey: ['report', ++runs], queryFn }],
          }))
        }

        return TestBed.createComponent(Host)
      }

      it('loads the query', () => {
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.returnValue(of('report'))
        const fixture = mountReport(queryFn)

        fixture.detectChanges()

        expect(queryFn).toHaveBeenCalledTimes(1)
        expect(fixture.componentInstance.results()[0].data()).toBe('report')
      })

      it('keeps the result read before change detection', () => {
        const queryFn = jasmine
          .createSpy('queryFn')
          .and.returnValue(of('report'))
        const fixture = mountReport(queryFn)
        // Read before change detection, as a template or a computed may.
        const [first] = fixture.componentInstance.results()

        fixture.detectChanges()

        expect(fixture.componentInstance.results()[0]).toBe(first)
        expect(first.data()).toBe('report')
      })
    })
  })

  describe('in a hidden tab', () => {
    it("doesn't poll the list's queries", fakeAsync(() => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(id))
      const { fixture } = mount(() => ({
        queries: [1, 2].map((id) => ({
          queryKey: ['p', id],
          queryFn: () => queryFn(id),
          refetchInterval: 100,
        })),
      }))

      setVisibility('hidden')
      tick(300)
      fixture.detectChanges()

      // Each fetched once, on mount.
      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])

      fixture.destroy()
    }))

    // A query of the list that polls every 100 ms, mounted, then hidden:
    // `background` says whether it keeps polling there.
    function pollingInBackground(
      queryFn: () => Observable<string>,
      keepPolling: boolean,
    ) {
      const background = signal(keepPolling)
      const { fixture } = mount(() => ({
        queries: [
          {
            queryKey: ['report'],
            queryFn,
            refetchInterval: 100,
            refetchIntervalInBackground: background(),
          },
        ],
      }))

      setVisibility('hidden')

      return { fixture, background }
    }

    it('polls a query once the list asks to keep polling there, before change detection', fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('report'))
      const { fixture, background } = pollingInBackground(queryFn, false)

      tick(50)
      background.set(true)
      tick(50)

      // Once on mount, then the poll.
      expect(queryFn).toHaveBeenCalledTimes(2)

      fixture.destroy()
    }))

    it('stops polling a query once the list asks to stop polling there, before change detection', fakeAsync(() => {
      const queryFn = jasmine.createSpy('queryFn').and.returnValue(of('report'))
      const { fixture, background } = pollingInBackground(queryFn, true)

      tick(50)
      background.set(false)
      tick(50)

      // Once on mount only.
      expect(queryFn).toHaveBeenCalledTimes(1)

      fixture.destroy()
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
    })

    it("doesn't poll", fakeAsync(() => {
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(id))
      const { fixture } = mount(() => ({
        queries: [1, 2].map((id) => ({
          queryKey: ['p', id],
          queryFn: () => queryFn(id),
          refetchInterval: 100,
        })),
      }))

      tick(1_000)
      fixture.detectChanges()

      // Each fetched once, on mount: the browser polls once it takes over.
      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])

      fixture.destroy()
    }))
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      expect(() => injectQueries(() => ({ queries: [] }))).toThrowError(
        /NG0203|injection context/,
      )
    })

    it('works outside an injection context when given an injector', () => {
      const injector = TestBed.inject(Injector)
      const ids = signal([1])
      const queryFn = jasmine
        .createSpy('queryFn')
        .and.callFake((id: number) => of(id * 10))

      const results = injectQueries(
        () => ({
          queries: ids().map((id) => ({
            queryKey: ['inj', id],
            queryFn: () => queryFn(id),
            staleTime: Infinity,
          })),
        }),
        { injector },
      )

      // Effects are tied to the environment injector; flush them explicitly.
      TestBed.inject(ApplicationRef).tick()

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(results()[0].data()).toBe(10)

      ids.set([1, 2])
      TestBed.inject(ApplicationRef).tick()

      expect(results().length).toBe(2)
      expect(results()[1].data()).toBe(20)
      expect(queryFn.calls.allArgs()).toEqual([[1], [2]])
    })
  })
})
