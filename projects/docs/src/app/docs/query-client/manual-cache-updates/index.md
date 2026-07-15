Usually you let queries fill the cache and invalidation refresh it. But
sometimes you want to reach in directly — read the current value, write a new
one, or put data there before a query ever asks. Three methods on the client
cover it.

## Reading: `getQueryData`

Grab the current cached value for a key. It's a **synchronous snapshot** —
whatever is in the cache right now, or `undefined` if nothing is:

```ts
const todos = this.#client.getQueryData<Todo[]>(['todos'])
```

This is a one-time read, **not** reactive. It doesn't subscribe, doesn't trigger
a fetch, and won't update when the data changes. For live data in a component,
use `injectQuery`; reach for `getQueryData` inside imperative code — a mutation
hook, an event handler — where you just need the value as it stands.

> The type is on you: `getQueryData<Todo[]>(...)`. Keys carry no type
> information, so the generic isn't inferred — pass it explicitly and make sure
> it matches what the query stores.

## Writing: `setQueryData`

Put a value into the cache by hand. Every query observing that key updates
immediately — no request involved:

```ts
// Replace outright
this.#client.setQueryData<Todo[]>(['todos'], nextTodos)

// Or update from the previous value
this.#client.setQueryData<Todo[]>(['todos'], (todos = []) => [
  ...todos,
  newTodo,
])
```

A few things worth knowing:

- **It creates the entry if it doesn't exist.** Writing to a key nothing has
  fetched yet is fine — the entry is created holding your data.
- **The updater receives the previous value**, which may be `undefined` — hence
  the `= []` default above.
- **Returning `undefined` from the updater is a no-op**, not a way to clear the
  entry. It leaves the cache untouched. To actually drop data, use
  `removeQueries`.

## Updating from a mutation response

Here's where manual writes earn their place. When a mutation's response already
contains the updated record, you can **write it straight into the cache** in
`onSuccess` instead of invalidating — skipping a refetch entirely:

```ts
protected readonly updateTodo = injectMutation(() => ({
  mutationFn: (todo: Todo) =>
    this.#http.put<Todo>(`/api/todos/${todo.id}`, todo),

  onSuccess: (saved) => {
    // The server handed back the fresh row — drop it into the list directly.
    this.#client.setQueryData<Todo[]>(['todos'], (todos = []) =>
      todos.map((todo) => (todo.id === saved.id ? saved : todo)),
    )
  },
}))
```

This is the counterpart to
[invalidation](/query-client/query-invalidation): two ways to sync the cache
after a write.

- **Write the response** when it contains the **complete** updated entity, and
  only a query or two is affected. No extra round trip.
- **Invalidate** when the response is partial, when a change ripples across many
  queries, or when you'd rather trust a fresh server fetch than assemble the new
  state by hand.

They combine, too: write the response for an instant update *and* invalidate to
be sure — `setQueryData` in `onSuccess`, `invalidateQueries` in `onSettled`.

## Prefetching: `fetchQuery`

`fetchQuery` fills the cache **imperatively** — fetch now so the data is already
there when a component mounts later. The usual use is prefetching: on hover, or
in a route resolver, so the screen renders warm.

```ts
// Prefetch on hover so the detail view opens instantly
protected prefetchTodo(id: number): void {
  const { queryKey, queryFn } = this.#queries.detail(id)

  this.#client.fetchQuery(queryKey, queryFn, { staleTime: 30_000 })
}
```

It respects `staleTime`: if the key already holds fresh-enough data, it does
nothing, so prefetching on every hover won't spam the network. It returns
`void` — fire-and-forget, populating the cache in the background.

When the real `injectQuery` mounts, it finds the data already cached and renders
without a loading state.
