A mutation changes server state, which means whatever queries were reading that
state are now out of date. The fix is one line in `onSuccess`: tell those
queries they're stale, and let them refetch.

```ts
protected readonly addTodo = injectMutation(() => ({
  mutationFn: (title: string) => this.#http.post<Todo>('/api/todos', { title }),
  onSuccess: () => {
    this.#client.invalidateQueries({ queryKey: ['todos'] })
  },
}))
```

Add a todo, and the list refetches itself. No manual cache surgery, no passing
data around.

## What invalidation actually does

`invalidateQueries` marks the matching queries **stale** — it doesn't fetch
anything itself. What happens next depends on whether anyone is looking:

- A query that's **currently on screen** refetches right away, in the
  background. Its data stays visible while the new data loads
  (`isFetching()` flips to `true`, `data()` doesn't blank out) — the
  stale-while-revalidate pattern.
- A query that **isn't currently observed** just keeps the stale mark and
  refetches the next time a component uses it.

So invalidation is cheap and safe to over-call: nothing fetches unless it's
actually needed on screen.

## Matching is by prefix

The filter matches keys by prefix, so one invalidation can cover a whole family
of queries:

```ts
// Refetches ['todos'], ['todos', 5], ['todos', { done: true }] — all of them
this.#client.invalidateQueries({ queryKey: ['todos'] })

// Refetches only the exact key
this.#client.invalidateQueries({ queryKey: ['todos'], exact: true })
```

This is why [structuring keys](/queries/query-keys) generic-to-specific pays
off: after a mutation you invalidate at whatever level makes sense — the whole
`['todos']` family, or just `['todos', 'detail', id]`.

## Invalidating several families

A write often touches more than one thing — adding a todo might change the list
*and* a count somewhere else. Just call it more than once:

```ts
onSuccess: () => {
  this.#client.invalidateQueries({ queryKey: ['todos'] })
  this.#client.invalidateQueries({ queryKey: ['stats'] })
}
```

## `onSuccess` vs `onSettled`

Invalidating in `onSuccess` refetches only when the write succeeded — the usual
case. Use `onSettled` if you want a refetch **either way**, success or error:

```ts
// Re-sync with the server regardless of outcome — e.g. to undo a failed
// optimistic update by pulling the real data back.
onSettled: () => {
  this.#client.invalidateQueries({ queryKey: ['todos'] })
}
```

## A note if you're coming from TanStack Query

There, `invalidateQueries` returns a promise, and the common pattern is to
`await` it inside `onSuccess` so the mutation stays `pending` until the refetch
finishes.

Here it's **synchronous** and returns `void`. It marks queries stale and
returns immediately; the refetch happens on its own, reactively. That means:

- there's nothing to `await`, and no `Promise.all` for multiple invalidations —
  just call it;
- the mutation reaches `'success'` as soon as the write lands, **not** after the
  refetch completes.

If a component needs to know the fresh data has arrived, it reads that from the
**query** — `todos.isFetching()` is `true` while the refetch is in flight, and
`todos.data()` updates when it lands. The signal tells you, so the mutation
doesn't have to wait to.
