So far every example has declared its options inline, right inside `injectQuery`. That's fine for one component. It stops being fine the moment a second one needs the same data.

## The problem

Say two components read the todo list. Inline, that means writing the key and the fetcher twice:

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

Now a typo — `['todo']` instead of `['todos']` — silently gives you a _second_ cache entry and a _second_ request, with no error anywhere. And when a mutation later needs to invalidate this data, it has to hardcode `['todos']` a third time.

The key is a contract between distant parts of your app. It deserves a single home.

## queryOptions

`queryOptions()` is an **identity function** — at runtime it hands back exactly what you gave it. Its whole job is to anchor type inference, so a query can be defined once and reused with full type safety:

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

`todos.data()` is typed as `Todo[] | undefined` — inferred straight from `queryFn`, no generics to repeat. A definition whose `initialData` always seeds the query makes it `Todo[]` (see [Initial Data](/queries/initial-data)).

Note that `detail(id)` is just a function taking an argument. Combined with [reactive keys](/queries/query-keys), that's all you need for a query that follows a signal:

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

The payoff isn't only in components. Anywhere you need the key, take it from the definition instead of retyping it:

```ts
const client = injectQueryClient()
const queries = inject(TodoQueries)

// Invalidate — no hardcoded key
client.invalidateQueries({ queryKey: queries.list().queryKey })

// Write to the cache directly: todos is Todo[] | undefined, from the key
client.setQueryData(
  queries.list().queryKey,
  (todos) => todos && [...todos, newTodo],
)
```

Rename the key in the service and every call site follows. Nothing to grep for.

## Prefetching it

The client's `query()` takes the whole definition, to prefetch it on hover, say, or to wait for its data in a route resolver. What the definition says about fetching applies there too, `staleTime` and `gcTime` included:

```ts
// Nothing is fetched while the list is fresh for its staleTime
client.query(queries.list())
```

See [Manual Cache Updates](/query-client/manual-cache-updates#prefetching-query).

## Overriding per component

The returned object is plain, so spread it to tweak one option locally:

```ts
protected readonly todos = injectQuery(() => ({
  ...this.#queries.list(),
  refetchInterval: 5_000, // this component wants live data
}))
```

If the definition has an `initialData` that always seeds the query, a spread keeps it, and with it a `data()` without `undefined`; setting `initialData: undefined` drops both.

## The key carries the data type

A definition's key carries the type of the data cached under it, so `getQueryData` and `setQueryData` take the type from the key, with no generic to write:

```ts
const todos = client.getQueryData(queries.list().queryKey)
//    ^? Todo[] | undefined

client.setQueryData(
  queries.detail(5).queryKey,
  (todo) => todo && { ...todo, done: true },
)

// A compile error: a list isn't a todo
client.setQueryData(queries.detail(5).queryKey, [newTodo])
```

Only the key's TypeScript type changes: at runtime the key is the array you wrote. A generic you still write is checked: the key's data has to fit it, so `getQueryData<Todo[]>(queries.detail(5).queryKey)` is a compile error, rather than a list that turns out to be a todo at runtime. A key written out by hand carries no type: pass the generic, as before, and TypeScript takes it on trust.

Two cases need a type from you:

- **A key that may be either of two definitions' keys** takes a generic that both fit: `getQueryData<Todo | Todo[]>(showList ? queries.list().queryKey : queries.detail(id).queryKey)`.
- **A variable, an array or a signal that holds the keys of several definitions** takes the type `QueryKey`. Inferred from the first key, it carries that key's data type, and a key of other data doesn't fit:

```ts
const keys: QueryKey[] = [queries.list().queryKey, queries.detail(5).queryKey]
```

If you write a method's return type out, keep the key's type in it: with `QueryOptions<Todo[], Error, DataTag<QueryKey, Todo[]>>` the key still carries `Todo[]`, while with `QueryOptions<Todo[]>` it doesn't, and `getQueryData` gives `unknown` again. For a definition whose `initialData` always seeds the query, write `DefinedInitialDataOptions<Todo[], Error, DataTag<QueryKey, Todo[]>>`: with `QueryOptions` the seed drops out of the type, and `data()` may be `undefined` again.

## Testing

A pleasant side effect: query definitions become plain, testable objects. No component, no rendering — get the service from `TestBed`, call the method and assert (see [Testing](/testing)):

```ts
it('builds a stable key per id', () => {
  expect(queries.detail(5).queryKey).toEqual(['todos', 'detail', 5])
})
```

## Mutations too

`mutationOptions()` is the same idea on the write side: a mutation defined once, in a service, typed as `injectMutation` would type it inline, `context` from `onMutate` included. More on that in [Mutation Options](/mutations/mutation-options).
