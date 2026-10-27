import {
  DestroyRef,
  EnvironmentInjector,
  inject,
  Injectable,
  runInInjectionContext,
  untracked,
} from '@angular/core'
import type { Observable } from 'rxjs'

import { onReconnect, onWindowFocus } from './browser-events'
import { inBrowser } from './platform'
import { QueryCache } from './query-cache'
import { MutationCache } from './mutation-cache'
import type { MutationOptions } from './mutation'
import { defaultRetryDelay } from './retryer'
import { functionalUpdate, whenAllSettled } from './utils'
import type {
  DefaultedQueryOptions,
  InvalidateQueryFilters,
  QueryFilters,
  QueryKey,
  QueryOptions,
  RetryDelayValue,
  RetryValue,
  StructuralSharingValue,
  Updater,
} from './types'
import { QUERY_CLIENT_CONFIG } from './injection-tokens'

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
  /** @internal */
  readonly #injector = inject(EnvironmentInjector)
  /**
   * Set once #injector is destroyed. TODO: read DestroyRef.destroyed instead
   * once the minimum supported Angular is 20.1, where it became public.
   *
   * @internal
   */
  #destroyed = false

  /** @internal */
  constructor() {
    inject(DestroyRef).onDestroy(() => (this.#destroyed = true))

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
   *
   * On the server a query doesn't poll, whatever its `refetchInterval`, and
   * doesn't retry a failure unless the query or the app sets `retry`, so the
   * page renders without waiting on a timer; the browser polls and tries
   * again once it takes over. `gcTime` is always `Infinity` there.
   */
  defaultQueryOptions<TData, TError = Error>(
    options: QueryOptions<TData, TError>,
  ): DefaultedQueryOptions<TData, TError> {
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
      onSuccess: options.onSuccess ?? this.#inContext(defaults?.onSuccess),
      onError: options.onError ?? this.#inContext(defaults?.onError),
      onSettled: options.onSettled ?? this.#inContext(defaults?.onSettled),
    }
  }

  /**
   * Imperatively fetches and caches a query, unless fresh data already exists
   * (governed by `staleTime`). Prefer {@link injectQuery} in components; use
   * this to prefetch, from an event handler or an effect, or to wait for the
   * data, e.g. in a route resolver.
   *
   * Resolves with the data as the cache holds it: at once if it's fresh,
   * otherwise once the fetch lands. A key already fetching is waited for,
   * not fetched again, unless `cancelRefetch` is set. Rejects with the error
   * if the fetch fails. A cancelled fetch resolves with the data the cache
   * holds, or rejects with a {@link CancelledError} if it holds none; a
   * removed query always rejects with one. Nothing has to wait for the
   * promise: a prefetch that fails only leaves the query in `'error'`.
   *
   * Unlike a component's query in the browser, it doesn't retry a failure
   * unless `retry` is set here or in {@link withDefaultOptions}, so whoever
   * waits for the data hears of the failure at once.
   *
   * A query no component shows is removed `gcTime` after the fetch lands (the
   * configured default, or 5 minutes), as any unused query is.
   *
   * @param key - The query key to fetch and cache under.
   * @param queryFn - Function returning the data as an `Observable` or `Promise`.
   * @param options - Fetch tuning (`staleTime`, `retry`, `retryDelay`,
   *   `structuralSharing`, `cancelRefetch`).
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
  fetchQuery<TData>(
    key: QueryKey,
    queryFn: () => Observable<TData> | Promise<TData>,
    options: {
      staleTime?: number
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      retry?: RetryValue<any>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      retryDelay?: RetryDelayValue<any>
      structuralSharing?: StructuralSharingValue<TData>
      cancelRefetch?: boolean
    } = {},
  ): Promise<TData> {
    return untracked(() => {
      // Resolved as a query's options are, so one set of defaults serves
      // both, except that a failure isn't retried unless asked: whoever waits
      // for the data hears of it at once. cancelRefetch is about this call,
      // not an option of the query.
      const { cancelRefetch, ...queryOptions } = options
      const defaulted = this.defaultQueryOptions<TData>({
        ...queryOptions,
        queryKey: key,
        queryFn,
        retry:
          queryOptions.retry ??
          this.#config.defaultOptions?.queries?.retry ??
          false,
      })
      const query = this.#cache.getOrCreate<TData>(key, defaulted.gcTime)

      // A query already in the cache keeps this call's gcTime if it's
      // longer, as it does for each component showing it.
      query.updateGcTime(defaulted.gcTime)

      return query.shouldFetch(defaulted.staleTime)
        ? query.fetch(defaulted, { cancelRefetch })
        : Promise.resolve(query.state().data as TData)
    })
  }

  /**
   * Reads the current cached data for a query key, or `undefined` if the query
   * is not cached yet. A snapshot: it doesn't update a template, a `computed`
   * or an effect when the data changes. For data that updates, use
   * {@link injectQuery}.
   *
   * @param key - The query key to read.
   * @returns The cached data, or `undefined`.
   */
  getQueryData<TData>(key: QueryKey): TData | undefined {
    return untracked(() => this.#cache.get<TData>(key)?.state().data)
  }

  /**
   * Writes data into the cache for a query key, creating the entry if needed.
   * The `updater` may be a value or a function of the previous data; returning
   * `undefined` from the function is a no-op. Useful for optimistic updates.
   *
   * The data is merged like a response (see `structuralSharing`): what didn't
   * change keeps its reference, so writing what the cache holds changes
   * nothing. It merges as the query showing the key asks; with none showing
   * it, the way the cached data was fetched; otherwise by the default.
   *
   * A key no component shows is kept for `gcTime` after the last write, then
   * removed.
   *
   * @param key - The query key to write.
   * @param updater - The new data, or a function `(prev) => next`.
   *
   * @example
   * ```ts
   * client.setQueryData<Todo[]>(['todos'], (prev = []) => [...prev, newTodo])
   * ```
   */
  setQueryData<TData>(
    key: QueryKey,
    updater: Updater<TData | undefined, TData>,
  ): void {
    untracked(() => {
      const query = this.#cache.getOrCreate<TData>(key, this.#gcTime())
      const data = functionalUpdate(updater, query.state().data)

      // Matches TanStack: an updater returning undefined is a no-op.
      if (data === undefined) return

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
   * change. A query with no enabled observer keeps the stale mark and
   * refetches as soon as one appears. Commonly called after a mutation
   * succeeds.
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
      // the flag.
      return filters?.refetchType === 'none'
        ? Promise.resolve()
        : whenAllSettled(queries.map((query) => query.refetchIfActive()))
    })
  }

  /**
   * Refetches the matching queries that a component shows, whether their
   * data is stale or not, once per query however many components show it. A
   * fetch already in flight is replaced. Queries nobody shows are left as
   * they are, not even marked stale: to have them refetch once they're shown,
   * invalidate them with `invalidateQueries()`.
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
   * polling), then shows what the cache holds, as after a key change.
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
   * went. A hook that writes into the cache puts that key back.
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
   * Returns the number of mutations currently pending. A snapshot: it doesn't
   * update a template, a `computed` or an effect. For a count that updates,
   * use {@link injectIsMutating}.
   */
  isMutating(): number {
    return untracked(
      () => this.#mutationCache.findAll({ status: 'pending' }).length,
    )
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

  /**
   * Runs a default hook in the injection context of the injector that
   * provides the client, so it can call inject(). The defaults belong to the
   * app, so it's this injector, not the component that started the run.
   *
   * @internal
   */
  #inContext<TArgs extends unknown[]>(
    hook: ((...args: TArgs) => unknown) | undefined,
  ): ((...args: TArgs) => unknown) | undefined {
    if (!hook) return

    return (...args) => {
      // Once that injector is destroyed, the app the defaults belong to is
      // gone: a run that lands after it, e.g. after its test has ended,
      // skips them.
      if (this.#destroyed) return

      return runInInjectionContext(this.#injector, () => hook(...args))
    }
  }
}
