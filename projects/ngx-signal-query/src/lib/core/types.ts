import type { Signal } from '@angular/core'
import type { Observable } from 'rxjs'

/**
 * Uniquely identifies a query and serves as its cache key. Use a serializable
 * array, from broad to specific, e.g. `['todos']` or `['todo', id]`.
 */
export type QueryKey = readonly unknown[]

/**
 * Lifecycle status of a query: no data yet (the first load, or a new attempt
 * after a failure), resolved, or failed.
 */
export type QueryStatus = 'pending' | 'success' | 'error'

/** Full state snapshot of a query (the reactive source behind {@link QueryResult}). */
export interface QueryState<TData, TError = Error> {
  /** Last successfully resolved data, or `undefined` before the first success. */
  data: TData | undefined
  /** Current {@link QueryStatus}. */
  status: QueryStatus
  /**
   * The error the last fetch failed with, or `null`. A query with no data
   * clears it when it fetches again; one with data keeps it until the next
   * response.
   */
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

/** Selects which queries `invalidateQueries` marks stale, and what it refetches. */
export type InvalidateQueryFilters = QueryFilters & {
  /**
   * Which of the marked queries to refetch now: `'active'`, the default,
   * refetches those a component shows; `'none'` refetches none, so each one
   * refetches when stale data next would, e.g. as a component starts showing
   * it. Queries nobody shows are only marked either way.
   */
  refetchType?: 'active' | 'none'
}

/** A new value, or a function deriving it from the previous one. */
export type Updater<TInput, TOutput> = TOutput | ((input: TInput) => TOutput)

/**
 * Computes placeholder data from the previous query's data (e.g. the page
 * shown before a key change). Return `undefined` to show no placeholder.
 */
export type PlaceholderDataFunction<TData> = (
  previousData: TData | undefined,
) => TData | undefined

/**
 * Polling interval in ms, `false` to disable, or a function of the current
 * query snapshot returning the next interval (e.g. stop polling on error).
 *
 * Each poll comes this many ms after the query's last update, a response or a
 * cache write, so a fetch made for any other reason pushes it back. `0` means
 * no polling, and so does a value no timer can hold: `Infinity`, a negative
 * number, or more than 2³¹−1 ms. The function runs again on every update of
 * the query, and the signals it reads are tracked.
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

/**
 * How new data merges with the data a query holds: `true` keeps every part
 * that didn't change, and the whole value when nothing did; `false` stores
 * the new data as is; a function merges them its own way.
 *
 * Only plain objects and arrays are compared, as JSON parsing makes them: any
 * other value, such as a `Date`, counts as changed. A function gets the data
 * the query holds (`undefined` before the first response) and the new data,
 * and returns what to store. It also runs for `setQueryData` writes, so it
 * should merge them rather than keep the old data.
 */
export type StructuralSharingValue<TData> =
  | boolean
  | ((oldData: TData | undefined, newData: TData) => TData)

/** Configuration for a query, passed to {@link injectQuery} / {@link queryOptions}. */
export type QueryOptions<TData, TError = Error> = {
  /** Unique cache key for this query. See {@link QueryKey}. */
  queryKey: QueryKey
  /**
   * Fetcher returning the data as an `Observable` or `Promise`. Once no
   * component shows the query, an `Observable` fetch in flight is
   * unsubscribed, which aborts an `HttpClient` request; a `Promise` one runs
   * to the end, and its response is kept.
   */
  queryFn: () => Observable<TData> | Promise<TData>
  /** How long fetched data stays fresh before refetching, in ms. Default `0`. */
  staleTime?: number
  /**
   * How long the query stays in the cache once nothing uses it (no component
   * shows it, no fetch of it is in flight), in ms. Default 5 minutes.
   * `Infinity` keeps it until it's removed, and so does anything over about
   * 24.8 days (2³¹−1 ms), the most a timer can hold. When components showing
   * it ask for different gcTimes, or fetchQuery asks for the default, the
   * longest wins for as long as the query stays in the cache. On the server
   * it's always `Infinity`.
   */
  gcTime?: number
  /** Retry policy on failure. Default `3`. See {@link RetryValue}. */
  retry?: RetryValue<TError>
  /** Delay between retries. See {@link RetryDelayValue}. */
  retryDelay?: RetryDelayValue<TError>
  /**
   * Refetch on a timer while the query is observed and enabled, whatever its
   * `staleTime`. The timer restarts only when the key, `enabled` or the
   * interval changes. See {@link RefetchIntervalValue}.
   */
  refetchInterval?: RefetchIntervalValue<TData, TError>
  /**
   * Whether the query refetches when the user comes back to the page, as the
   * tab or window turns visible again: `true` refetches stale data (see
   * `staleTime`), `'always'` fresh data too, `false` never. Default `true`.
   * However many components show the query, it refetches once.
   */
  refetchOnWindowFocus?: boolean | 'always'
  /**
   * Whether the query refetches when the network comes back (the browser's
   * `online` event): `true` refetches stale data (see `staleTime`), so a
   * query that failed while offline loads again; `'always'` refetches fresh
   * data too, `false` never. Default `true`.
   */
  refetchOnReconnect?: boolean | 'always'
  /**
   * Seed data to render immediately (treated as already-resolved). A
   * function runs only while the query has no data yet; returning `undefined`
   * seeds nothing, so the query stays `'pending'` and fetches.
   */
  initialData?: TData | (() => TData | undefined)
  /**
   * Data shown while the query is `'pending'` with no data yet, either a value
   * or a function of the previous query's data (see {@link keepPreviousData}).
   * Unlike `initialData` it is never written to the cache: the query stays
   * `'pending'` underneath, and `isPlaceholderData` is `true` while shown.
   */
  placeholderData?: TData | PlaceholderDataFunction<TData>
  /** Timestamp (ms) for `initialData`; older data is considered stale. */
  initialDataUpdatedAt?: number | (() => number)
  /**
   * Whether new data keeps the parts of the cached data that didn't change,
   * so `data()` keeps its reference when a refetch brings the same data.
   * Default `true`; turn it off for large responses refetched often. See
   * {@link StructuralSharingValue}.
   */
  structuralSharing?: StructuralSharingValue<TData>
  /** Set `false` to disable fetching (e.g. until a dependency is ready). */
  enabled?: boolean
}

/**
 * {@link QueryOptions} with defaults resolved (internal, set by {@link QueryClient}).
 *
 * @internal
 */
export type DefaultedQueryOptions<TData, TError = Error> = QueryOptions<
  TData,
  TError
> & {
  staleTime: number
  gcTime: number
  retry: RetryValue<TError>
  retryDelay: RetryDelayValue<TError>
  structuralSharing: StructuralSharingValue<TData>
  refetchOnWindowFocus: boolean | 'always'
  refetchOnReconnect: boolean | 'always'
}

/** Reactive result returned by {@link injectQuery}; every field is a signal. */
export type QueryResult<TData, TError = Error> = {
  /**
   * Last resolved data, or `undefined` before the first success. It keeps its
   * reference while refetches bring the same data (see `structuralSharing`).
   */
  data: Signal<TData | undefined>
  /** Current {@link QueryStatus}. */
  status: Signal<QueryStatus>
  /**
   * The error the last fetch failed with, or `null`. It's cleared while a
   * query with no data is tried again, and kept while one with data
   * refetches.
   */
  error: Signal<TError | null>
  /** Whether a fetch is in flight (including background refetches). */
  isFetching: Signal<boolean>
  /**
   * Whether a fetch is in flight with no data to show: the first one, or a
   * new attempt after a failure (`isFetching && pending`).
   */
  isLoading: Signal<boolean>
  /** Whether status is `'pending'` (no data resolved yet). */
  isPending: Signal<boolean>
  /** Whether status is `'success'`. */
  isSuccess: Signal<boolean>
  /** Whether status is `'error'`. */
  isError: Signal<boolean>
  /** Whether `data` is placeholder data (see `placeholderData`), not cached data. */
  isPlaceholderData: Signal<boolean>
  /** Consecutive failures in the current fetch. */
  failureCount: Signal<number>
  /** Error of the most recent failed attempt, or `null`. */
  failureReason: Signal<TError | null>
  /**
   * Forces a fresh fetch, cancelling any in-flight request. Resolves once the
   * fetch has settled, or the fetch that replaced it has, with `data` and
   * `error` as the signals above hold them then. It never rejects: a failure
   * shows in `error`.
   */
  refetch: () => Promise<{ data: TData | undefined; error: TError | null }>
}

/** Default query options applied to every query unless overridden per-query. */
export interface DefaultQueryOptions {
  /** How long fetched data is considered fresh, in ms. Defaults to `0`. */
  staleTime?: number
  /**
   * How long a query stays in the cache once nothing uses it, in ms. Defaults
   * to 5 minutes. It applies to queries fetchQuery prefetches and setQueryData
   * writes too.
   */
  gcTime?: number
  /** Retry policy on failure: a boolean, a count, or a predicate. Defaults to `3`. */
  retry?: RetryValue<unknown>
  /** Delay between retries, in ms or a function of the attempt. */
  retryDelay?: RetryDelayValue<unknown>
  /** Whether new data keeps the parts of the cached data that didn't change. Defaults to `true`. */
  structuralSharing?: StructuralSharingValue<unknown>
  /** Whether queries refetch when the user comes back to the page. Defaults to `true`. */
  refetchOnWindowFocus?: boolean | 'always'
  /** Whether queries refetch when the network comes back. Defaults to `true`. */
  refetchOnReconnect?: boolean | 'always'
}

/**
 * Default mutation options applied to every mutation. A mutation's own value
 * replaces the default for that field only; a field it leaves `undefined`
 * keeps the default.
 *
 * The hooks run in the injection context of the injector that provides the
 * client, so they can call `inject()` before their first `await`. Once that
 * injector is destroyed, they no longer run.
 */
export interface DefaultMutationOptions {
  /** Retry policy on failure. Defaults to `0`: writes aren't retried. */
  retry?: RetryValue<unknown>
  /** Delay between retries, in ms or a function of the attempt. */
  retryDelay?: RetryDelayValue<unknown>
  /** Runs after a successful write, for a mutation without its own `onSuccess`. */
  onSuccess?: (
    data: unknown,
    variables: unknown,
    context: unknown,
  ) => Promise<unknown> | unknown
  /** Runs after a failed write or `onMutate`, for a mutation without its own `onError`. */
  onError?: (
    error: unknown,
    variables: unknown,
    context: unknown,
  ) => Promise<unknown> | unknown
  /** Runs after success or error, for a mutation without its own `onSettled`. */
  onSettled?: (
    data: unknown,
    error: unknown,
    variables: unknown,
    context: unknown,
  ) => Promise<unknown> | unknown
}

/** Application-wide defaults configured via {@link withDefaultOptions}. */
export interface DefaultOptions {
  /** Defaults applied to all queries. */
  queries?: DefaultQueryOptions
  /** Defaults applied to all mutations. */
  mutations?: DefaultMutationOptions
}
