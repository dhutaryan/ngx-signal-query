Every query lives in the cache under its key, and its life there is governed by
**two independent clocks**. Almost every question about "why did it refetch?" or
"why is my data gone?" comes down to mixing them up, so it's worth pinning them
down.

- **`staleTime`** — how long data stays **fresh**. While fresh, the query won't
  refetch. It's about *when to refetch* data someone is looking at.
- **`gcTime`** — how long **unused** data is **kept** after nobody's looking. When
  it runs out, the entry is deleted. It's about *when to forget* data no one is
  looking at.

Freshness and retention. One decides refetching, the other decides deletion, and
they don't affect each other.

## The lifecycle

Follow one query key through its whole life. Defaults: `staleTime: 0`,
`gcTime: 5 minutes`.

1. **First mount.** A component does `injectQuery(() => todos())`. Nothing is
   cached, so the query fetches. The result is stored under `['todos']`, stamped
   with the time it arrived.

2. **A second mount, same key.** Another component injects the same query. It
   reads the **existing** cache entry — no second request. If the data is still
   fresh (within `staleTime`) it just renders; if it's stale, a background
   refetch runs while the cached data stays on screen. Either way, both
   components share one entry and one request.

3. **Both unmount.** The query now has **no observers**. It isn't deleted right
   away — the `gcTime` timer starts (5 minutes by default). The data is still
   there, just unwatched.

4. **A remount, within `gcTime`.** Someone injects the key again before the timer
   fires. The entry is still in the cache, so its data shows **instantly**, and
   the gc timer is cancelled. A background refetch runs if it's now stale.

5. **No remount, `gcTime` elapses.** The timer fires and the entry is removed.
   The next mount starts over from step 1 — a cold fetch.

An **observed** query is never garbage-collected: the clock only runs while
nobody's watching.

## `staleTime` — freshness

`staleTime` is the window during which data is trusted without checking the
server. Staleness is simply `now - fetchedAt >= staleTime`.

```ts
queryOptions({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  staleTime: 30_000, // trust it for 30s; don't refetch on mount within that
})
```

The default is **`0`** — data is stale the instant it arrives. That's why, out
of the box, a query refetches every time a new component mounts it: it's never
considered fresh. Turn that off by raising `staleTime`.

At the other end, **`Infinity`** means never stale — the query fetches once and
then only ever refetches when you invalidate it by hand.

Stale data isn't thrown away. A stale query still shows its cached data
immediately and refetches in the background — you never stare at a blank screen
waiting for a refresh.

## `gcTime` — retention

`gcTime` (garbage-collection time) is how long an entry survives **after its last
observer leaves**. The timer starts at zero observers and is cancelled the moment
one comes back.

```ts
queryOptions({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  gcTime: 10 * 60_000, // keep unused todos around for 10 minutes
})
```

The default is **5 minutes**. Raise it to keep data warm for slow back-and-forth
navigation; lower it to free memory sooner. It has nothing to do with freshness —
a query can be stale but still cached (so it renders instantly, then refetches),
or fresh but collected (gone, because nobody looked at it for `gcTime`).

## Setting the defaults

Set either per query, as above, or once for the whole app:

```ts
provideQueryClient(
  withDefaultOptions({
    queries: {
      staleTime: 60_000, // an app-wide "trust data for a minute"
      gcTime: 10 * 60_000,
    },
  }),
)
```

Per-query options always win over the defaults.

## Scroll restoration comes for free

Because a cached query renders **synchronously** on mount (its data is there
before the first paint), returning to a screen within `gcTime` reconstructs it at
its previous size — which is exactly what scroll restoration needs to land on the
right spot.

There's nothing to configure on the library side. Just enable Angular's router
scroll restoration:

```ts
provideRouter(
  routes,
  withInMemoryScrolling({
    scrollPositionRestoration: 'enabled',
    anchorScrolling: 'enabled',
  }),
)
```

Navigate away, come back, and the list is already there at full height with the
scroll where you left it — then it quietly refetches if it went stale.

## The one thing people get wrong

`staleTime` and `gcTime` sound similar and do opposite jobs:

| | `staleTime` | `gcTime` |
| --- | --- | --- |
| controls | refetching | deletion |
| applies to | data being observed | data with no observers |
| default | `0` (always stale) | `5 min` |
| "too low" symptom | refetches constantly | data evicted, cold reloads |

If a query refetches more than you expect, `staleTime` is your lever — not
`gcTime`.
