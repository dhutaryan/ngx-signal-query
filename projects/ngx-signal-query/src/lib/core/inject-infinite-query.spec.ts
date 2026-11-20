import {
  ApplicationRef,
  EnvironmentInjector,
  type Signal,
  createEnvironmentInjector,
  effect,
  signal,
} from '@angular/core'
import {
  TestBed,
  fakeAsync,
  flushMicrotasks,
  tick,
} from '@angular/core/testing'
import { of, Subject, throwError } from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import {
  type List,
  type ListOptions,
  type Page,
  type Server,
  listOptions,
  server,
  threePages,
} from '../../spec-helpers/list-server'
import {
  leaveAndComeBack,
  pinVisible,
  restoreVisibility,
} from '../../spec-helpers/page-events'
import { settled } from '../../spec-helpers/promises'
import { injectInfiniteQuery } from './inject-infinite-query'
import { keepPreviousData } from './keep-previous-data'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import { type Deferred, deferred } from './utils'

// Mounts injectInfiniteQuery in a host component, as mountHost() mounts
// anything: its options may read the host's input.required `value`.
function mount<TValue = number>(
  optionsFn: (value: Signal<TValue>) => ListOptions,
  value?: TValue,
) {
  const mounted = mountHost(
    (hostValue: Signal<TValue>) =>
      injectInfiniteQuery(() => optionsFn(hostValue)),
    value,
  )

  return {
    fixture: mounted.fixture,
    result: mounted.created,
    value: mounted.value,
  }
}

describe('injectInfiniteQuery', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
  })

  // Polling waits while the page is hidden, so the specs mustn't depend on
  // what the test runner's window does.
  beforeEach(pinVisible)
  afterEach(restoreVisibility)

  describe('loading', () => {
    it('fetches the first page on mount, with initialPageParam', () => {
      const api = server()
      const { result } = mount(() => listOptions(api))

      expect(api.sent).toEqual([0])
      expect(result.status()).toBe('success')
      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
    })

    it('hands the query function the key, the signal and the param of the page', () => {
      const api = server()
      const contexts: object[] = []

      mount(() =>
        listOptions(api, {
          queryFn: (context) => {
            contexts.push({ ...context })

            return api.queryFn(context)
          },
        }),
      )

      expect(contexts).toEqual([
        {
          queryKey: ['list'],
          signal: jasmine.any(AbortSignal),
          pageParam: 0,
        },
      ])
    })

    it('fetches a page with a Promise as well', fakeAsync(() => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, {
          queryFn: ({ pageParam }) => Promise.resolve(api.page(pageParam)),
        }),
      )

      flushMicrotasks()

      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
    }))

    it("doesn't fetch while disabled, and fetches the first page once enabled", () => {
      const api = server()
      const { fixture, result, value } = mount(
        (enabled) => listOptions(api, { enabled: enabled() }),
        false,
      )

      expect(api.sent).toEqual([])

      value.set(true)
      fixture.detectChanges()

      expect(api.sent).toEqual([0])
      expect(result.data()?.pageParams).toEqual([0])
    })

    it('fetches the first page of the next key when the key changes, and keeps the pages of the one it left', () => {
      const api = server()
      const { fixture, result, value } = mount(
        (id) => listOptions(api, { queryKey: ['list', id()] }),
        1,
      )

      value.set(2)
      fixture.detectChanges()

      expect(api.sent).toEqual([0, 0])
      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
      expect(client.getQueryData<List>(['list', 1])?.pageParams).toEqual([0])
    })

    it("shows the pages of the key it left with keepPreviousData while the next key's first page loads", () => {
      const api = server()
      const next = new Subject<Page>()
      const { fixture, result, value } = mount(
        (id) =>
          listOptions(api, {
            queryKey: ['list', id()],
            queryFn: ({ queryKey, pageParam }) =>
              queryKey[1] === 2 ? next : of(api.page(pageParam)),
            placeholderData: keepPreviousData,
          }),
        1,
      )
      const left = result.data()

      value.set(2)
      fixture.detectChanges()

      expect(result.data()).toBe(left)
      expect(result.isPlaceholderData()).toBeTrue()

      api.version = 1
      next.next(api.page(0))

      expect(result.isPlaceholderData()).toBeFalse()
      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
    })

    // As for a query: a retry of the first load that starts after an
    // invalidation reads the list after it.
    it("doesn't refetch once a retry of the first page that started after an invalidation lands", fakeAsync(() => {
      const api = server()

      api.failOnce.add(0)

      const { result } = mount(() =>
        listOptions(api, { retry: 1, retryDelay: 10 }),
      )

      api.version = 1
      client.invalidateQueries({ queryKey: ['list'] })
      tick(10)

      expect(api.sent).toEqual([0, 0])
      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
    }))

    it('is fresh once its first load lands after an invalidation made before it', () => {
      const api = server()
      const enabled = signal(false)
      const { fixture } = mount(() =>
        listOptions(api, { enabled: enabled(), staleTime: Infinity }),
      )

      client.invalidateQueries({ queryKey: ['list'] })
      enabled.set(true)
      fixture.detectChanges()
      // A component that shows the list from now on finds it fresh.
      mount(() => listOptions(api, { staleTime: Infinity }))

      expect(api.sent).toEqual([0])
    })
  })

  // Whatever asks for it, a refetch fetches the pages the query holds again,
  // in order: the first with its own param, each next one with the param
  // getNextPageParam gives for the page just fetched.
  describe('a refetch', () => {
    it('on mount fetches pages that are stale again, as many as the query holds', () => {
      const api = server()
      const seeded = threePages(api)

      api.version = 1

      const { result } = mount(() => listOptions(api, { initialData: seeded }))

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.data()).toEqual(threePages(api))
    })

    // As in the issue: with item 1 gone, asking for the params the pages
    // were fetched with, 0, 2 and 4, would bring item 2 twice.
    it('by invalidateQueries() fetches each next page with the param the page just fetched gives, not the one it was fetched with', () => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, { initialData: threePages(api), staleTime: Infinity }),
      )

      api.items = api.items.filter((item) => item !== 1)
      client.invalidateQueries({ queryKey: ['list'] })

      expect(api.sent).toEqual([0, 3, 5])
      expect(result.data()?.pages.map((page) => page.items)).toEqual([
        ['0@v0', '2@v0'],
        ['3@v0', '4@v0'],
        ['5@v0', '6@v0'],
      ])
      expect(result.data()?.pageParams).toEqual([0, 3, 5])
    })

    it('by refetch() fetches the pages the query holds', () => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, { initialData: threePages(api), staleTime: Infinity }),
      )

      api.version = 1
      result.refetch()

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.data()).toEqual(threePages(api))
    })

    it('by polling fetches the pages the query holds', fakeAsync(() => {
      const api = server()
      const { fixture, result } = mount(() =>
        listOptions(api, {
          initialData: threePages(api),
          staleTime: Infinity,
          refetchInterval: 1000,
        }),
      )

      api.version = 1
      tick(1000)

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.data()).toEqual(threePages(api))

      fixture.destroy()
    }))

    it('on window focus fetches the pages the query holds once they are stale', fakeAsync(() => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, { initialData: threePages(api), staleTime: 1000 }),
      )

      api.version = 1
      tick(1000)
      leaveAndComeBack()

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.data()).toEqual(threePages(api))
    }))

    // As in the issue: with item 1 gone and page 3 failing once, the retry
    // asks for 3 again, then 5, rather than starting over at 0.
    it('goes on from the page that failed when the component retries it', fakeAsync(() => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, {
          initialData: threePages(api),
          staleTime: Infinity,
          retry: 1,
          retryDelay: 10,
        }),
      )

      api.items = api.items.filter((item) => item !== 1)
      api.failOnce.add(3)
      client.invalidateQueries({ queryKey: ['list'] })
      tick(10)

      expect(api.sent).toEqual([0, 3, 3, 5])
      expect(result.data()?.pageParams).toEqual([0, 3, 5])
    }))

    // retry counts the failures of the whole fetch, whichever pages they
    // come from.
    it('fails once its pages have failed more times in all than retry allows', fakeAsync(() => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, {
          initialData: threePages(api),
          staleTime: Infinity,
          retry: 1,
          retryDelay: 10,
        }),
      )
      const held = result.data()

      api.failOnce.add(2)
      api.failOnce.add(4)
      client.invalidateQueries({ queryKey: ['list'] })
      tick(10)

      expect(api.sent).toEqual([0, 2, 2, 4])
      expect(result.error()?.message).toBe('page 4 failed')
      expect(result.failureCount()).toBe(2)
      expect(result.data()).toBe(held)
    }))
  })

  describe('once the component showing it goes', () => {
    // As for a query: the request runs on, and what it brings is kept for
    // whoever comes back.
    it("lets a refetch that can't be stopped, a Promise that leaves the signal alone, fetch the rest of the pages, which stay cached", fakeAsync(() => {
      const api = server()
      const answers: Array<Deferred<Page>> = []
      const { fixture } = mount(() =>
        listOptions(api, {
          queryFn: ({ pageParam }) => {
            api.sent.push(pageParam)

            const answer = deferred<Page>()

            answers.push(answer)

            return answer.promise
          },
          initialData: threePages(api),
          staleTime: Infinity,
        }),
      )

      api.version = 1
      client.invalidateQueries({ queryKey: ['list'] })
      fixture.destroy()

      // Each page is answered as it's asked for; the next one is asked for
      // once it's in.
      for (const param of [0, 2, 4]) {
        answers.at(-1)?.resolve(api.page(param))
        flushMicrotasks()
      }

      expect(api.sent).toEqual([0, 2, 4])
      expect(client.getQueryData(['list'])).toEqual(threePages(api))
    }))

    it('stops an Observable refetch, and the pages the query held stay', () => {
      const api = server()
      const responses: Array<Subject<Page>> = []
      const { fixture } = mount(() =>
        listOptions(api, {
          queryFn: ({ pageParam }) => {
            api.sent.push(pageParam)

            const response = new Subject<Page>()

            responses.push(response)

            return response
          },
          initialData: threePages(api),
          staleTime: Infinity,
        }),
      )
      const held = client.getQueryData(['list'])

      client.invalidateQueries({ queryKey: ['list'] })
      fixture.destroy()

      expect(api.sent).toEqual([0])
      expect(responses[0].observed).toBeFalse()
      expect(client.getQueryData(['list'])).toBe(held)
    })

    // Its queryFn reads the key's id when it's called: by the next page it
    // would fetch the next list's page into this one.
    it('lands the refetch of the key it moved away from with the pages it has, and asks for none with its next key', fakeAsync(() => {
      const api = server()
      const answers: Array<Deferred<Page>> = []
      const asked: string[] = []
      const { fixture, value } = mount(
        (id) =>
          listOptions(api, {
            queryKey: ['list', id()],
            queryFn: ({ pageParam }) => {
              asked.push(`list ${id()}, page ${pageParam}`)

              const answer = deferred<Page>()

              answers.push(answer)

              return answer.promise
            },
            initialData: threePages(api),
            staleTime: Infinity,
          }),
        1,
      )

      api.version = 1
      client.invalidateQueries({ queryKey: ['list', 1] })
      // The component moves on to list 2 while list 1's first page is in
      // flight.
      value.set(2)
      fixture.detectChanges()
      answers[0].resolve(api.page(0))
      flushMicrotasks()

      expect(asked).toEqual(['list 1, page 0'])
      expect(client.getQueryData(['list', 1])).toEqual({
        pages: [api.page(0)],
        pageParams: [0],
      })
    }))
  })

  describe('the next page', () => {
    // The list's options, with getPreviousPageParam too.
    const previousToo: Partial<ListOptions> = {
      getPreviousPageParam: (firstPage) => firstPage.previous,
    }

    it('is fetched by fetchNextPage() with the param getNextPageParam gives, and added after the last one', fakeAsync(() => {
      const api = server()
      const { result } = mount(() => listOptions(api))

      expect(result.hasNextPage()).toBeTrue()

      const fetched = settled(result.fetchNextPage())

      flushMicrotasks()

      expect(api.sent).toEqual([0, 2])
      expect(result.data()).toEqual({
        pages: [api.page(0), api.page(2)],
        pageParams: [0, 2],
      })
      expect(fetched.value).toEqual({ data: result.data(), error: null })
    }))

    it('shows that it is being fetched to every component showing the query', () => {
      const api = server()
      const fetching = mount(() => listOptions(api)).result
      const watching = mount(() => listOptions(api)).result

      api.hold.add(2)
      fetching.fetchNextPage()

      expect(watching.isFetching()).toBeTrue()
      expect(watching.isFetchingNextPage()).toBeTrue()
      expect(watching.isFetchingPreviousPage()).toBeFalse()
      expect(watching.isLoading()).toBeFalse()

      api.answer(2)

      expect(watching.isFetchingNextPage()).toBeFalse()
      expect(watching.data()?.pageParams).toEqual([0, 2])
    })

    for (const none of [null, undefined]) {
      it(`isn't there once getNextPageParam gives ${none}: fetchNextPage() then fetches nothing and resolves at once`, fakeAsync(() => {
        const api = server()

        api.items = [0, 1]

        const { result } = mount(() =>
          listOptions(api, {
            getNextPageParam: (lastPage) => lastPage.next ?? none,
          }),
        )
        const updatedAt = result.dataUpdatedAt()

        // Any fetch landing from here on would move dataUpdatedAt.
        tick(1)

        expect(result.hasNextPage()).toBeFalse()

        const fetched = settled(result.fetchNextPage())

        expect(result.isFetching()).toBeFalse()

        flushMicrotasks()

        expect(api.sent).toEqual([0])
        expect(result.dataUpdatedAt()).toBe(updatedAt)
        expect(fetched.value).toEqual({ data: result.data(), error: null })
      }))
    }

    it("isn't there while the query holds no pages: fetchNextPage() fetches the first one, even while disabled", () => {
      const api = server()
      const { result } = mount(() => listOptions(api, { enabled: false }))

      expect(result.hasNextPage()).toBeFalse()

      api.hold.add(0)
      result.fetchNextPage()

      expect(result.isLoading()).toBeTrue()
      expect(result.isFetchingNextPage()).toBeFalse()

      api.answer(0)

      expect(api.sent).toEqual([0])
      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
    })

    it("isn't there while the list holds no pages: fetchNextPage() fetches the first one", () => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, {
          initialData: { pages: [], pageParams: [] },
          staleTime: Infinity,
        }),
      )

      expect(result.hasNextPage()).toBeFalse()

      result.fetchNextPage()

      expect(api.sent).toEqual([0])
      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
    })

    // The first page is fetched for the component that asked, as a page is:
    // its query function, which reads its key's value when it runs, mustn't
    // retry it once it has moved to another key.
    it("isn't there while the query holds no pages: the first one fetchNextPage() fetches isn't retried once the component that asked moved to another key", fakeAsync(() => {
      const api = server()
      const asked: string[] = []
      const { fixture, result, value } = mount(
        (id) =>
          listOptions(api, {
            queryKey: ['list', id()],
            enabled: false,
            retry: 1,
            retryDelay: 10,
            queryFn: ({ pageParam }) => {
              asked.push(`list ${id()}, page ${pageParam}`)

              return asked.length === 1
                ? throwError(() => new Error('down'))
                : of(api.page(pageParam))
            },
          }),
        1,
      )

      // Keeps list 1 shown, without asking for it.
      mount(() => listOptions(api, { queryKey: ['list', 1], enabled: false }))
      result.fetchNextPage()
      value.set(2)
      fixture.detectChanges()
      tick(10)

      expect(asked).toEqual(['list 1, page 0'])
      expect(client.getQueryData(['list', 1])).toBeUndefined()
    }))

    it("isn't there while placeholder data shows: it's read from the pages the query holds", () => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, {
          enabled: false,
          placeholderData: { pages: [api.page(0)], pageParams: [0] },
        }),
      )

      expect(result.isPlaceholderData()).toBeTrue()
      expect(result.hasNextPage()).toBeFalse()
    })

    it('waits for a fetch in flight even when there is no next page, and resolves once it is in', fakeAsync(() => {
      const api = server()

      api.items = [0, 1]

      const { result } = mount(() => listOptions(api))

      api.hold.add(0)
      result.refetch()

      const fetched = settled(result.fetchNextPage())

      flushMicrotasks()

      expect(fetched.value).toBeUndefined()

      api.answer(0)
      flushMicrotasks()

      expect(fetched.value).toEqual({ data: result.data(), error: null })
    }))

    // A retry is made for someone who still wants the page, as for any
    // fetch: not the component that went away, nor one that's disabled.
    it('stops being retried once the component that asked for it goes, while a disabled one stays', fakeAsync(() => {
      const api = server()
      const asking = mount(() => listOptions(api, { retry: 1, retryDelay: 10 }))
      const watching = mount(() => listOptions(api, { enabled: false }))

      api.failOnce.add(2)
      asking.result.fetchNextPage()
      asking.fixture.destroy()
      tick(10)

      expect(api.sent).toEqual([0, 2])
      expect(watching.result.isFetchNextPageError()).toBeTrue()
    }))

    it('waits for the first load in flight, and no page is added', fakeAsync(() => {
      const api = server()

      api.hold.add(0)

      const { result } = mount(() => listOptions(api))
      const fetched = settled(result.fetchNextPage())

      api.answer(0)
      flushMicrotasks()

      expect(api.sent).toEqual([0])
      expect(result.data()?.pageParams).toEqual([0])
      expect(fetched.value?.data?.pageParams).toEqual([0])
    }))

    it('waits for another fetchNextPage() in flight, and the page is asked for once', fakeAsync(() => {
      const api = server()
      const { result } = mount(() => listOptions(api))

      api.hold.add(2)

      const first = settled(result.fetchNextPage())
      const second = settled(result.fetchNextPage())

      api.answer(2)
      flushMicrotasks()

      expect(api.sent).toEqual([0, 2])
      expect(first.value?.data?.pageParams).toEqual([0, 2])
      expect(second.value?.data?.pageParams).toEqual([0, 2])
    }))

    // Added to the pages the query held, it would show pages read before
    // the change next to pages read after it.
    it('waits for a refetch in flight, and no page is added: it can be asked for once the refetch is in', () => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, {
          initialData: {
            pages: [api.page(0), api.page(2)],
            pageParams: [0, 2],
          },
          staleTime: Infinity,
        }),
      )

      api.version = 1
      api.hold.add(0)
      client.invalidateQueries({ queryKey: ['list'] })
      result.fetchNextPage()

      expect(result.isFetchingNextPage()).toBeFalse()

      api.answer(0)

      expect(api.sent).toEqual([0, 2])
      expect(result.data()).toEqual({
        pages: [api.page(0), api.page(2)],
        pageParams: [0, 2],
      })

      result.fetchNextPage()

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.data()?.pageParams).toEqual([0, 2, 4])
    })

    it('is dropped when an invalidation refetches the pages the query holds meanwhile', fakeAsync(() => {
      const api = server()
      const { result } = mount(() => listOptions(api, { staleTime: Infinity }))

      api.hold.add(2)

      const fetched = settled(result.fetchNextPage())
      const nextPage = api.waiting.get(2)

      api.version = 1
      client.invalidateQueries({ queryKey: ['list'] })
      flushMicrotasks()

      expect(nextPage?.observed).toBeFalse()
      expect(api.sent).toEqual([0, 2, 0])
      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
      expect(fetched.value?.data).toEqual(result.data())
    }))

    it('fails into an error that keeps the pages, and shows that the next page failed', fakeAsync(() => {
      const api = server()
      const { result } = mount(() => listOptions(api, { retry: 0 }))

      api.failOnce.add(2)

      const fetched = settled(result.fetchNextPage())

      flushMicrotasks()

      expect(result.isError()).toBeTrue()
      expect(result.error()?.message).toBe('page 2 failed')
      expect(result.data()?.pageParams).toEqual([0])
      expect(result.isFetchNextPageError()).toBeTrue()
      expect(result.isFetchPreviousPageError()).toBeFalse()
      expect(fetched.value).toEqual({
        data: result.data(),
        error: result.error(),
      })
    }))

    // As isError() does, it shows the failure until a fetch lands.
    it('shows that it failed while it is asked for again, until it lands', () => {
      const api = server()
      const { result } = mount(() => listOptions(api, { retry: 0 }))

      api.failOnce.add(2)
      result.fetchNextPage()
      api.hold.add(2)
      result.fetchNextPage()

      expect(result.isFetchingNextPage()).toBeTrue()
      expect(result.isFetchNextPageError()).toBeTrue()

      api.answer(2)

      expect(result.isFetchNextPageError()).toBeFalse()
      expect(result.data()?.pageParams).toEqual([0, 2])
    })

    it('is asked for again when a retry follows its failure', fakeAsync(() => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, { retry: 1, retryDelay: 10 }),
      )

      api.failOnce.add(2)
      result.fetchNextPage()
      tick(10)

      expect(api.sent).toEqual([0, 2, 2])
      expect(result.data()?.pageParams).toEqual([0, 2])
      expect(result.isFetchNextPageError()).toBeFalse()
    }))

    // A page added to pages read before an invalidation doesn't make them
    // fresh: a component that shows the query later fetches them all again.
    it('leaves the stale mark of the pages it is added to', () => {
      const api = server()
      const shown = mount(() => listOptions(api, { staleTime: Infinity }))

      client.invalidateQueries({ queryKey: ['list'], refetchType: 'none' })
      shown.result.fetchNextPage()
      mount(() => listOptions(api, { staleTime: Infinity }))

      expect(api.sent).toEqual([0, 2, 0, 2])
    })

    it('drops the first page past maxPages, which fetchPreviousPage() brings back', () => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, { ...previousToo, maxPages: 2 }),
      )

      result.fetchNextPage()
      result.fetchNextPage()

      expect(result.data()?.pageParams).toEqual([2, 4])
      expect(result.hasPreviousPage()).toBeTrue()

      result.fetchPreviousPage()

      expect(result.data()?.pageParams).toEqual([0, 2])
    })
  })

  // Infinite scroll as the docs show it: an effect asks for the next page
  // while the end of the list shows, nothing loads and the next page hasn't
  // failed.
  function scrolled(api: Server, options: Partial<ListOptions> = {}) {
    const atEnd = signal(false)
    const { fixture, created } = mountHost(() => {
      const todos = injectInfiniteQuery(() =>
        listOptions(api, { staleTime: Infinity, ...options }),
      )

      effect(() => {
        if (
          atEnd() &&
          todos.hasNextPage() &&
          !todos.isFetching() &&
          !todos.isFetchNextPageError()
        ) {
          todos.fetchNextPage()
        }
      })

      return todos
    })

    return { fixture, todos: created, atEnd }
  }

  it('comes from an effect once a refetch in flight is in, and keeps coming while the end of the list shows', () => {
    const api = server()
    const { fixture, atEnd } = scrolled(api)

    // From here, each request waits to be answered, as over a network.
    api.hold = new Set([0, 2, 4, 6])
    client.invalidateQueries({ queryKey: ['list'] })
    atEnd.set(true)
    fixture.detectChanges()

    expect(api.sent).toEqual([0, 0])

    for (const param of [0, 2, 4, 6]) {
      api.answer(param)
      fixture.detectChanges()
    }

    expect(api.sent).toEqual([0, 0, 2, 4, 6])
    expect(client.getQueryData<List>(['list'])?.pageParams).toEqual([
      0, 2, 4, 6,
    ])
  })

  // Running again as each fetch ends, the effect would otherwise ask for the
  // page that failed over and over while the end of the list shows.
  it("doesn't come from an effect again for a next page that failed, until it's asked for and lands", () => {
    const api = server()
    const { fixture, todos, atEnd } = scrolled(api, { retry: 0 })

    // From here, each request waits to be answered, as over a network.
    api.hold = new Set([2, 4])
    atEnd.set(true)
    fixture.detectChanges()
    api.waiting.get(2)?.error(new Error('page 2 failed'))
    fixture.detectChanges()

    expect(api.sent).toEqual([0, 2])

    // As a "Try again" button does.
    todos.fetchNextPage()
    api.answer(2)
    fixture.detectChanges()

    expect(api.sent).toEqual([0, 2, 2, 4])
  })

  it('leaves no more than maxPages pages once a page is added after maxPages went down', () => {
    const api = server()
    const maxPages = signal<number | undefined>(undefined)
    const { result } = mount(() => listOptions(api, { maxPages: maxPages() }))

    result.fetchNextPage()
    result.fetchNextPage()
    maxPages.set(2)
    result.fetchNextPage()

    expect(api.sent).toEqual([0, 2, 4, 6])
    expect(result.data()?.pageParams).toEqual([4, 6])
  })

  it('shows whether the list of the key it moved to has a next page', () => {
    const api = server()
    const short = server()

    short.items = [0, 1]

    const { fixture, result, value } = mount(
      (id) =>
        listOptions(api, {
          queryKey: ['list', id()],
          queryFn: (context) =>
            context.queryKey[1] === 1
              ? short.queryFn(context)
              : api.queryFn(context),
        }),
      1,
    )

    expect(result.hasNextPage()).toBeFalse()

    value.set(2)
    fixture.detectChanges()

    expect(result.hasNextPage()).toBeTrue()
  })

  it('shows whether there is a next page as the options say, when only the options change', () => {
    const api = server()
    // The most pages the list may hold, read as the options are made.
    const most = signal(4)
    const { result } = mount(() => {
      const limit = most()

      return listOptions(api, {
        getNextPageParam: (lastPage, allPages) =>
          allPages.length >= limit ? null : lastPage.next,
      })
    })

    expect(result.hasNextPage()).toBeTrue()

    most.set(1)

    expect(result.hasNextPage()).toBeFalse()
  })

  it('loads the list again from its first page when asked for the next one after removeQueries(), as a first load', () => {
    const api = server()
    const { fixture, result } = mount(() => listOptions(api))

    result.fetchNextPage()
    client.removeQueries({ queryKey: ['list'] })
    api.hold.add(0)
    result.fetchNextPage()
    fixture.detectChanges()

    expect(result.isLoading()).toBeTrue()
    expect(result.isFetchingNextPage()).toBeFalse()

    api.answer(0)

    expect(api.sent).toEqual([0, 2, 0])
    expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })
  })

  // As Optimistic Updates does it: a fetch in flight would land over the
  // write, so it's cancelled first.
  it('keeps a write made once cancelQueries() stopped the page in flight, and the page can be asked for again', () => {
    const api = server()
    const { result } = mount(() => listOptions(api))

    api.hold.add(2)
    result.fetchNextPage()
    client.cancelQueries({ queryKey: ['list'] })
    client.setQueryData<List>(
      ['list'],
      (data) =>
        data && {
          pages: [{ ...data.pages[0], items: ['renamed', '1@v0'] }],
          pageParams: data.pageParams,
        },
    )

    expect(result.data()?.pages[0].items[0]).toBe('renamed')

    api.hold.clear()
    result.fetchNextPage()

    expect(api.sent).toEqual([0, 2, 2])
    expect(result.data()?.pages.map((page) => page.items[0])).toEqual([
      'renamed',
      '2@v0',
    ])
  })

  describe('the previous page', () => {
    const fromItem4: Partial<ListOptions> = {
      initialPageParam: 4,
      getPreviousPageParam: (firstPage) => firstPage.previous,
    }

    it('is fetched by fetchPreviousPage() with the param getPreviousPageParam gives, and added before the first one', () => {
      const api = server()
      const { result } = mount(() => listOptions(api, fromItem4))

      expect(result.hasPreviousPage()).toBeTrue()

      result.fetchPreviousPage()

      expect(api.sent).toEqual([4, 2])
      expect(result.data()).toEqual({
        pages: [api.page(2), api.page(4)],
        pageParams: [2, 4],
      })
    })

    it('shows that it is being fetched, and that it failed', () => {
      const api = server()
      const { result } = mount(() =>
        listOptions(api, { ...fromItem4, retry: 0 }),
      )

      api.hold.add(2)
      result.fetchPreviousPage()

      expect(result.isFetchingPreviousPage()).toBeTrue()
      expect(result.isFetchingNextPage()).toBeFalse()

      api.waiting.get(2)?.error(new Error('page 2 failed'))

      expect(result.isFetchPreviousPageError()).toBeTrue()
      expect(result.isFetchNextPageError()).toBeFalse()
      expect(result.data()?.pageParams).toEqual([4])
    })

    it("isn't there without getPreviousPageParam: fetchPreviousPage() then fetches nothing and resolves at once", fakeAsync(() => {
      const api = server()
      const { result } = mount(() => listOptions(api, { initialPageParam: 4 }))
      const updatedAt = result.dataUpdatedAt()

      // Any fetch landing from here on would move dataUpdatedAt.
      tick(1)

      expect(result.hasPreviousPage()).toBeFalse()

      const fetched = settled(result.fetchPreviousPage())

      expect(result.isFetching()).toBeFalse()

      flushMicrotasks()

      expect(api.sent).toEqual([4])
      expect(result.dataUpdatedAt()).toBe(updatedAt)
      expect(fetched.value).toEqual({ data: result.data(), error: null })
    }))
  })

  // A refetch stopped with nothing in its place puts back what the query
  // showed before it, which way its failed fetch went included.
  it('shows again that the next page failed once a refetch after it is cancelled', () => {
    const api = server()
    const { result } = mount(() => listOptions(api, { retry: 0 }))

    api.failOnce.add(2)
    result.fetchNextPage()
    api.hold.add(0)
    result.refetch()

    expect(result.isError()).toBeTrue()
    expect(result.isFetchNextPageError()).toBeFalse()

    client.cancelQueries({ queryKey: ['list'] })

    expect(result.isFetchNextPageError()).toBeTrue()
  })

  describe('isFetchedAfterMount', () => {
    it('turns true once a refetch has all the pages in, not with each page', () => {
      const api = server()

      api.hold.add(4)

      // The seeded pages are stale at the default staleTime, so the
      // component fetches them all again.
      const { result } = mount(() =>
        listOptions(api, { initialData: threePages(api) }),
      )

      expect(api.sent).toEqual([0, 2, 4])
      expect(result.isFetched()).toBeFalse()
      expect(result.isFetchedAfterMount()).toBeFalse()

      api.answer(4)

      expect(result.isFetched()).toBeTrue()
      expect(result.isFetchedAfterMount()).toBeTrue()
    })

    it('turns true once the next page lands on a list fetched before the component started', () => {
      const api = server()

      void client.infiniteQuery(listOptions(api))

      const { result } = mount(() => listOptions(api, { staleTime: Infinity }))

      expect(api.sent).toEqual([0])
      expect(result.isFetched()).toBeTrue()
      expect(result.isFetchedAfterMount()).toBeFalse()

      void result.fetchNextPage()

      expect(api.sent).toEqual([0, 2])
      expect(result.isFetchedAfterMount()).toBeTrue()
    })
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      const api = server()

      expect(() => injectInfiniteQuery(() => listOptions(api))).toThrowError(
        /injectInfiniteQuery\(\) can only be used within an injection context/,
      )
    })

    it('runs outside an injection context with the injector it is given, and stops with it', () => {
      const api = server()
      const responses: Array<Subject<Page>> = []
      const injector = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      )
      const result = injectInfiniteQuery(
        () =>
          listOptions(api, {
            queryFn: ({ pageParam }) => {
              api.sent.push(pageParam)

              const response = new Subject<Page>()

              responses.push(response)

              return response
            },
          }),
        { injector },
      )

      // Its effects are root effects there: flush them.
      TestBed.inject(ApplicationRef).tick()
      responses[0].next(api.page(0))

      expect(result.data()).toEqual({ pages: [api.page(0)], pageParams: [0] })

      client.invalidateQueries({ queryKey: ['list'] })
      injector.destroy()

      expect(api.sent).toEqual([0, 0])
      expect(responses[1].observed).toBeFalse()
    })
  })
})
