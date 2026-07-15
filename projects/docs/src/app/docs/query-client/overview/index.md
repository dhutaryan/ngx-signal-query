The **query client** owns the cache. Every query and mutation reads and writes
through it, and there's exactly one for your whole application — the one you set
up at startup:

```ts
// app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(), provideQueryClient()],
}
```

Most of the time you never touch it directly — `injectQuery` and
`injectMutation` use it under the hood. You reach for it when you need to act on
the cache **imperatively**: refresh data after some event, read or write a
cached value by hand, throw a query away.

## Getting the client

Inject it anywhere in an injection context — a component, a service, a route
guard:

```ts
import { injectQueryClient } from 'ngx-signal-query'

export class TodosComponent {
  readonly #client = injectQueryClient()
}
```

It's the same instance everywhere, so a write in one place is visible
everywhere else.

## What it can do

| Method | Purpose |
| --- | --- |
| `invalidateQueries(filters?)` | Mark queries stale so they refetch. See [Query Invalidation](/query-client/query-invalidation). |
| `getQueryData(key)` | Read a cached value synchronously. See [Manual Cache Updates](/query-client/manual-cache-updates). |
| `setQueryData(key, updater)` | Write to the cache by hand. See [Manual Cache Updates](/query-client/manual-cache-updates). |
| `cancelQueries(filters?)` | Cancel in-flight fetches. See [Cancellation & Removal](/query-client/cancellation-and-removal). |
| `removeQueries(filters?)` | Drop queries from the cache entirely. See [Cancellation & Removal](/query-client/cancellation-and-removal). |
| `fetchQuery(key, queryFn, options?)` | Fetch and cache imperatively, e.g. to prefetch. See [Manual Cache Updates](/query-client/manual-cache-updates). |
| `getQueryCache()` / `getMutationCache()` | The underlying caches — an escape hatch for advanced use. |

Each of these gets its own page in this section. Most of them take
[filters](/query-client/filters) to pick which queries they act on — the same
`queryKey` / `exact` matching that drives invalidation.

## For loading indicators, prefer the signals

The client also exposes `isFetching()` and `isMutating()` as plain numbers, but
for anything reactive use `injectIsFetching()` and `injectIsMutating()`
instead — they return **signals** that update as requests come and go, so your
template just reads them. See [Global Indicators](/query-client/global-indicators).

## A note on scope

There's one client per application, provided at the root. Per-route or
per-component clients, and the multi-client setups you might know from TanStack
Query, aren't a thing here — the cache is global, and that's the whole model.
