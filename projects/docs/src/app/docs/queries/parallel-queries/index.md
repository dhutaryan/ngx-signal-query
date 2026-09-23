**Parallel** queries run at the same time, so the page waits for the slowest
one rather than for all of them in a row. There is nothing to configure: every
query starts fetching on its own the moment it is created.

## Manual parallel queries

When the number of queries is fixed, there is **no extra effort**. Call
`injectQuery` as many times as you need, side by side:

```ts
export class DashboardComponent {
  readonly #queries = inject(AppQueries)

  // These three fetch in parallel.
  protected readonly users = injectQuery(() => this.#queries.users())
  protected readonly teams = injectQuery(() => this.#queries.teams())
  protected readonly projects = injectQuery(() => this.#queries.projects())
}
```

Each has its own key, cache entry and state; none of them waits for another.
That's the opposite of [Dependent Queries](../dependent-queries), where one
query is deliberately held back until another has resolved.

## Dynamic parallel queries with `injectQueries`

`injectQuery` runs once, in an injection context, so it can't be called in a
loop or inside a `computed`. When the number of queries depends on data — one
per id in a list, say — reach for `injectQueries`.

It takes a function returning an **options object** with a **`queries`**
array, one `QueryOptions` per query, and returns a **signal holding an array of
results**, one `QueryResult` per query in the same order:

```ts
@Injectable({ providedIn: 'root' })
export class TodoQueries {
  readonly #http = inject(HttpClient)

  detail(id: number) {
    return queryOptions({
      queryKey: ['todos', 'detail', id],
      queryFn: () => this.#http.get<Todo>(`/api/todos/${id}`),
    })
  }
}

export class TodoListComponent {
  readonly #queries = inject(TodoQueries)

  readonly todoIds = input.required<number[]>()

  protected readonly todos = injectQueries(() => ({
    queries: this.todoIds().map((id) => this.#queries.detail(id)),
  }))
}
```

Every entry behaves exactly like a standalone `injectQuery`: its own cache
entry, `staleTime`, retries and error. If another component already observes
`['todos', 'detail', 3]`, the two share one request. Each result is the usual
object of signals:

{% raw %}

```html
<ul>
  @for (todo of todos(); track todo) {
  <li>
    @if (todo.isLoading()) { Loading… } @else if (todo.data(); as data) { {{
    data.title }} } @else if (todo.isError()) { Failed: {{ todo.error()?.message
    }} }
  </li>
  }
</ul>
```

{% endraw %}

> You could also fetch the whole batch in a single `queryFn` with `forkJoin`.
> That gives one cache entry for the batch: no per-item caching or
> deduplication, and one failure fails everything. `injectQueries` keeps every
> item a query of its own.

## The list is reactive

The options function is reactive, like everywhere else. When `todoIds()`
changes, the set of queries is reconciled by **`queryKey`**:

- A key that **appears** starts a new query.
- A key that **disappears** ends its query. The observer is released and the
  cache entry is garbage-collected after `gcTime`, as usual.
- A key that **stays** keeps its query and its `QueryResult` object; only the
  options are refreshed. Data isn't refetched just because the list changed.

So adding one id to a list of fifty fires one request, not fifty-one, and
reordering ids reorders the results without touching a single query. Because a
result keeps its identity for as long as its key is in the list, `track todo`
in the template above is enough for Angular to move rows instead of
re-rendering them.

Results are matched by key, so the same key twice in `queries` yields two
results backed by one cache entry.

## Aggregating results

The return value is a signal of results, so summarising across them is a
`computed`:

```ts
protected readonly isPending = computed(() =>
  this.todos().some((todo) => todo.isPending()),
)

protected readonly error = computed(
  () => this.todos().find((todo) => todo.isError())?.error() ?? null,
)

protected readonly loaded = computed(() =>
  this.todos().flatMap((todo) => todo.data() ?? []),
)
```

`computed` tracks exactly the signals it reads. `isPending` re-runs when one
query's status flips, not when another query's data arrives, and the array
itself only changes identity when the set of queries changes.

## Why there is no `combine`

TanStack's `injectQueries` also accepts a `combine` callback that merges the
array of results into a single value. It exists because TanStack's core hands
back plain objects that then have to be wrapped in signals; `combine` lets it
skip the wrapping and track which fields were read.

Here nothing needs wrapping. Each result already _is_ signals, and `computed`
does both the merging and the fine-grained tracking natively. A literal port
would also make the API inconsistent: raw `result.data` inside `combine`, but
`result.data()` outside. So the option isn't there. If a use case turns up
that `computed` can't cover, the options-object shape leaves room to add it
without a breaking change.
