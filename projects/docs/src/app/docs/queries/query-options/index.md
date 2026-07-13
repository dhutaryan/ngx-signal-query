So far every example has declared its options inline, right inside
`injectQuery`. That's fine for one component. It stops being fine the moment a
second one needs the same data.

## The problem

Say two components read the todo list. Inline, that means writing the key and
the fetcher twice:

```ts
// TodoListComponent
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
}))

// TodoCountComponent — same data, written again
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
}))
```

Now a typo — `['todo']` instead of `['todos']` — silently gives you a _second_
cache entry and a _second_ request, with no error anywhere. And when a mutation
later needs to invalidate this data, it has to hardcode `['todos']` a third
time.

The key is a contract between distant parts of your app. It deserves a single
home.

## queryOptions

`queryOptions()` is an **identity function** — at runtime it hands back exactly
what you gave it. Its whole job is to anchor type inference, so a query can be
defined once and reused with full type safety:

```ts
import { inject, Injectable } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { queryOptions } from 'ngx-signal-query'

@Injectable({ providedIn: 'root' })
export class TodoQueries {
  readonly #http = inject(HttpClient)

  public list() {
    return queryOptions({
      queryKey: ['todos', 'list'],
      queryFn: () => this.#http.get<Todo[]>('/api/todos'),
      staleTime: 30_000,
    })
  }

  public detail(id: number) {
    return queryOptions({
      queryKey: ['todos', 'detail', id],
      queryFn: () => this.#http.get<Todo>(`/api/todos/${id}`),
    })
  }
}
```

Components stop caring about keys and URLs entirely:

```ts
export class TodoListComponent {
  readonly #queries = inject(TodoQueries)

  protected readonly todos = injectQuery(() => this.#queries.list())
}
```

`todos.data()` is typed as `Todo[] | undefined` — inferred straight from
`queryFn`, no generics to repeat.

Note that `detail(id)` is just a function taking an argument. Combined with
[reactive keys](/queries/query-keys), that's all you need for a query that
follows a signal:

```ts
export class TodoDetailComponent {
  readonly #queries = inject(TodoQueries)

  readonly todoId = signal(1)

  protected readonly todo = injectQuery(() =>
    this.#queries.detail(this.todoId()),
  )
}
```

## Reusing the key

The payoff isn't only in components. Anywhere you need the key, take it from
the definition instead of retyping it:

```ts
const client = injectQueryClient()
const queries = inject(TodoQueries)

// Invalidate — no hardcoded key
client.invalidateQueries({ queryKey: queries.list().queryKey })

// Write to the cache directly
client.setQueryData<Todo[]>(queries.list().queryKey, (todos = []) => [
  ...todos,
  newTodo,
])
```

Rename the key in the service and every call site follows. Nothing to grep for.

## Overriding per component

The returned object is plain, so spread it to tweak one option locally:

```ts
protected readonly todos = injectQuery(() => ({
  ...this.#queries.list(),
  refetchInterval: 5_000, // this component wants live data
}))
```

## Two rough edges

Worth knowing, because they're places where the pattern doesn't fully pay off
yet.

**`fetchQuery` takes positional arguments**, not an options object, so you
can't hand it a definition wholesale — you have to take it apart:

```ts
const { queryKey, queryFn, staleTime } = this.#queries.list()

this.#client.fetchQuery(queryKey, queryFn, { staleTime })
```

**`getQueryData` won't infer the data type from the key.** Keys are plain
arrays and carry no type information, so the generic stays explicit:

```ts
// The <Todo[]> is on you — it isn't derived from queries.list()
const todos = client.getQueryData<Todo[]>(queries.list().queryKey)
```

## Testing

A pleasant side effect: query definitions become plain, testable objects. No
component, no `TestBed`, no rendering — just call the method and assert:

```ts
it('builds a stable key per id', () => {
  expect(queries.detail(5).queryKey).toEqual(['todos', 'detail', 5])
})
```

## Mutations too

`mutationOptions()` is the same idea on the write side, and it earns its keep
even harder there: it links the `TContext` returned by `onMutate` to the
`context` argument of `onSuccess` / `onError` / `onSettled`, so optimistic
rollbacks type-check. More on that in the Mutations guides.
