Sometimes a query can't run until another one has finished — you need the user
before you can fetch their projects. That's a **dependent query**: it has to
wait for a value that doesn't exist yet.

The tool for this is `enabled`.

## enabled

Set `enabled: false` and the query simply doesn't fetch. It sits there, inert,
until `enabled` flips to `true`.

Since options are reactive, `enabled` can be derived from the thing you're
waiting for:

```ts
export class ProjectsComponent {
  readonly #queries = inject(AppQueries)

  readonly email = input.required<string>()

  // 1. Fetch the user…
  protected readonly user = injectQuery(() =>
    this.#queries.userByEmail(this.email()),
  )

  // 2. …then their projects, but only once we have an id.
  protected readonly projects = injectQuery(() => ({
    ...this.#queries.projectsByUser(this.user.data()?.id ?? 0),
    enabled: this.user.data()?.id !== undefined,
  }))
}
```

The moment `user.data()` resolves, `enabled` becomes `true`, the effect re-runs
and the projects query fetches. No manual orchestration, no `switchMap`, no
subscription — the dependency is expressed as data.

## Put the dependency in the key

This is the same rule as always, but it bites hardest here:

> **The value you waited for must appear in the `queryKey`.**

```ts
// ✅ each user's projects get their own cache entry
queryKey: ['projects', 'byUser', userId]

// ❌ every user's projects collapse into one entry
queryKey: ['projects']
```

Get this wrong and switching users shows the _previous_ user's projects from
the cache, with no refetch. `enabled` controls _when_ a query runs; the key
controls _what it is_. You need both.

## `isPending` does not mean "loading"

Here's the sharp edge. A query has three states — `'pending'`, `'success'`,
`'error'` — and there is no separate "not started" state. So a query waiting on
`enabled: false` reports:

```ts
projects.isPending() // true  — no data yet (correct, but easy to misread)
projects.isFetching() // false — nothing is in flight
projects.isLoading() // false — not actually loading
```

If you render a spinner on `isPending()`, it will spin **forever** while the
query is disabled — nothing is happening, and nothing will, until the
dependency arrives.

Use **`isLoading()`** for "a request is genuinely in flight for the first
time":

{% raw %}

```html
@if (projects.isLoading()) {
  <p>Loading projects…</p>
} @else if (projects.data(); as data) {
<ul>
  @for (project of data; track project.id) {
  <li>{{ project.name }}</li>
  }
</ul>
}
```

{% endraw %}

Recall from [Overview](/queries/overview) that `isLoading()` is exactly
`isFetching() && isPending()` — which is why it correctly stays `false` for a
query that hasn't been allowed to start.

## Showing the whole chain

Usually you want one loading state for the pair, not two. Because everything is
a signal, `computed` does the job:

```ts
protected readonly isLoading = computed(
  () => this.user.isLoading() || this.projects.isLoading(),
)

protected readonly error = computed(
  () => this.user.error() ?? this.projects.error(),
)
```

## A caveat on dynamic chains

`enabled` handles a **fixed** chain: query A, then query B. What it can't do is
fan out into a _variable_ number of dependent queries — one per id in a list
you just fetched, say. That needs a way to run a dynamic set of queries, which
doesn't exist yet (`injectQueries` is not implemented).

For now, either fetch the batch in a single `queryFn` (giving up per-item
caching) or render a child component per item, each running its own
`injectQuery`.
