`placeholderData` lets a query show *something* while it loads its first data —
a preview, a stand-in, the previous page — instead of a spinner. Unlike
[Initial Data](../initial-data), it is **never written to the cache**: the query
stays `'pending'` underneath, and the placeholder vanishes the moment real data
arrives.

## The basics

```ts
protected readonly todos = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  placeholderData: [{ id: 1, title: 'Buy milk' }],
}))
```

While the request is in flight, `data()` returns the placeholder and `status()`
reads `'success'` — so your template renders content, not a loading state. When
the fetch resolves, the placeholder is replaced by the real data.

The cache never sees any of it. Another component reading `['todos']` gets
`undefined` until the real fetch lands — the placeholder is local to this one
query result.

## Telling placeholder from real data

Because `status()` is `'success'`, you need another way to know the data is only
a stand-in. That's `isPlaceholderData()`:

```ts
@Component({
  template: `
    @if (todos.data(); as todos) {
      <ul [class.stale]="todos.isPlaceholderData()">
        @for (todo of todos; track todo.id) {
          <li>{{ todo.title }}</li>
        }
      </ul>
    }
  `,
})
```

It's `true` while the placeholder is on screen and flips to `false` when the
real data replaces it. Use it to dim the UI, show a subtle spinner, or disable
actions that shouldn't run against fake data.

> `isFetching()` stays `true` the whole time the real request is running — the
> placeholder only masks the *loading* state (`isLoading()` is `false`), not the
> fact that a fetch is happening.

## A value or a function

Pass a function to compute the placeholder from the **previous** query's data.
This is what makes paginated and filtered lists stop flickering: when the key
changes, the function receives the data that was on screen a moment ago.

```ts
protected readonly page = signal(1)

protected readonly todos = injectQuery(() => ({
  queryKey: ['todos', this.page()],
  queryFn: () => this.#http.get<Todo[]>(`/api/todos?page=${this.page()}`),
  placeholderData: (previousData) => previousData,
}))
```

Now clicking to page 2 keeps page 1's rows visible (with
`isPlaceholderData() === true`) instead of collapsing to a spinner, until page 2
arrives.

## keepPreviousData

`(previousData) => previousData` is common enough that there's a helper for it:

```ts
import { injectQuery, keepPreviousData } from 'ngx-signal-query'

protected readonly todos = injectQuery(() => ({
  queryKey: ['todos', this.page()],
  queryFn: () => this.#http.get<Todo[]>(`/api/todos?page=${this.page()}`),
  placeholderData: keepPreviousData,
}))
```

`keepPreviousData` *is* `(previousData) => previousData` — nothing more. Reach
for it whenever the last successful result is a good-enough stand-in for the
next one.

The "previous data" is the last result that actually had data. If a key change
lands on a query that never resolves and you move on again, the placeholder
still falls back to the last real data you saw — not to `undefined`.

## Seeding from another query

Like `initialData`, the placeholder can come from data you already have in the
cache — a list row standing in for a detail view. The difference is that here it
stays a stand-in and never pollutes the detail cache entry:

```ts
export class TodoDetailComponent {
  readonly #http = inject(HttpClient)
  readonly #client = injectQueryClient()

  readonly todoId = input.required<number>()

  protected readonly todo = injectQuery(() => ({
    queryKey: ['todos', 'detail', this.todoId()],
    queryFn: () => this.#http.get<Todo>(`/api/todos/${this.todoId()}`),
    placeholderData: () =>
      this.#client
        .getQueryData<Todo[]>(['todos', 'list'])
        ?.find((todo) => todo.id === this.todoId()),
  }))
}
```

The detail view renders instantly from the list row, then the real fetch fills
in whatever the row didn't have. If the list isn't in the cache, the function
returns `undefined` and the query starts `'pending'` as usual.

## placeholderData or initialData?

They look similar — both render something before the fetch finishes — but they
sit on opposite sides of the cache:

| | `placeholderData` | `initialData` |
| --- | --- | --- |
| Written to the cache? | No | Yes |
| `status()` while shown | `'success'` | `'success'` |
| `isPlaceholderData()` | `true` | `false` |
| Other observers see it? | No | Yes |
| Good for | temporary stand-ins, previous page | real data you'd keep |

The rule of thumb from the [Initial Data](../initial-data) guide still holds:

- Data you'd be happy to keep and share across the app? `initialData`.
- Data that's just a stand-in until the real thing loads? `placeholderData`.

If the two are set together, `initialData` wins — it seeds the cache, so the
query has real data and the placeholder is never consulted.
