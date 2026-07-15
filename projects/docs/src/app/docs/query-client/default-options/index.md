If most of your queries want the same `staleTime`, or you'd rather retry once
than three times everywhere, don't repeat it on every query — set it once, when
you provide the client.

## `withDefaultOptions`

Pass it as a feature to `provideQueryClient`:

```ts
// app.config.ts
import { provideQueryClient, withDefaultOptions } from 'ngx-signal-query'

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    provideQueryClient(
      withDefaultOptions({
        queries: {
          staleTime: 60_000,
          gcTime: 10 * 60_000,
          retry: 1,
        },
      }),
    ),
  ],
}
```

From then on, every query starts from those values. Anything you don't set keeps
the built-in default ([`staleTime: 0`, `gcTime: 5 min`, `retry: 3`](/query-client/caching)).

## What you can default

Only query options, and only these four:

```ts
type DefaultQueryOptions = {
  staleTime?: number
  gcTime?: number
  retry?: RetryValue
  retryDelay?: RetryDelayValue
}
```

The rest of a query — `queryKey`, `queryFn`, `enabled`, `initialData` — is
inherently per-query, so there's nothing to default there.

## Per-query options always win

Defaults are a starting point, not a lock. A query that sets its own value
overrides the default for that field only:

```ts
provideQueryClient(withDefaultOptions({ queries: { staleTime: 60_000 } }))

// This one query opts out — everything else still gets 60s
injectQuery(() => ({
  queryKey: ['prices'],
  queryFn: () => this.#http.get<Price[]>('/api/prices'),
  staleTime: 0, // prices must always be fresh
}))
```

## Mutations have no defaults

`withDefaultOptions` covers **queries only** — there's no `mutations` block.
Each mutation carries its own options. In particular, a mutation's `retry`
stays `0` (writes aren't retried by default) unless you set it on that mutation;
there's no way to flip retries on for all mutations at once.
