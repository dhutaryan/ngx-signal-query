import { type Injector, computed } from '@angular/core'

import { infiniteQueryBehavior, pageParamFor } from './infinite-query-behavior'
import { type FetchDirection, fetchArgsOf } from './query'
import { createQueryObserver } from './query-observer'
import type {
  InfiniteData,
  InfiniteQueryOptions,
  InfiniteQueryResult,
  QueryKey,
} from './types'

/**
 * One observed infinite query: its reactive result and a `destroy()` that
 * ends the observation.
 *
 * @internal
 */
export interface InfiniteQueryObserver<TPage, TError, TPageParam> {
  result: InfiniteQueryResult<TPage, TError, TPageParam>
  destroy: () => void
}

/**
 * Observes an infinite query: a query whose data is its pages (see
 * createQueryObserver). Every fetch made on its behalf, whoever starts it,
 * gets them as infiniteQueryBehavior says, with the page options it reads
 * from the live options as it starts.
 *
 * @internal
 */
export function createInfiniteQueryObserver<TPage, TError, TPageParam>(
  optionsFn: () => InfiniteQueryOptions<TPage, TError, QueryKey, TPageParam>,
  injector: Injector,
): InfiniteQueryObserver<TPage, TError, TPageParam> {
  const { result, destroy, state, options, asObserver } = createQueryObserver<
    InfiniteData<TPage, TPageParam>,
    TError,
    TPage,
    InfiniteQueryOptions<TPage, TError, QueryKey, TPageParam>
  >(optionsFn, injector, (options) => ({
    ...fetchArgsOf(options),
    behavior: infiniteQueryBehavior(options),
  }))

  // Fetches the page after the last one, or the one before the first, on
  // behalf of this observer. While the query holds no pages, it fetches the
  // first one, or waits for the load in flight. A fetch already in flight is
  // waited for, whatever it is, and no page is added: asking for one next to
  // a refetch would mix pages read before it with pages read after. With no
  // page to add, nothing is fetched. As refetch() does, it resolves with the
  // signals' data and error once done, and never rejects.
  const fetchPage = (
    direction: FetchDirection,
  ): ReturnType<
    InfiniteQueryResult<TPage, TError, TPageParam>['fetchNextPage']
  > => {
    const fetched = asObserver(({ q, options, args, by }) => {
      const { data, isFetching } = q.state()

      if (data === undefined || data.pages.length === 0 || isFetching) {
        return q.fetch(args, { by })
      }

      return pageParamFor(direction, options, data) == null
        ? Promise.resolve(data)
        : q.fetch({ ...args, direction }, { by })
    })

    return Promise.resolve(fetched)
      .catch(() => undefined)
      .then(() => ({ data: result.data(), error: result.error() }))
  }

  // Whether there's a page to add, read from the pages the query holds, not
  // from placeholder data, as in TanStack.
  const hasPage = (direction: FetchDirection) =>
    computed(() => {
      const { data } = state()

      return (
        data !== undefined && pageParamFor(direction, options(), data) != null
      )
    })

  // What the fetch in flight is for, or the one that failed, as the query
  // records it for every component showing it (see
  // InternalQueryState.fetchDirection).
  const isFetchingPage = (direction: FetchDirection) =>
    computed(() => state().isFetching && state().fetchDirection === direction)
  const isFetchPageError = (direction: FetchDirection) =>
    computed(
      () => state().status === 'error' && state().fetchDirection === direction,
    )

  return {
    result: {
      ...result,
      fetchNextPage: () => fetchPage('forward'),
      fetchPreviousPage: () => fetchPage('backward'),
      hasNextPage: hasPage('forward'),
      hasPreviousPage: hasPage('backward'),
      isFetchingNextPage: isFetchingPage('forward'),
      isFetchingPreviousPage: isFetchingPage('backward'),
      isFetchNextPageError: isFetchPageError('forward'),
      isFetchPreviousPageError: isFetchPageError('backward'),
    },
    destroy,
  }
}
