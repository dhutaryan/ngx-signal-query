Cached data goes out of date, and `invalidateQueries` is how you say so. It
marks matching queries **stale** and lets them refetch — the everyday way to
pull fresh data without touching what's already on screen.

[Invalidation from Mutations](/mutations/invalidation-from-mutations) covers the
most common trigger — a write succeeded. This page is about the method itself:
it's a general tool, and a mutation is just one thing that calls it.

## What "invalidate" does

Two steps, and only the first is immediate:

1. **Mark stale.** The matching queries are flagged — regardless of their
   `staleTime`. Invalidation overrides it; that's the point.
2. **Refetch, if anyone's looking.** A query that's currently observed refetches
   in the background, keeping its old data visible until the new data lands
   (`isFetching()` goes `true`, `data()` doesn't blank). A query nobody is
   observing just keeps the stale mark and refetches the next time a component
   uses it.

So it's cheap: nothing hits the network unless it's actually needed on screen.

## Choosing what to invalidate

The filter picks which queries. There are three shapes.

**Everything** — no filter at all:

```ts
this.#client.invalidateQueries()
```

Every query in the cache becomes stale. Useful behind a global "refresh"
button, or after re-authenticating.

**By key (prefix match)** — the common case. A key matches itself *and* every
key that starts with it:

```ts
// Marks ['todos'], ['todos', 5], ['todos', { done: true }] — the whole family
this.#client.invalidateQueries({ queryKey: ['todos'] })
```

**Exactly one key** — opt out of prefix matching with `exact`:

```ts
// Only ['todos'] itself; ['todos', 5] is left alone
this.#client.invalidateQueries({ queryKey: ['todos'], exact: true })
```

That's the whole filter surface — `queryKey` and `exact`. Prefix matching is the
same mechanic that keys are built around, so ordering them generic-to-specific
(`['todos', 'detail', id]`) lets you invalidate at any level. See
[Query Keys](/queries/query-keys).

## It isn't only for mutations

Anything that makes your cached data wrong is a reason to invalidate. A few
non-mutation triggers:

```ts
// A manual refresh button
protected refresh(): void {
  this.#client.invalidateQueries({ queryKey: ['todos'] })
}

// A realtime message that a resource changed
this.socket.on('todo:changed', () => {
  this.#client.invalidateQueries({ queryKey: ['todos'] })
})

// Coming back to a screen, on a router event
this.router.events.pipe(/* … */).subscribe(() => {
  this.#client.invalidateQueries({ queryKey: ['todos'] })
})
```

Since observed queries refetch on their own, the caller just marks and moves on.

## A note if you're coming from TanStack Query

Two differences worth knowing:

- **Filters are minimal.** TanStack lets you match by `predicate`, by
  active/inactive status, by staleness, by fetch status. Here it's `queryKey`
  and `exact` — nothing else.
- **It's synchronous.** `invalidateQueries` returns `void`, not a promise. It
  marks queries stale and returns; the refetch happens reactively on its own.
  There's nothing to `await` and no `refetchType` option — a query refetches if
  it's observed, and doesn't if it isn't.
