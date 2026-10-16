Cached data goes out of date, and `invalidateQueries` is how you say so. It
marks matching queries **stale** and lets them refetch — the everyday way to
pull fresh data without touching what's already on screen.

[Invalidation from Mutations](/mutations/invalidation-from-mutations) covers the
most common trigger — a write succeeded. This page is about the method itself:
it's a general tool, and a mutation is just one thing that calls it.

## What "invalidate" does

Two steps, both right away:

1. **Mark stale.** The matching queries are flagged — regardless of their
   `staleTime`. Invalidation overrides it; that's the point.
2. **Refetch, if anyone's looking.** A query that's currently observed starts
   refetching in the background — one request, however many components observe
   it — and keeps its old data visible until the new data lands
   (`isFetching()` goes `true`, `data()` doesn't blank). A request already in
   flight is cancelled and restarted, since it may have read the data before
   the change. A query nobody is observing just keeps the stale mark and
   refetches the next time a component uses it.

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

## Waiting for the refetch

`invalidateQueries` returns a promise that resolves once the queries on screen
have their refetch back, every one of them. Await it when what comes next needs
the fresh data:

```ts
protected async refresh(): Promise<void> {
  await this.#client.invalidateQueries({ queryKey: ['todos'] })
  this.#toast.show('Up to date')
}
```

It never rejects: a refetch that fails shows in its query's `error()`. Queries
nobody shows are only marked, so there's nothing to wait for there. Not
awaiting it is fine too; it just doesn't wait.

A mutation hook that returns it keeps the mutation pending until the refetch is
back; see [Invalidation from Mutations](/mutations/invalidation-from-mutations).

## Marking without refetching

`refetchType: 'none'` marks the matching queries stale and refetches none of
them, not even the ones on screen. The promise resolves at once:

```ts
this.#client.invalidateQueries({
  queryKey: ['todos'],
  refetchType: 'none',
})
```

Each one then refetches the next time stale data would: a component starts
showing it, the user comes back to the tab, the network comes back. Use it when
a refetch now would be wasted, e.g. while more writes to the same data are on
their way.

## Refetching without marking: `refetchQueries`

`refetchQueries` refetches the matching queries on screen right away, fresh or
not, once per query, and resolves once they're back. It marks nothing, so
queries nobody shows are left as they are: with a long `staleTime` they still
count as fresh when they're shown again. To have those refetch then, invalidate
them instead.

```ts
await this.#client.refetchQueries({ queryKey: ['todos'] })
```

Like invalidation, it replaces a fetch already in flight and never rejects.

## A note if you're coming from TanStack Query

Two differences worth knowing:

- **Filters are minimal.** TanStack lets you match by `predicate`, by
  active/inactive status, by staleness, by fetch status. Here it's `queryKey`
  and `exact` — nothing else.
- **Only queries on screen are refetched.** `refetchType` takes `'active'`, the
  default, or `'none'`, and `refetchQueries` leaves queries nobody shows alone,
  where TanStack refetches those too by default. A query nobody shows can't
  tell which data its last `queryFn` would fetch now: one that reads a signal,
  as `queryFn: () => this.#api.todo(this.id())` does, would fetch another
  key's data into it. Invalidate them, and each refetches once it's shown.
