Usually you let queries fill the cache and invalidation refresh it. But sometimes you want to reach in directly — read the current value, write a new one, or put data there before a query ever asks. Three methods on the client cover it.

## Reading: `getQueryData`

Grab the current cached value for a key. It's a **synchronous snapshot** — whatever is in the cache right now, or `undefined` if nothing is:

```ts
const todos = this.#client.getQueryData<Todo[]>(['todos'])
```

This is a one-time read, **not** reactive. It doesn't subscribe, doesn't trigger a fetch, and won't update when the data changes, not even in a template or a `computed`. For live data in a component, use `injectQuery`; reach for `getQueryData` inside imperative code — a mutation hook, an event handler, an effect — where you just need the value as it stands.

> The type is on you: `getQueryData<Todo[]>(...)`. Keys carry no type information, so the generic isn't inferred — pass it explicitly and make sure it matches what the query stores.

## Writing: `setQueryData`

Put a value into the cache by hand. Every query observing that key updates immediately — no request involved:

```ts
// Replace outright
this.#client.setQueryData<Todo[]>(['todos'], nextTodos)

// Or update from the previous value, if there is one
this.#client.setQueryData<Todo[]>(
  ['todos'],
  (todos) => todos && [...todos, newTodo],
)
```

A few things worth knowing:

- **The updater receives the previous value**, which is `undefined` while the key holds no data.
- **`undefined` writes nothing**, returned from the updater or passed as the value: the cache stays as it was, and a key with no entry doesn't get one. So the updater above leaves a list nobody has loaded alone, and a rollback with nothing to restore does nothing. It's not a way to clear the entry: to drop data, use `removeQueries`.
- **Anything else is written**, creating the entry if it doesn't exist, as if just fetched. A default parameter writes too: on a key nothing has fetched, `(todos = []) => [...todos, newTodo]` creates a list holding only `newTodo`, and a component that shows the key later with a `staleTime` takes it as the whole, fresh list and doesn't fetch it. Use a default only when what it builds is all the data the key should hold.
- **Writing what's already there leaves `data()` as it is.** The data is merged with what the cache holds, like a response: if it's equal, `data()` keeps its reference and nothing that reads it runs again. It still counts as a write: `dataUpdatedAt` moves, and a stale mark from `invalidateQueries()` is cleared. See [Structural Sharing](/queries/structural-sharing).
- **A key no component shows is kept for `gcTime`** after the last write, 5 minutes by default, then removed like any other unused query. Each write starts the clock over.

## Updating from a mutation response

Here's where manual writes earn their place. When a mutation's response already contains the updated record, you can **write it straight into the cache** in `onSuccess` instead of invalidating — skipping a refetch entirely:

```ts
protected readonly updateTodo = injectMutation(() => ({
  mutationFn: (todo: Todo) =>
    this.#http.put<Todo>(`/api/todos/${todo.id}`, todo),

  onSuccess: (saved) => {
    // The server handed back the fresh row — drop it into the list directly,
    // if the list is loaded.
    this.#client.setQueryData<Todo[]>(['todos'], (todos) =>
      todos?.map((todo) => (todo.id === saved.id ? saved : todo)),
    )
  },
}))
```

This is the counterpart to [invalidation](/query-client/query-invalidation): two ways to sync the cache after a write.

- **Write the response** when it contains the **complete** updated entity, and only a query or two is affected. No extra round trip.
- **Invalidate** when the response is partial, when a change ripples across many queries, or when you'd rather trust a fresh server fetch than assemble the new state by hand.

They combine, too: write the response for an instant update _and_ invalidate to be sure — `setQueryData` in `onSuccess`, `invalidateQueries` in `onSettled`.

## Prefetching: `query`

`query()` fills the cache **imperatively** — fetch now so the data is already there when a component mounts later. The usual use is prefetching: on hover, or in a route resolver, so the screen renders warm. Hand it the query's definition, the one components show it with:

```ts
// Prefetch on hover so the detail view opens instantly
protected prefetchTodo(id: number): void {
  this.#client.query(this.#queries.detail(id))
}
```

It fetches the query the way the definition says: its `staleTime`, `gcTime`, `retry`, `retryDelay` and `structuralSharing` apply, and its `initialData` seeds a key that holds no data, as it does for a component. What only a component does with a query doesn't apply: `query()` fetches whatever `enabled` says, doesn't poll, doesn't refetch on focus or reconnect, and leaves `placeholderData` out of the cache.

It respects `staleTime`: if the key already holds data that's fresh for it, it does nothing, so prefetching on every hover won't spam the network. The `detail` definition sets no `staleTime`, so its data is stale at once, unless the app's [default options](/query-client/default-options) set one. Give it one for the prefetch by spreading the definition:

```ts
this.#client.query({ ...this.#queries.detail(id), staleTime: 30_000 })
```

It returns a promise of the data, which nothing has to wait for: left alone, the call fills the cache in the background, and a prefetch that fails only leaves the query in `'error'`, for the component to fetch again when it mounts, showing its loading state rather than the prefetch's error.

It's safe to call from an effect as well, to prefetch the next page whenever the page changes, say: see [Calling it from an effect](/query-client/overview#calling-it-from-an-effect).

When the real `injectQuery` mounts, it finds the data already cached and renders without a loading state. If nothing shows it within `gcTime` of the fetch landing, 5 minutes by default, the prefetched query is removed like any other unused one. A fetch still in flight keeps it.

### Waiting for the data

Await the promise when the data is needed before going on, e.g. in a route resolver, so the screen opens with it:

```ts
export const todoResolver: ResolveFn<Todo> = (route) => {
  const id = Number(route.paramMap.get('id'))

  return injectQueryClient().query(inject(TodoQueries).detail(id))
}
```

It resolves with the data, at once if the cached data is fresh, and rejects with the error if the fetch fails. Unlike a component's query in the browser, `query()` doesn't retry a failure unless you ask, with `retry` in the definition or in [Default Options](/query-client/default-options): whoever waits for the data hears of the failure at once. A fetch already in flight that it waits for, one a component started say, keeps its own retries. If the query is removed while you wait, say on sign-out, it rejects with a `CancelledError`; see [Cancellation & Removal](/query-client/cancellation-and-removal).

### Without a definition: `fetchQuery`

`fetchQuery(key, queryFn, options?)` does the same with the key, the query function and the options apart:

```ts
this.#client.fetchQuery(
  ['todos', 'detail', id],
  () => this.#http.get<Todo>(`/api/todos/${id}`),
  { staleTime: 30_000 },
)
```

Its options are `staleTime`, `gcTime`, `retry`, `retryDelay`, `structuralSharing`, and `cancelRefetch`, which waits for data read after the call rather than for a fetch already in flight (see [Query Functions](/queries/query-functions#cancellation-observable-or-promise)). With a definition at hand, use `query()`: taking a definition apart keeps only what you pass on, and there's no place for its `initialData`.

## A note if you're coming from TanStack Query

- **`query()` is here; `prefetchQuery()` and `ensureQueryData()` aren't.** A prefetch is a `query()` whose promise nothing waits for, and it needs no `.catch()`: a failure nobody waits for only shows in the query. For data that's cached already, `query({ ...definition, staleTime: Infinity })` resolves with it, unless the key was invalidated or its last fetch failed; there's no `staleTime: 'static'`.
- **`fetchQuery()` takes the key, the query function and the options apart**, so `fetchQuery({ queryKey, queryFn })` doesn't compile: hand the options to `query()`.
- **No `select`** in `query()`.
- **A key in the cache with no data is seeded with `initialData` first**, as a component seeds it: one whose first load failed, one a disabled component created, or one whose first load is still running. A fresh seed resolves the call at once, with no request. TanStack's `query()` seeds a new key the same way, but fetches the first two kinds, and waits for a first load in flight.
