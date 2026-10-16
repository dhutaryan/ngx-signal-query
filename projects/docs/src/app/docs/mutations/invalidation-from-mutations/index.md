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

`invalidateQueries` marks the matching queries **stale**. What happens next
depends on whether anyone is looking:

- A query that's **currently on screen** refetches right away, in the
  background — one request, however many components show it. Its data stays
  visible while the new data loads (`isFetching()` flips to `true`, `data()`
  doesn't blank out) — the stale-while-revalidate pattern.
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

## Waiting for the fresh data

`invalidateQueries` returns a promise that resolves once the queries on screen
have their refetch back. A hook that **returns** it keeps the mutation
`'pending'` until then, so a button disabled on `isPending()` comes back only
when the list already shows the new todo:

```ts
protected readonly addTodo = injectMutation(() => ({
  mutationFn: (title: string) => this.#http.post<Todo>('/api/todos', { title }),
  // Returned: the mutation finishes once the list is fresh.
  onSuccess: () => this.#client.invalidateQueries({ queryKey: ['todos'] }),
}))
```

In braces, as in the first example, the hook returns nothing: the mutation
finishes as soon as the write lands, and the list catches up in the
background. Pick by what comes next:

- **Return it** when the next thing the user sees needs the fresh data —
  closing a dialog over the list, or going to the new item.
- **Don't** when the write is the whole point and the list can catch up on its
  own.

For several families, return them all:

```ts
onSuccess: () =>
  Promise.all([
    this.#client.invalidateQueries({ queryKey: ['todos'] }),
    this.#client.invalidateQueries({ queryKey: ['stats'] }),
  ]),
```

The promise never rejects: a refetch that fails shows in its query's
`error()`, and the mutation still succeeds, since the write went through. A
refetch that fails is retried first, though, so a mutation that waits for it
stays pending through the retries.
