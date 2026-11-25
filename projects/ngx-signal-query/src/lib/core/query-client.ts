import { inject, Injectable, untracked } from '@angular/core'

import { onReconnect, onWindowFocus } from './browser-events'
import { injectHostApp } from './host-app'
import { transferCache } from './hydration'
import { infiniteQueryBehavior } from './infinite-query-behavior'
import { inBrowser } from './platform'
import {
  applyInitialData,
  fetchArgsOf,
  type FetchBehavior,
  type Query,
} from './query'
import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import type { MutationFilters, MutationOptions } from './mutation'
import { defaultRetryDelay } from './retryer'
import { functionalUpdate, whenAllSettled } from './utils'
import type {
  DataTag,
  DefaultedQueryOptions,
  InfiniteData,
  InfiniteQueryOptions,
  InvalidateQueryFilters,
  QueryFilters,
  QueryFunction,
  QueryKey,
  QueryMeta,
  QueryOptions,
  RetryDelayValue,
  RetryValue,
  StructuralSharingValue,
  Updater,
} from './types'
import { QUERY_CLIENT_CONFIG, QUERY_CLIENT_HYDRATION } from './injection-tokens'

const DEFAULT_GC_TIME = 5 * 60 * 1000

/**
 * Central registry and cache for queries and mutations.
 *
 * Provided by {@link provideQueryClient} and retrieved with
 * {@link injectQueryClient}. Offers imperative cache access — reading and
 * writing data, and invalidating, cancelling, or removing queries — that
 * complements the reactive {@link injectQuery} / {@link injectMutation} APIs.
 *
 * Its methods aren't reactive. Called from an effect, a method doesn't make
 * the effect depend on the cache, on a query's state, or on what `queryFn` or
 * an updater reads: the effect re-runs only when what it reads itself
 * changes. A read is a snapshot, in a template or a `computed` too; for state
 * that updates, use {@link injectQuery}, {@link injectIsFetching} and
 * {@link injectIsMutating}.
 */
@Injectable()
export class QueryClient {
  // Every method that reads or writes the cache runs its body untracked. A
  // call made from an effect mustn't make the effect depend on what the
  // method reads to do its job: the cache, a query's state, or what queryFn
  // or an updater reads. Otherwise a change to any of them re-runs the effect,
  // and the effect repeats the call.
  readonly #cache = inject(QueryCache)
  readonly #mutationCache = inject(MutationCache)
  readonly #config = inject(QUERY_CLIENT_CONFIG, { optional: true }) ?? {}
  readonly #onServer = !inBrowser()
  // Runs the default hooks in the app's injection context (see HostApp).
  readonly #app = injectHostApp()

  /** @internal */
  constructor() {
    // With withHydration(), the cache carries over from the server render.
    // Here, before anything can read the cache: whatever reads it first, a
    // component or an app initializer, finds the server's data in it.
    if (inject(QUERY_CLIENT_HYDRATION, { optional: true })) {
      transferCache(this.#cache, this.#gcTime())
    }

    // When the user comes back to the page, or the network comes back, each
    // query refetches if one of its observers wants that. Untracked like the
    // methods: an event fired from an effect mustn't make the effect depend
    // on what the refetch reads.
    onWindowFocus(() =>
      untracked(() => this.#cache.getAll().forEach((query) => query.onFocus())),
    )
    onReconnect(() =>
      untracked(() =>
        this.#cache.getAll().forEach((query) => query.onOnline()),
      ),
    )
  }

  /** Returns the underlying query cache. Advanced/internal use. */
  getQueryCache(): QueryCache {
    return this.#cache
  }

  /** Returns the underlying mutation cache. Advanced/internal use. */
  getMutationCache(): MutationCache {
    return this.#mutationCache
  }

  /**
   * Merges per-query options with the configured defaults, filling in
   * `staleTime`, `gcTime`, `retry`, `retryDelay`, `structuralSharing`,
   * `refetchOnWindowFocus`, `refetchOnReconnect` and
   * `refetchIntervalInBackground`. Used internally by {@link injectQuery}.
   * An infinite list's definition fits too: the defaults don't depend on what
   * `queryFn` gives.
   *
   * On the server a query doesn't poll, whatever its `refetchInterval`, and
   * doesn't retry a failure unless the query or the app sets `retry`, so the
   * page renders without waiting on a timer; the browser polls and tries
   * again once it takes over. `gcTime` is always `Infinity` there.
   */
  defaultQueryOptions<TQueryFnData, TError = Error, TData = TQueryFnData>(
    options: Omit<QueryOptions<TData, TError>, 'queryFn'> & {
      queryFn: QueryFunction<TQueryFnData>
    },
  ): DefaultedQueryOptions<TData, TError, TQueryFnData> {
    const defaults = this.#config.defaultOptions?.queries

    // A render with zone.js waits for every pending timer, so on the server a
    // query starts none: it isn't collected (see #gcTime), doesn't poll, and
    // retries only when the query or the app asks.
    return {
      ...options,
      staleTime: options.staleTime ?? defaults?.staleTime ?? 0,
      gcTime: this.#gcTime(options.gcTime),
      retry: options.retry ?? defaults?.retry ?? (this.#onServer ? 0 : 3),
      retryDelay:
        options.retryDelay ?? defaults?.retryDelay ?? defaultRetryDelay,
      structuralSharing:
        options.structuralSharing ?? this.#defaultStructuralSharing(),
      refetchOnWindowFocus:
        options.refetchOnWindowFocus ?? defaults?.refetchOnWindowFocus ?? true,
      refetchOnReconnect:
        options.refetchOnReconnect ?? defaults?.refetchOnReconnect ?? true,
      refetchInterval: this.#onServer ? false : options.refetchInterval,
      refetchIntervalInBackground:
        options.refetchIntervalInBackground ??
        defaults?.refetchIntervalInBackground ??
        false,
    }
  }

  /**
   * Fills in what a mutation leaves unset from the configured mutation
   * defaults, field by field. A field set to `undefined` counts as unset. A
   * default hook runs in the injection context of the injector that provides
   * the client.
   *
   * @internal
   */
  defaultMutationOptions<TData, TError, TVariables, TContext>(
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): MutationOptions<TData, TError, TVariables, TContext> {
    const defaults = this.#config.defaultOptions?.mutations

    return {
      ...options,
      retry: options.retry ?? defaults?.retry,
      retryDelay: options.retryDelay ?? defaults?.retryDelay,
      onSuccess: options.onSuccess ?? this.#app.inContext(defaults?.onSuccess),
      onError: options.onError ?? this.#app.inContext(defaults?.onError),
      onSettled: options.onSettled ?? this.#app.inContext(defaults?.onSettled),
    }
  }

  /**
   * Fetches and caches a query as its options say, unless the cache already
   * holds fresh data for it (see `staleTime`), and resolves with the data.
   * Data that was invalidated, or whose last fetch failed, isn't fresh.
   * Prefer {@link injectQuery} in components; use this to prefetch, from an
   * event handler or an effect, or to wait for the data, such as in a route
   * resolver.
   *
   * Takes a {@link queryOptions} definition as it is; an infinite list's goes
   * to {@link QueryClient.infiniteQuery}. Its `staleTime`, `gcTime`, `retry`,
   * `retryDelay` and `structuralSharing` apply, and its `initialData` seeds a
   * key that holds no data, the way it does for a component, before
   * `staleTime` decides whether to fetch: a fresh seed resolves at once, with
   * no request, even while the key's first load is still in flight. What only
   * a component does with a query doesn't apply: it fetches whatever
   * `enabled` says, doesn't poll, doesn't refetch on focus or reconnect, and
   * leaves `placeholderData` out of the cache.
   *
   * Resolves with the data as the cache holds it: at once if it's fresh,
   * otherwise once the fetch lands. A fetch already in flight is waited for,
   * not made again, its retries included. Rejects with the error if the
   * fetch fails, and rejects, rather than throwing, if the key can't be
   * hashed or an initialData function throws. A cancelled fetch resolves
   * with the data the cache holds, or rejects with a {@link CancelledError}
   * if it holds none; a removed query always rejects with one. Nothing has
   * to wait for the promise: a prefetch that fails only leaves the query in
   * `'error'`. A server render and `whenStable()` wait for the fetch all the
   * same, like they do for a component's query, so its data is in the cache
   * by then.
   *
   * Unlike a component's query in the browser, a fetch it starts doesn't
   * retry a failure unless `retry` is set in the options or in
   * {@link withDefaultOptions}, so whoever waits for the data hears of the
   * failure at once.
   *
   * A query no component shows is removed `gcTime` after the fetch lands, like
   * any unused query is. Its `gcTime` is the longest anything asked for; this
   * call asks for the options', else the configured default, else 5 minutes.
   * A call that asks for longer while that countdown runs starts it over, even
   * when it finds the data fresh and fetches nothing.
   *
   * @typeParam TData - Type of the data resolved by `queryFn`.
   * @typeParam TError - Type of the error thrown by `queryFn`.
   * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
   *   with.
   * @param options - The query's {@link QueryOptions}, such as a
   *   {@link queryOptions} definition. To change one of them for this call,
   *   spread the definition: `{ ...queries.detail(id), staleTime: 30_000 }`.
   * @returns A promise of the data.
   *
   * @example
   * ```ts
   * export const todoResolver: ResolveFn<Todo> = (route) => {
   *   const id = Number(route.paramMap.get('id'))
   *
   *   return injectQueryClient().query(inject(TodoQueries).detail(id))
   * }
   * ```
   */
  query<TData, TError = Error, TQueryKey extends QueryKey = QueryKey>(
    options: QueryOptions<TData, TError, TQueryKey>,
  ): Promise<TData> {
    return this.#fetch(options)
  }

  /**
   * Fetches and caches an infinite list as its definition says, unless the
   * cache already holds the list fresh for its `staleTime`, and resolves with
   * the list. Prefer {@link injectInfiniteQuery} in components; use this to
   * prefetch a list, on hover say, or to wait for its pages, such as in a
   * route resolver.
   *
   * Takes an {@link infiniteQueryOptions} definition as it is. A list with no
   * pages yet gets its first page, fetched with `initialPageParam`, and a
   * component that shows the key afterwards goes on from there with
   * `fetchNextPage()`. A stale list is fetched again the way any refetch of
   * it is: every page it holds, in order, the first with its own param and
   * each next one with the param `getNextPageParam` gives for the page just
   * fetched. `pages` asks for that many pages from the first instead, fewer
   * once `getNextPageParam` gives no next one; `maxPages` still decides how
   * many of them the list keeps. `pages` applies only to a fetch the call
   * starts: a fresh list is left as it is, and a fetch already in flight is
   * waited for.
   *
   * Otherwise it works as {@link QueryClient.query} does: the definition's
   * `staleTime`, `gcTime`, `retry`, `retryDelay` and `structuralSharing`
   * apply, its `initialData` seeds a key that holds no data, and it fetches
   * whatever `enabled` says, without polling or refetching on focus or
   * reconnect, and leaves `placeholderData` out of the cache. A fetch it
   * starts doesn't retry a failure unless `retry` asks: a page that fails
   * rejects the promise, and the list keeps the pages it had.
   *
   * @typeParam TPage - Type of one page, as `queryFn` resolves it.
   * @typeParam TError - Type of the error thrown by `queryFn`.
   * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
   *   with.
   * @typeParam TPageParam - Type of the param each page is fetched with.
   * @param options - The list's {@link InfiniteQueryOptions}, such as an
   *   {@link infiniteQueryOptions} definition, and `pages`: how many pages to
   *   fetch from the first, when the call fetches.
   * @returns A promise of the list.
   *
   * @example
   * ```ts
   * // Prefetch on hover so the list opens with its first page
   * protected prefetchTodos(): void {
   *   this.#client.infiniteQuery(this.#queries.todos())
   * }
   * ```
   */
  infiniteQuery<
    TPage,
    TError = Error,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = unknown,
  >(
    options: InfiniteQueryOptions<TPage, TError, TQueryKey, TPageParam> & {
      pages?: number
    },
  ): Promise<InfiniteData<TPage, TPageParam>> {
    // pages is about this call, not an option of the list.
    const { pages, ...definition } = options

    return this.#fetch<InfiniteData<TPage, TPageParam>, TError, TPage>(
      definition,
      { behavior: infiniteQueryBehavior(definition, pages) },
    )
  }

  /**
   * Fetches and caches a query the way {@link QueryClient.query} does, with
   * its key, its query function and its options apart. For a
   * {@link queryOptions} definition, prefer `query()`: taking it apart keeps
   * only what's passed on, and there's no place here for its `initialData`.
   *
   * Takes `staleTime`, `gcTime`, `retry`, `retryDelay`, `structuralSharing`
   * and `meta`, and resolves, rejects, retries and caches the way `query()`
   * does. A key already fetching is waited for, not fetched again,
   * unless `cancelRefetch` is set: then the fetch in flight is replaced, or,
   * while the key has no data yet, let land, then fetched once more with this
   * call's `queryFn` and options (the last such call's, if several came),
   * unless a retry of it already started after this call. Either way the
   * promise waits for data read after this call, unless the fetch it waits
   * behind is cancelled, as when the last component showing the key leaves
   * while its load runs, an `Observable` or one whose query function read
   * the signal.
   *
   * @typeParam TData - Type of the data resolved by `queryFn`.
   * @typeParam TQueryKey - Type of `key`, which `queryFn` gets the key with.
   * @param key - The query key to fetch and cache under.
   * @param queryFn - Function returning the data as an `Observable` or
   *   `Promise`, given the key and an abort signal (see
   *   {@link QueryFunctionContext}). Return `null` for no data: `undefined`
   *   fails the fetch.
   * @param options - Fetch tuning (`staleTime`, `gcTime`, `retry`,
   *   `retryDelay`, `structuralSharing`, `cancelRefetch`) and the query's
   *   `meta`, which the app's callbacks get (see {@link withQueryCache}).
   * @returns A promise of the data.
   *
   * @example
   * ```ts
   * export const todoResolver: ResolveFn<Todo> = (route) => {
   *   const http = inject(HttpClient)
   *   const id = Number(route.paramMap.get('id'))
   *
   *   return injectQueryClient().fetchQuery(['todos', id], () =>
   *     http.get<Todo>(`/api/todos/${id}`),
   *   )
   * }
   * ```
   */
  fetchQuery<TData, TQueryKey extends QueryKey = QueryKey>(
    key: TQueryKey,
    queryFn: QueryFunction<TData, TQueryKey>,
    options: {
      staleTime?: number
      gcTime?: number
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      retry?: RetryValue<any>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      retryDelay?: RetryDelayValue<any>
      structuralSharing?: StructuralSharingValue<NoInfer<TData>>
      meta?: QueryMeta
      cancelRefetch?: boolean
    } = {},
  ): Promise<TData> {
    // Only the options it takes reach the fetch, whatever else an options
    // object built elsewhere holds, such as a whole definition with its
    // initialData. cancelRefetch is about this call, not an option of the
    // query.
    const {
      cancelRefetch,
      staleTime,
      gcTime,
      retry,
      retryDelay,
      structuralSharing,
      meta,
    } = options

    return this.#fetch<TData>(
      {
        queryKey: key,
        queryFn,
        staleTime,
        gcTime,
        retry,
        retryDelay,
        structuralSharing,
        meta,
      },
      { cancelRefetch },
    )
  }

  /**
   * Reads the current cached data for a query key, or `undefined` if the query
   * is not cached yet. A snapshot: it doesn't update a template, a `computed`
   * or an effect when the data changes. For data that updates, use
   * {@link injectQuery}.
   *
   * The data has the type the key carries: the key of a {@link queryOptions}
   * or {@link infiniteQueryOptions} definition does (see {@link DataTag}), so
   * there's no generic to write. A key written out carries none: give the
   * type as the generic, which TypeScript takes on trust. A generic given
   * for a key that carries a type is checked: the key's data has to fit it,
   * so `<Todo[]>` for a todo's key is an error. A key that may be either of
   * two definitions' keys takes a generic both fit, such as
   * `<Todo | Todo[]>`.
   *
   * @typeParam TData - Type of the cached data: what the key carries, or the
   *   generic.
   * @param key - The query key to read.
   * @returns The cached data, or `undefined`.
   */
  getQueryData<TData>(key: DataTag<QueryKey, TData>): TData | undefined {
    return untracked(() => this.#cache.get<TData>(key)?.state().data)
  }

  /**
   * Writes data into the cache for a query key, creating the entry if needed.
   * The `updater` may be a value or a function of the previous data, which is
   * `undefined` while the key holds none. Useful for optimistic updates.
   *
   * `undefined`, as the value or returned from the function, writes nothing:
   * the cache stays as it was, and a key with no entry gets none. So
   * `(todos) => todos?.map(…)` updates only data that's cached. A default
   * such as `(todos = []) =>` does write: on a key with no data it creates an
   * entry that counts as just fetched, which a query's `staleTime` takes as
   * fresh.
   *
   * A write counts as a fetch that landed: `isFetched()` turns `true`, and so
   * does `isFetchedAfterMount()` in a component that already shows the key,
   * unless `removeQueries()` or `clear()` dropped the key first: the
   * component starts over with the write, as on a key change.
   *
   * The data is merged like a response (see `structuralSharing`): what didn't
   * change keeps its reference, so writing what the cache holds leaves
   * `data()` as it is. It still counts as a write: `dataUpdatedAt` moves, and
   * a stale mark from `invalidateQueries()` is cleared. It merges as the query
   * showing the key asks; with none showing it, the way the cached data was
   * fetched; otherwise by the default.
   *
   * A key no component shows is kept for `gcTime` after the last write, then
   * removed.
   *
   * The data has the type the key carries, as for
   * {@link QueryClient.getQueryData}: with a definition's key, the updater
   * gets that type and has to return it, and a value has to be of it, with no
   * generic to write. A key written out takes the type as the generic, or
   * from the type of the updater's parameter.
   *
   * @typeParam TData - Type of the data: what the key carries, or the
   *   generic.
   * @param key - The query key to write.
   * @param updater - The new data, or a function `(prev) => next`;
   *   `undefined` writes nothing.
   *
   * @example
   * ```ts
   * client.setQueryData<Todo[]>(
   *   ['todos'],
   *   (todos) => todos && [...todos, newTodo],
   * )
   * ```
   */
  setQueryData<TData>(
    key: DataTag<QueryKey, TData>,
    // NoInfer on the new data only. TData comes from the key, the generic or
    // the updater's parameter type, and the new data is checked against it:
    // inferred from the data too, partial data would widen TData and fit. On
    // the parameter, NoInfer would drop the type that an annotated updater
    // gives a key written out, and keep an updater from narrowing a union.
    updater: Updater<TData | undefined, NoInfer<TData> | undefined>,
  ): void {
    untracked(() => {
      // undefined, from the updater or as the value, writes nothing, as in
      // TanStack. The entry is only read until there's data to write: an
      // empty one would bring a removed key back, and a component still
      // showing the key would drop its data for it and load it again.
      const data = functionalUpdate(
        updater,
        this.#cache.get<TData>(key)?.state().data,
      )

      if (data === undefined) return

      const query = this.#cache.getOrCreate<TData>(key, this.#gcTime())

      // It has no options of its own: it merges the way the query's data was
      // fetched, or by the default before any fetch.
      query.setData(data, {
        structuralSharing:
          query.structuralSharing() ?? this.#defaultStructuralSharing<TData>(),
      })
    })
  }

  /**
   * Marks matching queries as stale and refetches the actively observed ones,
   * once per query however many components observe it. The refetch starts
   * right away and replaces a fetch already in flight, which may predate the
   * change; a query with no data yet lets that fetch land and show, then
   * refetches once, however many times it's asked to meanwhile, unless a
   * retry of that fetch already started after the call. A query with no
   * enabled observer keeps the stale mark and refetches as soon as one
   * appears. A fetch of it already in flight still lands, and the query
   * stays marked: an observer that appears meanwhile waits for that fetch,
   * and the query refetches the next time stale data would. Commonly called
   * after a mutation succeeds.
   *
   * Resolves once those refetches have settled, so a mutation hook that
   * returns it keeps the mutation pending until the data is fresh. It never
   * rejects: a refetch that fails shows in its query's `error`.
   *
   * @param filters - Which queries to invalidate; omit to invalidate all.
   *   `refetchType: 'none'` only marks them, and resolves at once.
   *
   * @example
   * ```ts
   * client.invalidateQueries({ queryKey: ['todos'] })
   * ```
   */
  invalidateQueries(filters?: InvalidateQueryFilters): Promise<void> {
    return untracked(() => {
      const queries = this.#cache.findAll(filters)

      queries.forEach((query) => query.invalidate())

      // An inactive query refetches when next observed, as shouldFetch sees
      // the flag. A fetch of it already running lands and leaves the flag
      // set (see Query#invalidate).
      return filters?.refetchType === 'none'
        ? Promise.resolve()
        : whenAllSettled(queries.map((query) => query.refetchIfActive()))
    })
  }

  /**
   * Refetches the matching queries that a component shows, whether their
   * data is stale or not, once per query however many components show it. A
   * fetch already in flight is replaced; a query with no data yet lets it
   * land and show, then refetches once, unless a retry of it already started
   * after the call. Queries nobody shows are left as they are, not even
   * marked stale: to have them refetch once they're shown, invalidate them
   * with `invalidateQueries()`.
   *
   * Resolves once the refetches have settled. It never rejects: a refetch
   * that fails shows in its query's `error`.
   *
   * @param filters - Which queries to refetch; omit to refetch all.
   *
   * @example
   * ```ts
   * await client.refetchQueries({ queryKey: ['todos'] })
   * ```
   */
  refetchQueries(filters?: QueryFilters): Promise<void> {
    return untracked(() =>
      whenAllSettled(
        this.#cache.findAll(filters).map((query) => query.refetchIfActive()),
      ),
    )
  }

  /**
   * Cancels any in-flight fetches for matching queries. Each query goes back
   * to how it was before its fetch: one that failed and was being tried
   * again shows its error again. Data written meanwhile stays, and so does a
   * stale mark from `invalidateQueries()`.
   *
   * @param filters - Which queries to cancel; omit to cancel all.
   */
  cancelQueries(filters?: QueryFilters): void {
    untracked(() =>
      this.#cache.findAll(filters).forEach((query) => query.cancel()),
    )
  }

  /**
   * Removes matching queries from the cache entirely, discarding their data
   * and cancelling their fetches. Nothing is refetched: a component still
   * showing a removed key keeps what it shows until something puts the key
   * back in the cache (a write, a refetch, another component, its own
   * polling, its options function running again), then shows what the cache
   * holds, as after a key change. The options function runs again whenever a
   * signal it reads changes, even if no option ends up different, and the
   * component then fetches the key as it would a new one.
   *
   * @param filters - Which queries to remove; omit to remove all.
   */
  removeQueries(filters?: QueryFilters): void {
    untracked(() =>
      this.#cache
        .findAll(filters)
        .forEach((query) => this.#cache.remove(query)),
    )
  }

  /**
   * Empties the cache, e.g. on sign-out: removes every query, as
   * `removeQueries()` with no filters does, and forgets every mutation.
   *
   * A removed query's data is thrown away and its fetch cancelled; a
   * component still showing its key keeps what it shows until something puts
   * the key back in the cache, such as that component's next poll or
   * `refetch()`. A mutation in flight isn't stopped: its write
   * has most likely reached the server, so it finishes and runs its hooks, as
   * when its component goes away, and a component showing it sees how it
   * went. The app counts as busy until it's done. A hook that writes data
   * into the cache puts that key back; one that only updates what's cached,
   * as `(todos) => todos?.map(…)` does, finds nothing and writes nothing.
   *
   * @example
   * ```ts
   * signOut(): void {
   *   this.auth.clear()
   *   this.#client.clear()
   * }
   * ```
   */
  clear(): void {
    untracked(() => {
      this.#cache.clear()
      this.#mutationCache.clear()
    })
  }

  /**
   * Returns the number of matching queries currently fetching. A snapshot: it
   * doesn't update a template, a `computed` or an effect. For a count that
   * updates, use {@link injectIsFetching}.
   *
   * @param filters - Which queries to count; omit to count all.
   */
  isFetching(filters?: QueryFilters): number {
    return untracked(() => {
      const fetching = this.#cache
        .findAll(filters)
        .filter((query) => query.state().isFetching)

      return fetching.length
    })
  }

  /**
   * Returns the number of matching mutations currently pending. A snapshot:
   * it doesn't update a template, a `computed` or an effect. For a count that
   * updates, use {@link injectIsMutating}.
   *
   * @param filters - Which mutations to count, by their key (see
   *   {@link MutationFilters}); omit to count all.
   */
  isMutating(filters?: Omit<MutationFilters, 'status'>): number {
    return untracked(
      () =>
        this.#mutationCache.findAll({ ...filters, status: 'pending' }).length,
    )
  }

  /**
   * Fetches and caches a query with its options, for query(), infiniteQuery()
   * and fetchQuery(), unless its data is fresh: the options are resolved like
   * a component's, except that a failure isn't retried unless they or the app
   * ask, and the query is seeded with initialData first. The fetch gets the
   * query's data from its queryFn as `behavior` says, such as page by page;
   * without one, queryFn gives the data itself. With `cancelRefetch`, a fetch
   * in flight is replaced rather than waited for (see Query#refetch).
   *
   * @internal
   */
  #fetch<TData, TError = Error, TQueryFnData = TData>(
    options: Omit<QueryOptions<TData, TError>, 'queryFn'> & {
      queryFn: QueryFunction<TQueryFnData>
    },
    {
      behavior,
      cancelRefetch = false,
    }: {
      behavior?: FetchBehavior<TQueryFnData, TData>
      cancelRefetch?: boolean
    } = {},
  ): Promise<TData> {
    return untracked(() => {
      // Resolved like a query's options are, so one set of defaults serves
      // both, except that a failure isn't retried unless asked: whoever waits
      // for the data hears of it at once.
      const defaulted = this.defaultQueryOptions<TQueryFnData, TError, TData>({
        ...options,
        retry:
          options.retry ?? this.#config.defaultOptions?.queries?.retry ?? false,
      })
      let query: Query<TData, TError, TQueryFnData>

      // A key that can't be hashed, or an initialData function that throws,
      // rejects the promise rather than throwing from the call, so a caller
      // that handles the promise hears of it there. Unlike a failed fetch,
      // nothing else shows it: left alone, it's an unhandled rejection. An
      // error from starting the fetch below still throws, such as Angular's
      // NG0200 while the app's ErrorHandler is being created, like it does
      // for an effect created there.
      try {
        query = this.#cache.getOrCreate<TData, TError, TQueryFnData>(
          defaulted.queryKey,
          defaulted.gcTime,
        )

        // A query already in the cache keeps this call's gcTime if it's
        // longer, like it does for each component showing it. Before the
        // seed: a query nobody shows is kept for that long after it's
        // written.
        query.updateGcTime(defaulted.gcTime)
        // Seeded before staleTime decides whether to fetch, like for a
        // component: a fresh seed isn't fetched over.
        applyInitialData(query, defaulted)
      } catch (error) {
        return Promise.reject(error)
      }

      if (!query.shouldFetch(defaulted.staleTime)) {
        return Promise.resolve(query.state().data as TData)
      }

      // A fetch asked for by this call, not by a component ('client'): it
      // runs with this call's options, and gets the data as the call's
      // behavior says.
      const args = { ...fetchArgsOf(defaulted), behavior }

      return cancelRefetch
        ? query.refetch(args, { by: 'client' })
        : query.fetch(args)
    })
  }

  /**
   * How long a query stays in the cache once nothing uses it: the gcTime it
   * asks for, else the configured default, else 5 minutes. Every path that
   * puts a query into the cache takes it from here.
   *
   * On the server it's Infinity, whatever was asked: the cache lives as long
   * as the app that renders the request, and a pending timer would hold up a
   * render with zone.js.
   *
   * @internal
   */
  #gcTime(time?: number): number {
    if (this.#onServer) return Infinity

    return (
      time ?? this.#config.defaultOptions?.queries?.gcTime ?? DEFAULT_GC_TIME
    )
  }

  /**
   * The configured default structuralSharing, or `true`. One default serves
   * every query whatever its data, so a function there takes and returns
   * `unknown`; it's typed as the query's own here.
   *
   * @internal
   */
  #defaultStructuralSharing<TData>(): StructuralSharingValue<TData> {
    return (this.#config.defaultOptions?.queries?.structuralSharing ??
      true) as StructuralSharingValue<TData>
  }
}
