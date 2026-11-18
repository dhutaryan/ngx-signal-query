import { type Observable, of, Subject, throwError } from 'rxjs'

import type {
  InfiniteData,
  InfiniteQueryFunctionContext,
  InfiniteQueryOptions,
  QueryKey,
} from '../lib/core/types'

// A page of a list of numbered items: two items from the param it's asked
// for with on, each read as `<item>@v<version of the list>`, and the params
// of the pages around it.
export interface Page {
  items: string[]
  next: number | null
  previous: number | null
}

export type List = InfiniteData<Page, number>

export type ListOptions = InfiniteQueryOptions<Page, Error, QueryKey, number>

// A server that lists the items it holds, two to a page: a page is asked for
// by the first item it may hold, the next one starts after its last item,
// and the previous one two items before its first. `sent` records the params
// asked for; a param in `failOnce` fails its next request, and one in `hold`
// waits until answer(param) answers it.
export function server() {
  const api = {
    items: [0, 1, 2, 3, 4, 5, 6, 7],
    version: 0,
    sent: [] as number[],
    failOnce: new Set<number>(),
    hold: new Set<number>(),
    waiting: new Map<number, Subject<Page>>(),
    page: (param: number): Page => {
      const found = api.items.filter((item) => item >= param).slice(0, 2)
      const last = found.at(-1)

      return {
        items: found.map((item) => `${item}@v${api.version}`),
        next: last === undefined || last === api.items.at(-1) ? null : last + 1,
        previous: param > 0 ? Math.max(0, param - 2) : null,
      }
    },
    answer: (param: number): void => {
      api.waiting.get(param)?.next(api.page(param))
      api.waiting.delete(param)
    },
    queryFn: ({
      pageParam,
    }: InfiniteQueryFunctionContext<QueryKey, number>): Observable<Page> => {
      api.sent.push(pageParam)

      if (api.failOnce.delete(pageParam)) {
        return throwError(() => new Error(`page ${pageParam} failed`))
      }

      if (api.hold.has(pageParam)) {
        const response = new Subject<Page>()

        api.waiting.set(pageParam, response)

        return response
      }

      return of(api.page(pageParam))
    },
  }

  return api
}

export type Server = ReturnType<typeof server>

// The options of the list `api` serves, with `options` on top.
export function listOptions(
  api: Server,
  options: Partial<ListOptions> = {},
): ListOptions {
  return {
    queryKey: ['list'],
    queryFn: api.queryFn,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.next,
    ...options,
  }
}

// The first three pages of the list, as `api` serves them now.
export function threePages(api: Server): List {
  return {
    pages: [api.page(0), api.page(2), api.page(4)],
    pageParams: [0, 2, 4],
  }
}
