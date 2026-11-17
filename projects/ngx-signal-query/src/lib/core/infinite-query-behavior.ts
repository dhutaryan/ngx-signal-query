import { type Observable, concatMap, map, of } from 'rxjs'

import type { FetchBehavior, FetchDirection } from './query'
import type { InfiniteData, InfinitePageOptions } from './types'

/**
 * The param of the page a fetch in `direction` adds to the pages `data`
 * holds: the page after the last one, as getNextPageParam gives it, or the
 * page before the first one, as getPreviousPageParam does. Undefined while
 * `data` holds no pages, and backward without getPreviousPageParam.
 *
 * @internal
 */
export function pageParamFor<TPage, TPageParam>(
  direction: FetchDirection,
  {
    getNextPageParam,
    getPreviousPageParam,
  }: InfinitePageOptions<TPage, TPageParam>,
  { pages, pageParams }: InfiniteData<TPage, TPageParam>,
): TPageParam | null | undefined {
  if (pages.length === 0) return undefined

  if (direction === 'backward') {
    return getPreviousPageParam?.(pages[0], pages, pageParams[0], pageParams)
  }

  const last = pages.length - 1

  return getNextPageParam(pages[last], pages, pageParams[last], pageParams)
}

/**
 * How the fetch of an infinite query gets its pages (see FetchBehavior).
 *
 * A fetch with a direction, of a query that holds pages, adds one: the next
 * page, with the param getNextPageParam gives, or the page before the first,
 * with getPreviousPageParam's. Past maxPages, pages go at the other end until
 * maxPages are left. With no such param, the fetch lands the pages as they
 * are. A retry asks for the same page again.
 *
 * Any other fetch gets the pages anew, from the first: with the first page's
 * own param, or initialPageParam while the query holds none, then each with
 * the param getNextPageParam gives for the page just fetched. It fetches as
 * many pages as the query holds, one at least, and fewer once there is no
 * next one. A retry goes on from the page that failed. When no query
 * function asks for the query's key any more by the time of a page, such as
 * once the component that asked has moved on to another key, the fetch lands
 * with the pages it has.
 *
 * @internal
 */
export function infiniteQueryBehavior<TPage, TPageParam>(
  options: InfinitePageOptions<TPage, TPageParam>,
): FetchBehavior<TPage, InfiniteData<TPage, TPageParam>> {
  // `to` with `page`, fetched with `param`, added at the end, or at the start
  // for a previous page.
  const added = (
    to: InfiniteData<TPage, TPageParam>,
    page: TPage,
    param: TPageParam,
    previous: boolean,
  ): InfiniteData<TPage, TPageParam> => ({
    pages: addTo(to.pages, page, previous, options.maxPages),
    pageParams: addTo(to.pageParams, param, previous, options.maxPages),
  })

  return ({ data, direction }) => {
    const held = data ?? { pages: [], pageParams: [] }
    // What the attempts of a fetch that gets the pages anew have fetched so
    // far, and how many pages that is: a retry goes on from there. Counted
    // apart from the pages kept, which maxPages may drop on the way.
    let fetched: InfiniteData<TPage, TPageParam> = { pages: [], pageParams: [] }
    let count = 0

    return ({ request, startOver }) => {
      if (direction && held.pages.length > 0) {
        const previous = direction === 'backward'
        const param = pageParamFor(direction, options, held)

        if (param == null) return of(held)

        // The attempt's only request: it always goes out (see FetchAttempt).
        const response = request({ pageParam: param })

        return response
          ? response.pipe(map((page) => added(held, page, param, previous)))
          : of(held)
      }

      // An attempt that starts from the first page reads them all anew.
      if (count === 0) startOver()

      const fetchPage = (
        param: TPageParam,
      ): Observable<InfiniteData<TPage, TPageParam>> => {
        const response = request({ pageParam: param })

        if (!response) return of(fetched)

        return response.pipe(
          concatMap((page) => {
            fetched = added(fetched, page, param, false)
            count++

            return count < held.pages.length ? fetchNext() : of(fetched)
          }),
        )
      }

      const fetchNext = (): Observable<InfiniteData<TPage, TPageParam>> => {
        if (count === 0) {
          return fetchPage(
            held.pages.length > 0
              ? held.pageParams[0]
              : options.initialPageParam,
          )
        }

        const param = pageParamFor('forward', options, fetched)

        return param == null ? of(fetched) : fetchPage(param)
      }

      return fetchNext()
    }
  }
}

// `items` with `item` added at the end, or at the start. Past `max`, items go
// at the other end until `max` are left, so a `max` lowered since takes
// effect as the next item comes. TanStack drops one item only, which leaves a
// list already longer than `max` as long. No `max`, or one that isn't above
// 0, keeps them all: a negative one would leave none.
function addTo<T>(items: T[], item: T, atStart: boolean, max = 0): T[] {
  const added = atStart ? [item, ...items] : [...items, item]

  if (!(max > 0) || added.length <= max) return added

  return atStart ? added.slice(0, max) : added.slice(-max)
}
