By default a query fetches as soon as it's created. `enabled: false` turns that
off.

[Dependent Queries](/queries/dependent-queries) covers the case where you're
waiting on another query. This page is about the rest: queries that shouldn't
run yet, or shouldn't run automatically at all.

## What "disabled" actually means

With `enabled: false`, the query:

- **won't fetch** when the component is created;
- **won't refetch** when its key changes;
- **won't poll**, even with `refetchInterval` set;
- **won't react to invalidation** — `invalidateQueries()` still marks it stale,
  but nothing is fetched until it's enabled again.

What it *keeps*:

- **its cached data**, if the key was already fetched before. A disabled query
  still reads the cache, so `data()` can be populated even though nothing runs.
- **`refetch()`** — see [below](/queries/disabling-queries#refetch-ignores-enabled).

It stays in `status() === 'pending'` while it has no data. Careful with that —
see [`isPending` does not mean "loading"](/queries/dependent-queries#ispending-does-not-mean-loading).

## Lazy queries

The common case: don't fetch until the user has actually asked for something.
A search box shouldn't hit the server with an empty term:

```ts
export class SearchComponent {
  readonly #http = inject(HttpClient)

  readonly term = signal('')

  protected readonly results = injectQuery(() => ({
    queryKey: ['search', this.term()],
    queryFn: () => this.#http.get<Result[]>(`/api/search?q=${this.term()}`),
    enabled: this.term().length > 2,
  }))
}
```

Nothing is fetched until the term is longer than two characters. Type more and
it fetches; clear the box and it goes quiet again. Because `enabled` is
reactive, that's the whole implementation.

Note that each term gets its own cache entry (it's in the key), so going back
to a previous term shows its results instantly.

## `refetch()` ignores `enabled`

This is the part worth knowing: **`refetch()` fetches even when the query is
disabled.** `enabled` governs *automatic* fetching — mount, key changes,
polling, invalidation. `refetch()` is an explicit instruction from you, and it
always goes through.

That gives you fetch-on-demand: a query that never runs by itself, only when
told to.

{% raw %}

```ts
export class ReportComponent {
  readonly #http = inject(HttpClient)

  protected readonly report = injectQuery(() => ({
    queryKey: ['report'],
    queryFn: () => this.#http.get<Report>('/api/report'),
    enabled: false, // never fetches on its own
  }))
}
```

```html
<button (click)="report.refetch()" [disabled]="report.isFetching()">
  Generate report
</button>

@if (report.isFetching()) {
  <p>Crunching…</p>
} @else if (report.data(); as data) {
  <p>Total: {{ data.total }}</p>
}
```

{% endraw %}

Useful for anything expensive that shouldn't run unless asked — reports,
exports, an "check availability" button.

## There is no pausing

TanStack Query has a separate notion of a *paused* query: one that wants to run
but can't, because the network is offline (`networkMode`). It shows up as a
distinct `fetchStatus` of `'paused'`.

None of that exists here. There's no `networkMode`, no `'paused'` state, and no
automatic offline handling — a query with no connection simply fails and goes
through the normal retry path.

So `enabled` is the only lever: a query either may fetch, or it may not.
