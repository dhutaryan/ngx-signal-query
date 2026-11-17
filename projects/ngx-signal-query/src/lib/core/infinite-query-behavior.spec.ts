import { fakeAsync, tick } from '@angular/core/testing'
import { type Observable, of, throwError } from 'rxjs'

import { createQuery } from '../../spec-helpers/query'
import { infiniteQueryBehavior } from './infinite-query-behavior'
import type { Query, QuerySubscriber } from './query'
import type {
  InfiniteData,
  InfinitePageOptions,
  QueryFunctionContext,
} from './types'

// A page of a list of numbered items: two items, from the param it's asked
// for with on, and the params of the pages around it.
interface Page {
  items: number[]
  next: number | null
  previous: number | null
}

type List = InfiniteData<Page, number>

// A server that lists the items it holds, two to a page: a page is asked for
// by the first item it may hold, the next page starts after its last item,
// and the previous one two items before its first. `sent` records the params
// asked for; a param in `failOnce` fails its next request.
function server(items = [0, 1, 2, 3, 4, 5, 6, 7]) {
  const api = {
    items: [...items],
    sent: [] as number[],
    failOnce: new Set<number>(),
    queryFn: ({
      pageParam,
    }: QueryFunctionContext & { pageParam: number }): Observable<Page> => {
      api.sent.push(pageParam)

      if (api.failOnce.delete(pageParam)) {
        return throwError(() => new Error(`page ${pageParam} failed`))
      }

      const found = api.items.filter((item) => item >= pageParam).slice(0, 2)
      const last = found.at(-1)

      return of({
        items: found,
        next: last === undefined || last === api.items.at(-1) ? null : last + 1,
        previous: pageParam > 0 ? Math.max(0, pageParam - 2) : null,
      })
    },
  }

  return api
}

const pageOptions: InfinitePageOptions<Page, number> = {
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.next,
  getPreviousPageParam: (firstPage) => firstPage.previous,
}

// The items of each page the query holds, and the params they came with.
function shown(query: Query<List, Error, Page>): {
  items: number[][] | undefined
  params: number[] | undefined
} {
  const data = query.state().data

  return {
    items: data?.pages.map((page) => page.items),
    params: data?.pageParams,
  }
}

describe('infiniteQueryBehavior', () => {
  // A query of the list with `pages` pages loaded, one fetch each, and the
  // params they were asked for cleared.
  function loaded(
    pages: number,
    options: InfinitePageOptions<Page, number> = pageOptions,
  ) {
    const { query } = createQuery<List, Error, Page>()
    const api = server()
    const behavior = infiniteQueryBehavior(options)

    query.fetch({ queryFn: api.queryFn, behavior })

    for (let page = 1; page < pages; page++) {
      query.fetch({ queryFn: api.queryFn, behavior, direction: 'forward' })
    }

    api.sent.length = 0

    return { query, api, behavior }
  }

  it("fetches the first page with initialPageParam, handed to the query function along with the key and the signal, and that's all", () => {
    const { query } = createQuery<List, Error, Page>()
    const api = server()
    const contexts: object[] = []

    query.fetch({
      queryFn: (context: QueryFunctionContext & { pageParam: number }) => {
        contexts.push({ ...context })

        return api.queryFn(context)
      },
      behavior: infiniteQueryBehavior(pageOptions),
    })

    expect(contexts).toEqual([
      { pageParam: 0, queryKey: ['key'], signal: jasmine.any(AbortSignal) },
    ])
    expect(shown(query)).toEqual({ items: [[0, 1]], params: [0] })
  })

  it('fetches the first page of a query that holds none, even when asked for the next one', () => {
    const { query } = createQuery<List, Error, Page>()
    const api = server()

    query.fetch({
      queryFn: api.queryFn,
      behavior: infiniteQueryBehavior(pageOptions),
      direction: 'forward',
    })

    expect(api.sent).toEqual([0])
    expect(shown(query)).toEqual({ items: [[0, 1]], params: [0] })
  })

  describe('the next page', () => {
    it('is added after the last one, fetched with the param getNextPageParam gives for it', () => {
      const getNextPageParam = jasmine
        .createSpy('getNextPageParam')
        .and.callFake((lastPage: Page) => lastPage.next)
      const { query, api, behavior } = loaded(2, {
        ...pageOptions,
        getNextPageParam,
      })
      const [first, second] = query.state().data!.pages

      query.fetch({ queryFn: api.queryFn, behavior, direction: 'forward' })

      // The last page, all the pages, the last page's param and all the
      // params.
      expect(getNextPageParam.calls.mostRecent().args).toEqual([
        second,
        [first, second],
        2,
        [0, 2],
      ])
      expect(api.sent).toEqual([4])
      expect(shown(query)).toEqual({
        items: [
          [0, 1],
          [2, 3],
          [4, 5],
        ],
        params: [0, 2, 4],
      })
    })

    it('is fetched with its param handed to the query function along with the key and the signal, and nothing else', () => {
      const { query, api, behavior } = loaded(1)
      const contexts: object[] = []

      query.fetch({
        queryFn: (context: QueryFunctionContext & { pageParam: number }) => {
          contexts.push({ ...context })

          return api.queryFn(context)
        },
        behavior,
        direction: 'forward',
      })

      expect(contexts).toEqual([
        { pageParam: 2, queryKey: ['key'], signal: jasmine.any(AbortSignal) },
      ])
    })

    it('is asked for again when a retry follows its failure', fakeAsync(() => {
      const { query, api, behavior } = loaded(1)

      api.failOnce.add(2)
      query.fetch({
        queryFn: api.queryFn,
        behavior,
        direction: 'forward',
        retry: 1,
        retryDelay: 10,
      })
      tick(10)

      expect(api.sent).toEqual([2, 2])
      expect(shown(query).params).toEqual([0, 2])
    }))

    it('drops the first page past maxPages', () => {
      const { query, api, behavior } = loaded(2, {
        ...pageOptions,
        maxPages: 2,
      })

      query.fetch({ queryFn: api.queryFn, behavior, direction: 'forward' })

      expect(shown(query)).toEqual({
        items: [
          [2, 3],
          [4, 5],
        ],
        params: [2, 4],
      })
    })

    it('drops pages from the start down to maxPages, when maxPages has gone down since', () => {
      const { query, api } = loaded(3)

      query.fetch({
        queryFn: api.queryFn,
        behavior: infiniteQueryBehavior({ ...pageOptions, maxPages: 2 }),
        direction: 'forward',
      })

      expect(api.sent).toEqual([6])
      expect(shown(query).params).toEqual([4, 6])
    })

    it('keeps all the pages with a maxPages below 0, as with none', () => {
      const { query, api, behavior } = loaded(2, {
        ...pageOptions,
        maxPages: -1,
      })

      query.fetch({ queryFn: api.queryFn, behavior, direction: 'forward' })

      expect(shown(query).params).toEqual([0, 2, 4])
    })

    it('leaves the pages as they are when there is none', () => {
      const { query } = createQuery<List, Error, Page>()
      const api = server([0, 1])
      const behavior = infiniteQueryBehavior(pageOptions)

      query.fetch({ queryFn: api.queryFn, behavior })

      const before = query.state().data

      query.fetch({ queryFn: api.queryFn, behavior, direction: 'forward' })

      expect(api.sent).toEqual([0])
      expect(query.state().data).toBe(before)
    })

    it('leaves the stale mark of the pages it is added to', () => {
      const { query, api, behavior } = loaded(1)

      query.invalidate()
      query.fetch({ queryFn: api.queryFn, behavior, direction: 'forward' })

      expect(shown(query).params).toEqual([0, 2])
      expect(query.state().isInvalidated).toBe(true)
    })
  })

  describe('the previous page', () => {
    // The list from item 4 on: its first page is [4, 5].
    function fromItem4(options = pageOptions) {
      const { query } = createQuery<List, Error, Page>()
      const api = server()
      const behavior = infiniteQueryBehavior({
        ...options,
        initialPageParam: 4,
      })

      query.fetch({ queryFn: api.queryFn, behavior })
      api.sent.length = 0

      return { query, api, behavior }
    }

    it('is added before the first one, fetched with the param getPreviousPageParam gives for it', () => {
      const getPreviousPageParam = jasmine
        .createSpy('getPreviousPageParam')
        .and.callFake((firstPage: Page) => firstPage.previous)
      const { query, api, behavior } = fromItem4({
        ...pageOptions,
        getPreviousPageParam,
      })

      query.fetch({ queryFn: api.queryFn, behavior, direction: 'forward' })

      const [first, second] = query.state().data!.pages

      query.fetch({ queryFn: api.queryFn, behavior, direction: 'backward' })

      // The first page, all the pages, the first page's param and all the
      // params.
      expect(getPreviousPageParam.calls.mostRecent().args).toEqual([
        first,
        [first, second],
        4,
        [4, 6],
      ])
      expect(api.sent).toEqual([6, 2])
      expect(shown(query)).toEqual({
        items: [
          [2, 3],
          [4, 5],
          [6, 7],
        ],
        params: [2, 4, 6],
      })
    })

    it('drops the last page past maxPages', () => {
      const { query, api, behavior } = fromItem4({
        ...pageOptions,
        maxPages: 2,
      })

      query.fetch({ queryFn: api.queryFn, behavior, direction: 'backward' })
      query.fetch({ queryFn: api.queryFn, behavior, direction: 'backward' })

      expect(shown(query)).toEqual({
        items: [
          [0, 1],
          [2, 3],
        ],
        params: [0, 2],
      })
    })

    it('drops pages from the end down to maxPages, when maxPages has gone down since', () => {
      const { query } = createQuery<List, Error, Page>()
      const api = server()
      const from6 = infiniteQueryBehavior({
        ...pageOptions,
        initialPageParam: 6,
      })

      query.fetch({ queryFn: api.queryFn, behavior: from6 })
      query.fetch({
        queryFn: api.queryFn,
        behavior: from6,
        direction: 'backward',
      })
      query.fetch({
        queryFn: api.queryFn,
        behavior: from6,
        direction: 'backward',
      })
      query.fetch({
        queryFn: api.queryFn,
        behavior: infiniteQueryBehavior({ ...pageOptions, maxPages: 2 }),
        direction: 'backward',
      })

      expect(api.sent).toEqual([6, 4, 2, 0])
      expect(shown(query).params).toEqual([0, 2])
    })

    it('is never there without getPreviousPageParam', () => {
      const { query, api, behavior } = fromItem4({
        initialPageParam: 4,
        getNextPageParam: (lastPage) => lastPage.next,
      })

      query.fetch({ queryFn: api.queryFn, behavior, direction: 'backward' })

      expect(api.sent).toEqual([])
      expect(shown(query).params).toEqual([4])
    })
  })

  describe('a refetch', () => {
    // As in the issue: with item 1 gone, asking for the params the pages
    // were fetched with, 0, 2 and 4, would bring item 2 twice.
    it('fetches as many pages as the query holds, the first with its own param, each next one with the param getNextPageParam gives for the page just fetched', () => {
      const { query, api, behavior } = loaded(3)

      api.items = api.items.filter((item) => item !== 1)
      query.fetch({ queryFn: api.queryFn, behavior })

      expect(api.sent).toEqual([0, 3, 5])
      expect(shown(query)).toEqual({
        items: [
          [0, 2],
          [3, 4],
          [5, 6],
        ],
        params: [0, 3, 5],
      })
    })

    it('fetches fewer pages once there is no next one', () => {
      const { query, api, behavior } = loaded(3)

      api.items = [0, 1, 2]
      query.fetch({ queryFn: api.queryFn, behavior })

      expect(api.sent).toEqual([0, 2])
      expect(shown(query)).toEqual({
        items: [[0, 1], [2]],
        params: [0, 2],
      })
    })

    it("starts from the first page's own param, null included, rather than initialPageParam", () => {
      const { query } = createQuery<
        InfiniteData<string, number | null>,
        Error,
        string
      >()
      const sent: Array<number | null> = []

      query.setData({ pages: ['from the start'], pageParams: [null] })
      query.fetch({
        queryFn: ({
          pageParam,
        }: QueryFunctionContext & { pageParam: number | null }) => {
          sent.push(pageParam)

          return of(`page ${pageParam}`)
        },
        behavior: infiniteQueryBehavior<string, number | null>({
          initialPageParam: 0,
          getNextPageParam: () => null,
        }),
      })

      expect(sent).toEqual([null])
    })

    // As in the issue: with item 1 gone and page 3 failing once, the
    // retry asks for 3 again, then 5, rather than starting over at 0.
    it('goes on from the page that failed when a retry follows its failure', fakeAsync(() => {
      const { query, api, behavior } = loaded(3)

      api.items = api.items.filter((item) => item !== 1)
      api.failOnce.add(3)
      query.fetch({
        queryFn: api.queryFn,
        behavior,
        retry: 1,
        retryDelay: 10,
      })
      tick(10)

      expect(api.sent).toEqual([0, 3, 3, 5])
      expect(shown(query).params).toEqual([0, 3, 5])
    }))

    it('reads all the pages anew: their stale mark goes', () => {
      const { query, api, behavior } = loaded(2)

      query.invalidate()
      query.fetch({ queryFn: api.queryFn, behavior })

      expect(api.sent).toEqual([0, 2])
      expect(query.state().isInvalidated).toBe(false)
    })

    it('keeps the stale mark when the query is invalidated while a retry waits to go on from the page that failed', fakeAsync(() => {
      const { query, api, behavior } = loaded(2)

      api.failOnce.add(2)
      query.fetch({
        queryFn: api.queryFn,
        behavior,
        retry: 1,
        retryDelay: 10,
      })
      // The first page, already in, predates this.
      query.invalidate()
      tick(10)

      expect(api.sent).toEqual([0, 2, 2])
      expect(query.state().isInvalidated).toBe(true)
    }))

    it('fetches only the pages maxPages kept', () => {
      const { query, api, behavior } = loaded(3, {
        ...pageOptions,
        maxPages: 2,
      })

      query.fetch({ queryFn: api.queryFn, behavior })

      expect(api.sent).toEqual([2, 4])
      expect(shown(query).params).toEqual([2, 4])
    })

    it('fetches as many pages as the query holds when maxPages has gone down since, and keeps the last of them', () => {
      const { query, api } = loaded(3)

      query.fetch({
        queryFn: api.queryFn,
        behavior: infiniteQueryBehavior({ ...pageOptions, maxPages: 2 }),
      })

      expect(api.sent).toEqual([0, 2, 4])
      expect(shown(query).params).toEqual([2, 4])
    })

    it('lands with the pages it has once no query function asks for the key', () => {
      const { query, api, behavior } = loaded(3)
      let movedOn = false
      // A component that showed the key and moves on to another one while
      // the first page is in flight.
      const component: QuerySubscriber<List, Error, Page> = {
        fetchOptions: () => null,
        refetchOptions: () => null,
        asksFor: () => !movedOn,
        fetches: () => !movedOn,
        structuralSharing: () => false,
      }

      query.fetch(
        {
          queryFn: (context: QueryFunctionContext & { pageParam: number }) => {
            movedOn = true

            return api.queryFn(context)
          },
          behavior,
        },
        { by: component },
      )

      expect(api.sent).toEqual([0])
      expect(shown(query)).toEqual({ items: [[0, 1]], params: [0] })
    })
  })
})
