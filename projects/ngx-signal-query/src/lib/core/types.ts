import type { Signal } from '@angular/core'
import type { Observable } from 'rxjs'

/**
 * Uniquely identifies a query and serves as its cache key. Use a serializable
 * array, from broad to specific, e.g. `['todos']` or `['todo', id]`.
 */
export type QueryKey = readonly unknown[]

// Only a type: no value is ever made for it, and a tagged key carries nothing
// at runtime. Not exported: an app's declaration files name DataTag<…>
// instead (see DataTag). A type built from a tagged key that TypeScript can't
// write as DataTag<…>, such as NonNullable<> of one, can't be written there
// either (TS4023); typing such a value QueryKey fixes that.
declare const dataTagSymbol: unique symbol

/**
 * A query key that also carries the type of the data cached under it. The
 * key of a {@link queryOptions} or {@link infiniteQueryOptions} definition
 * has this type. Only the type changes: at runtime the key is the array it
 * was written as.
 *
 * {@link QueryClient.getQueryData} and {@link QueryClient.setQueryData} take
 * the data type from such a key, with no generic to write. A generic written
 * out for it is checked: the data the key carries has to fit it, so
 * `<Todo[]>` for a todo's key is an error.
 *
 * @typeParam TQueryKey - Type of the key itself.
 * @typeParam TData - Type of the data cached under the key.
 */
// The tag is optional, so a key written out still fits where a tagged one is
// expected, as in a test's stub of a definition. A plain intersection, not a
// conditional type: an app's declaration files then name DataTag<…> for a
// definition it exports, rather than spelling out dataTagSymbol, which they
// can't import.
export type DataTag<TQueryKey extends QueryKey, TData> = TQueryKey & {
  readonly [dataTagSymbol]?: TData
}

/** What a query function is called with (see {@link QueryFunction}). */
export type QueryFunctionContext<TQueryKey extends QueryKey = QueryKey> = {
  /**
   * The key of the query being fetched, as the cache holds it. It has the
   * type of `queryKey`: written `['todo', id] as const`, each element keeps
   * its own type. A query a server render brought over (see
   * {@link withHydration}) holds its key as JSON brought it back: a `Date` in
   * it is a string there.
   */
  queryKey: TQueryKey
  /**
   * Aborted when the fetch is stopped before it's done: `cancelQueries()`,
   * `removeQueries()` or `clear()` stops it, a refetch replaces it, or no
   * component shows the query any more. All the attempts of a fetch get the
   * same signal, and it isn't aborted once the fetch lands or fails.
   *
   * Reading it says that the request is made with it, as
   * `fetch(url, { signal })` makes one: once no component shows the query,
   * such a `Promise` fetch is stopped as an `Observable` one is, rather than
   * left to run to the end.
   */
  signal: AbortSignal
}

/**
 * Fetches a query's data as an `Observable` or a `Promise`. It's called with
 * the query's key and an abort signal (see {@link QueryFunctionContext}); a
 * function that needs neither can take no parameters.
 */
export type QueryFunction<TData, TQueryKey extends QueryKey = QueryKey> = {
  // Declared as a method, whose parameter is checked both ways, unlike a
  // function's: a definition whose key has a narrower type, as
  // queryOptions() infers it (`string[]`, or a tuple with `as const`), still
  // fits where any key is expected, such as an entry of injectQueries.
  queryFn(
    context: QueryFunctionContext<TQueryKey>,
  ): Observable<TData> | Promise<TData>
}['queryFn']

/**
 * What the query function of an infinite query is called with: the query's
 * key and an abort signal, as for any query (see {@link QueryFunctionContext}),
 * and the param of the page to fetch.
 */
export type InfiniteQueryFunctionContext<
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
> = QueryFunctionContext<TQueryKey> & {
  /**
   * The param of the page to fetch: `initialPageParam` for the first page,
   * then what `getNextPageParam` or `getPreviousPageParam` gives (see
   * {@link InfinitePageOptions}).
   */
  pageParam: TPageParam
}

/**
 * Fetches one page of an infinite query as an `Observable` or a `Promise`.
 * It's called with the query's key, an abort signal and the page's param
 * (see {@link InfiniteQueryFunctionContext}); a function that needs none of
 * them can take no parameters.
 */
export type InfiniteQueryFunction<
  TPage,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
> = {
  // Declared as a method, as QueryFunction is: a definition whose key or
  // param has a narrower type still fits where any is expected.
  queryFn(
    context: InfiniteQueryFunctionContext<TQueryKey, TPageParam>,
  ): Observable<TPage> | Promise<TPage>
}['queryFn']

/**
 * The data of an infinite query: the pages fetched so far, in order, and the
 * param each one was fetched with, at the same index.
 */
export interface InfiniteData<TPage, TPageParam = unknown> {
  /** The pages, in the order they're shown. */
  pages: TPage[]
  /** The param each page was fetched with: `pageParams[i]` for `pages[i]`. */
  pageParams: TPageParam[]
}

/**
 * Gives the param of the page after the last one, from that page, all the
 * pages, the last page's param and all the params; `null` or `undefined`
 * when there is no next page.
 */
export type GetNextPageParamFunction<TPageParam, TPage = unknown> = (
  lastPage: TPage,
  allPages: TPage[],
  lastPageParam: TPageParam,
  allPageParams: TPageParam[],
) => TPageParam | null | undefined

/**
 * Gives the param of the page before the first one, from that page, all the
 * pages, the first page's param and all the params; `null` or `undefined`
 * when there is no previous page.
 */
export type GetPreviousPageParamFunction<TPageParam, TPage = unknown> = (
  firstPage: TPage,
  allPages: TPage[],
  firstPageParam: TPageParam,
  allPageParams: TPageParam[],
) => TPageParam | null | undefined

/**
 * How an infinite query pages: the param its first page is fetched with,
 * how the params of the pages around those it holds are found, and how many
 * pages it keeps.
 */
export interface InfinitePageOptions<TPage, TPageParam> {
  /**
   * The param the first page is fetched with while the query holds no
   * pages. Once it holds some, a refetch starts from the first page's own
   * param, whatever it is, `null` included.
   */
  initialPageParam: TPageParam
  /**
   * Gives the param of the next page, or `null` or `undefined` when there is
   * none. A refetch uses it too: it fetches each page after the first with
   * the param this gives for the page just fetched, as many pages as the
   * query held, and stops early when there is no next one.
   */
  getNextPageParam: GetNextPageParamFunction<TPageParam, TPage>
  /**
   * Gives the param of the page before the first one, or `null` or
   * `undefined` when there is none. Without it, there is no previous page.
   */
  getPreviousPageParam?: GetPreviousPageParamFunction<TPageParam, TPage>
  /**
   * How many pages the query keeps: a page added past it drops pages at the
   * other end, down to that many, and a refetch fetches the pages kept.
   * Lowered while the query holds more, it takes effect as the next page
   * comes, or with a refetch, which fetches the pages held and keeps the last
   * of them. Unset, or not above `0`, it keeps them all. Give
   * `getPreviousPageParam` along with it, or the pages dropped from the start
   * can't be fetched again.
   */
  maxPages?: number
}

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
  /**
   * Whether the query has been marked stale via `invalidateQueries`. A fetch
   * that gets all of the query's data again after the invalidation clears it
   * as it lands, and so does a `setQueryData` write. A page that an infinite
   * query adds to pages read before the invalidation doesn't.
   */
  isInvalidated: boolean
  /** Number of consecutive failed attempts in the current fetch. */
  failureCount: number
  /** Error of the most recent failed attempt, or `null`. */
  failureReason: TError | null
  /** Timestamp (ms) of the last successful update; `0` if never. */
  updatedAt: number
}

/**
 * A query, as a cache callback gets it (see {@link withQueryCache}): its key
 * and the key's hash, its state once the fetch ended, and the `meta` of the
 * options that the fetch ran with. It stays as the fetch left it: what
 * happens to the query afterwards doesn't change it.
 */
export type QuerySnapshot<TData = unknown, TError = unknown> = {
  /** The query's key. */
  readonly queryKey: QueryKey
  /** The key's hash, which the cache keeps the query under. */
  readonly queryHash: string
  /** The query's state once the fetch ended, its outcome included. */
  readonly state: Readonly<QueryState<TData, TError>>
  /** The `meta` of the options that the fetch ran with, if they have one. */
  readonly meta: QueryMeta | undefined
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
   * it. Queries nobody shows are only marked either way. A fetch of a query
   * not refetched now still lands, and the query stays marked: a component
   * that starts showing it meanwhile waits for that fetch.
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

/**
 * Types that an app declares once for the whole library, by declaration
 * merging. `queryMeta` is the type of every query's `meta` (see
 * {@link QueryMeta}), and `mutationMeta` that of every mutation's (see
 * {@link MutationMeta}). The file that declares them needs an import or an
 * export, such as the import below: without one, its declaration replaces
 * the library's types rather than adding to them.
 *
 * ```ts
 * import type { QueryKey } from 'ngx-signal-query'
 *
 * declare module 'ngx-signal-query' {
 *   interface Register {
 *     queryMeta: { errorMessage?: string; silent?: boolean }
 *     mutationMeta: { invalidates?: QueryKey }
 *   }
 * }
 * ```
 */
// An interface, unlike the other types here: only an interface takes the
// fields an app declares on it. Empty: an app adds the fields it needs.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

/**
 * The type of a query's `meta`: the `queryMeta` that the app declares on
 * {@link Register}, or any plain object.
 */
export type QueryMeta = Register extends {
  queryMeta: infer TMeta extends object
}
  ? TMeta
  : Record<string, unknown>

/**
 * The type of a mutation's `meta`: the `mutationMeta` that the app declares
 * on {@link Register}, or any plain object.
 */
export type MutationMeta = Register extends {
  mutationMeta: infer TMeta extends object
}
  ? TMeta
  : Record<string, unknown>

/** Configuration for a query, passed to {@link injectQuery} / {@link queryOptions}. */
export type QueryOptions<
  TData,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
> = {
  /** Unique cache key for this query. See {@link QueryKey}. */
  queryKey: TQueryKey
  /**
   * Fetcher returning the data as an `Observable` or `Promise`, given the
   * query's key and an abort signal (see {@link QueryFunctionContext}).
   * Return `null` for no data: `undefined` fails the fetch, with no retry.
   * Once no component shows the query, an `Observable` fetch in flight is
   * unsubscribed, which aborts an `HttpClient` request, and so is a `Promise`
   * one whose function read the signal, which is aborted; any other
   * `Promise` one runs to the end, and its response is kept. Either way,
   * Angular counts the app as busy until the fetch is done: a server render
   * and `whenStable()` wait for it. With zone.js, it runs outside Angular's
   * zone, as `HttpClient` sends its requests: what it starts, a timer say,
   * neither keeps the app busy nor runs change detection. Its data comes back
   * into the zone when the fetch was asked for from there.
   */
  queryFn: QueryFunction<TData, TQueryKey>
  /** How long fetched data stays fresh before refetching, in ms. Default `0`. */
  staleTime?: number
  /**
   * How long the query stays in the cache once nothing uses it (no component
   * shows it, no fetch of it is in flight), in ms. Default 5 minutes.
   * `Infinity` keeps it until it's removed, and so does anything over about
   * 24.8 days (2³¹−1 ms), the most a timer can hold. When components showing
   * it, `query()`, `infiniteQuery()` and `fetchQuery()` ask for different
   * gcTimes, the longest wins for as long as the query stays in the cache.
   * A longer gcTime restarts a running countdown, even on a fresh cache hit.
   * On the server it's always `Infinity`.
   */
  gcTime?: number
  /**
   * Retry policy on failure. Default `3`. On the server the default is `0`,
   * so the page shows a failure at once; a value set here or in
   * {@link withDefaultOptions} applies there too. See {@link RetryValue}.
   */
  retry?: RetryValue<TError>
  /** Delay between retries. See {@link RetryDelayValue}. */
  retryDelay?: RetryDelayValue<TError>
  /**
   * Refetch on a timer while the query is observed and enabled, whatever its
   * `staleTime`. While the page is hidden it doesn't poll, unless
   * `refetchIntervalInBackground` is set. The timer restarts only when the
   * key, `enabled` or the interval changes. On the server it doesn't poll:
   * the page shows one fetch, and polling starts once the browser takes over.
   * See {@link RefetchIntervalValue}.
   */
  refetchInterval?: RefetchIntervalValue<TData, TError>
  /**
   * Whether the query keeps polling while the page is hidden: the user is on
   * another tab, or the window is minimized. Default `false`: no poll goes out
   * while it's hidden; coming back refetches stale data (see
   * `refetchOnWindowFocus`), and polling goes on from there. Turn it on for
   * data that must stay current while the user is away, such as a count in
   * the tab's title.
   */
  refetchIntervalInBackground?: boolean
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
   * Seed data to render immediately (treated as already-resolved). It seeds a
   * query that has no data yet: a new one, or one whose fetch failed before it
   * had any. A function runs only then; returning `undefined` seeds nothing,
   * so the query loads as it would without it. {@link QueryClient.query} and
   * {@link QueryClient.infiniteQuery} seed it too, before `staleTime` decides
   * whether to fetch, so a fresh seed resolves with no request.
   */
  initialData?: TData | (() => TData | undefined)
  /**
   * Data shown while the query is `'pending'` with no data yet, either a value
   * or a function of the previous query's data (see {@link keepPreviousData}).
   * Unlike `initialData` it is never written to the cache: the query stays
   * `'pending'` underneath, and `isPlaceholderData` is `true` while shown. It
   * has the query's data type: a placeholder that doesn't fit is an error,
   * not a wider `data()`.
   */
  placeholderData?: NoInfer<TData> | PlaceholderDataFunction<NoInfer<TData>>
  /** Timestamp (ms) for `initialData`; older data is considered stale. */
  initialDataUpdatedAt?: number | (() => number)
  /**
   * Whether new data keeps the parts of the cached data that didn't change,
   * so `data()` keeps its reference when a refetch brings the same data.
   * Default `true`; turn it off for large responses refetched often. A
   * function merges data of the query's data type. See
   * {@link StructuralSharingValue}.
   */
  structuralSharing?: StructuralSharingValue<NoInfer<TData>>
  /** Set `false` to disable fetching (e.g. until a dependency is ready). */
  enabled?: boolean
  /**
   * What the app's cache callbacks need to know about the query, such as the
   * message to show when it fails (see {@link withQueryCache}). The library
   * itself doesn't read it. A callback gets the `meta` of the options that
   * the fetch ran with: those of the component the query is fetched for, or
   * of the call that fetches it, such as `query()`. Its type is the
   * `queryMeta` that the app declares on {@link Register}, if it does.
   */
  meta?: QueryMeta
}

/**
 * {@link QueryOptions} whose `initialData` always seeds the query: a value
 * whose type leaves `undefined` out, or a function whose return type does.
 * Such a query has data from its first read, so {@link injectQuery} gives a
 * {@link DefinedQueryResult} for it, and a {@link queryOptions} definition
 * keeps this type. Write it as the return type of a method that returns such
 * a definition, with a key type that carries the data type, such as
 * `DefinedInitialDataOptions<Todo[], Error, DataTag<QueryKey, Todo[]>>`: with
 * `QueryOptions` there, the seed drops out of the type, and `data()` may be
 * `undefined` again; with no {@link DataTag}, the key carries no data type.
 *
 * @typeParam TData - Type of the data resolved by `queryFn`.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 */
export type DefinedInitialDataOptions<
  TData,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
> = QueryOptions<TData, TError, TQueryKey> & {
  // A seed that may be undefined, a value or what a function returns, doesn't
  // fit. Without Exclude it would: TData would take undefined in from the
  // seed itself.
  initialData: Exclude<TData, undefined> | (() => Exclude<TData, undefined>)
}

/**
 * {@link QueryOptions} with defaults resolved (internal, set by {@link QueryClient}).
 * `TQueryFnData` is what `queryFn` gives: the data itself, unless a fetch
 * makes the data out of several responses, such as the pages of a list.
 *
 * @internal
 */
export type DefaultedQueryOptions<
  TData,
  TError = Error,
  TQueryFnData = TData,
> = Omit<QueryOptions<TData, TError>, 'queryFn'> & {
  queryFn: QueryFunction<TQueryFnData>
  staleTime: number
  gcTime: number
  retry: RetryValue<TError>
  retryDelay: RetryDelayValue<TError>
  structuralSharing: StructuralSharingValue<TData>
  refetchOnWindowFocus: boolean | 'always'
  refetchOnReconnect: boolean | 'always'
  refetchIntervalInBackground: boolean
}

/** Reactive result returned by {@link injectQuery}; every field is a signal. */
export type QueryResult<TData, TError = Error> = {
  /**
   * Last resolved data, or `undefined` before the first success. It keeps its
   * reference while refetches bring the same data (see `structuralSharing`).
   */
  data: Signal<TData | undefined>
  /**
   * When the data was last updated, as a timestamp in ms: when the last
   * response landed or `setQueryData` wrote it; for `initialData`, its
   * `initialDataUpdatedAt`, or when it was seeded; for data a server render
   * brought over (see {@link withHydration}), as it was on the server. A
   * refetch that brings the same data moves it too; one that fails or is
   * cancelled doesn't. `0` while there is no data, placeholder data included.
   */
  dataUpdatedAt: Signal<number>
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
  /**
   * Whether a fetch of the query has landed, with data or with an error, or
   * `setQueryData` has written to it. Neither `initialData` nor
   * `placeholderData` counts. Data that a server render brought over (see
   * {@link withHydration}) counts if the server fetched it, and not if it was
   * only `initialData` there.
   */
  isFetched: Signal<boolean>
  /**
   * Whether a fetch of the query has landed, with data or with an error, or
   * `setQueryData` has written to it, since the component started showing the
   * query, whoever made the fetch. A response that comes back at once, such as
   * `of()`'s, counts for the component that asked for it, not for one that
   * starts showing the query after it landed. A page that shows cached data or
   * `initialData` can wait for a fetch of its own with it. A background
   * refetch doesn't turn it back to `false`. A key change does, until a fetch
   * of the new key lands, and so does the key coming back after
   * `removeQueries()` or `clear()` dropped it, whatever brings it back. A
   * component whose cached data is still fresh for its `staleTime` fetches
   * nothing as it starts, so this stays `false` until something else fetches
   * the query.
   */
  isFetchedAfterMount: Signal<boolean>
  /** Consecutive failures in the current fetch. */
  failureCount: Signal<number>
  /** Error of the most recent failed attempt, or `null`. */
  failureReason: Signal<TError | null>
  /**
   * Forces a fresh fetch. A fetch already in flight is cancelled, or, while
   * there's no data yet, let land and show first. Resolves once a fetch
   * started after the call has settled, or a fetch that replaced it has,
   * with `data` and `error` as the signals above hold them then. No fetch
   * follows one let land if it's cancelled or removed, or if by the time it
   * lands this query has moved to another key or been destroyed and no
   * enabled component shows the key: the promise then resolves as soon as
   * it's done. A result of {@link injectQueries} whose key has left the list
   * fetches nothing, and the promise resolves at once. It never rejects: a
   * failure shows in `error`.
   */
  refetch: () => Promise<{ data: TData | undefined; error: TError | null }>
}

/**
 * The result {@link injectQuery} gives for a query whose `initialData` always
 * seeds it (see {@link DefinedInitialDataOptions}): the signals of a
 * {@link QueryResult}, with `data()` of the type `TData` rather than
 * `TData | undefined`. It fits wherever a `QueryResult` does.
 */
// Omit, not an intersection with QueryResult: data would then be both
// signals, and calling it gives the first one's type, TData | undefined.
export type DefinedQueryResult<TData, TError = Error> = Omit<
  QueryResult<TData, TError>,
  'data'
> & {
  /**
   * The query's data from the first read on: the data the query holds, or the
   * seed whenever it holds none. It keeps its reference while refetches bring
   * the same data (see `structuralSharing`).
   */
  data: Signal<TData>
}

/**
 * Configuration for an infinite query, passed to {@link injectInfiniteQuery},
 * {@link infiniteQueryOptions} or {@link QueryClient.infiniteQuery}: those of
 * a query (see {@link QueryOptions}), whose data is the pages (see
 * {@link InfiniteData}), and how it pages (see {@link InfinitePageOptions}).
 */
export type InfiniteQueryOptions<
  TPage,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
> = Omit<
  QueryOptions<InfiniteData<TPage, TPageParam>, TError, TQueryKey>,
  'queryFn'
> &
  InfinitePageOptions<TPage, TPageParam> & {
    /**
     * Fetches one page as an `Observable` or `Promise`, given the query's
     * key, an abort signal and the page's param (see
     * {@link InfiniteQueryFunctionContext}). Return `null` for a page with no
     * data: `undefined` fails the fetch, with no retry. Otherwise it behaves
     * as a query's `queryFn` does, page by page (see {@link QueryOptions}).
     */
    queryFn: InfiniteQueryFunction<TPage, TQueryKey, TPageParam>
  }

/**
 * {@link DefinedInitialDataOptions} for an infinite query:
 * {@link InfiniteQueryOptions} whose `initialData` always seeds the list, the
 * pages as a value whose type leaves `undefined` out or a function whose
 * return type does. {@link injectInfiniteQuery} gives a
 * {@link DefinedInfiniteQueryResult} for such a list, and an
 * {@link infiniteQueryOptions} definition keeps this type. Written as the
 * return type of a method, it takes a key type with {@link DataTag} too.
 *
 * @typeParam TPage - Type of one page, as `queryFn` resolves it.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @typeParam TPageParam - Type of the param each page is fetched with.
 */
export type DefinedInitialDataInfiniteOptions<
  TPage,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
> = InfiniteQueryOptions<TPage, TError, TQueryKey, TPageParam> & {
  initialData:
    | InfiniteData<TPage, TPageParam>
    | (() => InfiniteData<TPage, TPageParam>)
}

/**
 * Reactive result returned by {@link injectInfiniteQuery}: a query's result
 * (see {@link QueryResult}), whose data is the pages, and what fetches the
 * pages around them. Every field but the functions is a signal.
 */
export type InfiniteQueryResult<
  TPage,
  TError = Error,
  TPageParam = unknown,
> = QueryResult<InfiniteData<TPage, TPageParam>, TError> & {
  /**
   * Fetches the page after the last one, with the param `getNextPageParam`
   * gives, and adds it to the pages. A fetch of the query already in flight
   * is waited for instead, and no page is added: call it again once that
   * one is done. With no next page it does nothing, and with no pages yet it
   * fetches the first one. Resolves with `data` and `error` as the signals
   * hold them once done; it never rejects: a failure shows in `error`.
   */
  fetchNextPage: () => Promise<{
    data: InfiniteData<TPage, TPageParam> | undefined
    error: TError | null
  }>
  /**
   * Fetches the page before the first one, with the param
   * `getPreviousPageParam` gives, and adds it to the pages, as
   * `fetchNextPage()` does the next one.
   */
  fetchPreviousPage: () => Promise<{
    data: InfiniteData<TPage, TPageParam> | undefined
    error: TError | null
  }>
  /**
   * Whether there is a page after the last one: `getNextPageParam` gives a
   * param for it. `false` while there are no pages.
   */
  hasNextPage: Signal<boolean>
  /**
   * Whether there is a page before the first one: `getPreviousPageParam`
   * gives a param for it. `false` while there are no pages, and without
   * `getPreviousPageParam`.
   */
  hasPreviousPage: Signal<boolean>
  /** Whether the fetch in flight is that of the next page. */
  isFetchingNextPage: Signal<boolean>
  /** Whether the fetch in flight is that of the previous page. */
  isFetchingPreviousPage: Signal<boolean>
  /**
   * Whether the query failed fetching the next page: `isError()` is `true`,
   * and the pages it had stay. Also `true` while the next page loads with
   * the query still in `'error'`, until that fetch lands, as `isError()` is:
   * check `isFetchingNextPage()` first.
   */
  isFetchNextPageError: Signal<boolean>
  /**
   * Whether the query failed fetching the previous page: `isError()` is
   * `true`, and the pages it had stay. Also `true` while the previous page
   * loads with the query still in `'error'`, until that fetch lands, as
   * `isError()` is: check `isFetchingPreviousPage()` first.
   */
  isFetchPreviousPageError: Signal<boolean>
}

/**
 * The result {@link injectInfiniteQuery} gives for a list whose `initialData`
 * always seeds it (see {@link DefinedInitialDataInfiniteOptions}): the
 * signals and functions of an {@link InfiniteQueryResult}, with `data()`
 * holding the pages from the first read, never `undefined` in its type. It
 * fits wherever an `InfiniteQueryResult` does.
 */
// Omit, like DefinedQueryResult: an intersection would give data() the type
// TData | undefined.
export type DefinedInfiniteQueryResult<
  TPage,
  TError = Error,
  TPageParam = unknown,
> = Omit<InfiniteQueryResult<TPage, TError, TPageParam>, 'data'> & {
  /**
   * The pages and their params from the first read on: those the query holds,
   * or the seed whenever it holds none.
   */
  data: Signal<InfiniteData<TPage, TPageParam>>
}

/** Default query options applied to every query unless overridden per-query. */
export interface DefaultQueryOptions {
  /** How long fetched data is considered fresh, in ms. Defaults to `0`. */
  staleTime?: number
  /**
   * How long a query stays in the cache once nothing uses it, in ms. Defaults
   * to 5 minutes. It applies to queries that `query()`, `infiniteQuery()` and
   * `fetchQuery()` prefetch and `setQueryData()` writes too.
   */
  gcTime?: number
  /**
   * Retry policy on failure: a boolean, a count, or a predicate. Defaults to
   * `3`, or to `0` on the server; a value set here applies there too.
   */
  retry?: RetryValue<unknown>
  /** Delay between retries, in ms or a function of the attempt. */
  retryDelay?: RetryDelayValue<unknown>
  /** Whether new data keeps the parts of the cached data that didn't change. Defaults to `true`. */
  structuralSharing?: StructuralSharingValue<unknown>
  /** Whether queries refetch when the user comes back to the page. Defaults to `true`. */
  refetchOnWindowFocus?: boolean | 'always'
  /** Whether queries refetch when the network comes back. Defaults to `true`. */
  refetchOnReconnect?: boolean | 'always'
  /** Whether queries keep polling while the page is hidden. Defaults to `false`. */
  refetchIntervalInBackground?: boolean
}

/**
 * Default mutation options applied to every mutation. A mutation's own value
 * replaces the default for that field only; a field it leaves `undefined`
 * keeps the default.
 *
 * The hooks run in the injection context of the injector that provides the
 * client, so they can call `inject()` before their first `await`. Once that
 * injector is destroyed, or the app it's part of is torn down, they no longer
 * run.
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
