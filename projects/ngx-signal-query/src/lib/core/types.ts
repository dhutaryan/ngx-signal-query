import type { Signal } from '@angular/core'
import type { Observable } from 'rxjs'

/**
 * Uniquely identifies a query and serves as its cache key. Use a serializable
 * array, from broad to specific, e.g. `['todos']` or `['todo', id]`.
 */
export type QueryKey = readonly unknown[]

/** Lifecycle status of a query: no data yet, resolved, or failed. */
export type QueryStatus = 'pending' | 'success' | 'error'

/** Full state snapshot of a query (the reactive source behind {@link QueryResult}). */
export interface QueryState<TData, TError = Error> {
  /** Last successfully resolved data, or `undefined` before the first success. */
  data: TData | undefined
  /** Current {@link QueryStatus}. */
  status: QueryStatus
  /** Last error, or `null` if the latest attempt did not fail. */
  error: TError | null
  /** Whether a fetch is currently in flight. */
  isFetching: boolean
  /** Whether the query has been marked stale via `invalidateQueries`. */
  isInvalidated: boolean
  /** Number of consecutive failed attempts in the current fetch. */
  failureCount: number
  /** Error of the most recent failed attempt, or `null`. */
  failureReason: TError | null
  /** Timestamp (ms) of the last successful update; `0` if never. */
  updatedAt: number
}

/** Selects which queries an operation applies to (e.g. invalidate, cancel). */
export type QueryFilters = {
  /** Match queries whose key starts with (or, with `exact`, equals) this key. */
  queryKey?: QueryKey
  /** Require an exact key match instead of a prefix match. */
  exact?: boolean
}

/** A new value, or a function deriving it from the previous one. */
export type Updater<TInput, TOutput> = TOutput | ((input: TInput) => TOutput)

/**
 * Polling interval in ms, `false` to disable, or a function of the current
 * query snapshot returning the next interval (e.g. stop polling on error).
 */
export type RefetchIntervalValue<TData, TError> =
  | number
  | false
  | ((query: {
      state: QueryState<TData, TError>
    }) => number | false | undefined)

/**
 * Retry policy: `true`/`false` to enable/disable, a max retry count, or a
 * predicate `(failureCount, error) => boolean`.
 */
export type RetryValue<TError> =
  | boolean
  | number
  | ((failureCount: number, error: TError) => boolean)

/** Delay between retries: fixed ms, or a function of the attempt and error. */
export type RetryDelayValue<TError> =
  | number
  | ((failureCount: number, error: TError) => number)

/** Configuration for a query, passed to {@link injectQuery} / {@link queryOptions}. */
export type QueryOptions<TData, TError = Error> = {
  /** Unique cache key for this query. See {@link QueryKey}. */
  queryKey: QueryKey
  /** Fetcher returning the data as an `Observable` or `Promise`. */
  queryFn: () => Observable<TData> | Promise<TData>
  /** How long fetched data stays fresh before refetching, in ms. Default `0`. */
  staleTime?: number
  /** How long unused data is kept before garbage collection, in ms. */
  gcTime?: number
  /** Retry policy on failure. Default `3`. See {@link RetryValue}. */
  retry?: RetryValue<TError>
  /** Delay between retries. See {@link RetryDelayValue}. */
  retryDelay?: RetryDelayValue<TError>
  /** Poll on an interval. See {@link RefetchIntervalValue}. */
  refetchInterval?: RefetchIntervalValue<TData, TError>
  /** Seed data to render immediately (treated as already-resolved). */
  initialData?: TData | (() => TData)
  /** Timestamp (ms) for `initialData`; older data is considered stale. */
  initialDataUpdatedAt?: number | (() => number)
  /** Set `false` to disable fetching (e.g. until a dependency is ready). */
  enabled?: boolean
}

/** {@link QueryOptions} with defaults resolved (internal, set by {@link QueryClient}). */
export type DefaultedQueryOptions<TData, TError = Error> = QueryOptions<
  TData,
  TError
> & {
  staleTime: number
  retry: RetryValue<TError>
  retryDelay: RetryDelayValue<TError>
}

/** Reactive result returned by {@link injectQuery}; every field is a signal. */
export type QueryResult<TData, TError = Error> = {
  /** Last resolved data, or `undefined` before the first success. */
  data: Signal<TData | undefined>
  /** Current {@link QueryStatus}. */
  status: Signal<QueryStatus>
  /** Last error, or `null`. */
  error: Signal<TError | null>
  /** Whether a fetch is in flight (including background refetches). */
  isFetching: Signal<boolean>
  /** Whether the first fetch is in flight with no data yet (`isFetching && pending`). */
  isLoading: Signal<boolean>
  /** Whether status is `'pending'` (no data resolved yet). */
  isPending: Signal<boolean>
  /** Whether status is `'success'`. */
  isSuccess: Signal<boolean>
  /** Whether status is `'error'`. */
  isError: Signal<boolean>
  /** Consecutive failures in the current fetch. */
  failureCount: Signal<number>
  /** Error of the most recent failed attempt, or `null`. */
  failureReason: Signal<TError | null>
  /** Forces a fresh fetch, cancelling any in-flight request. */
  refetch: () => void
}
