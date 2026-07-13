The query key is what the whole cache is built on. It's how the library knows
that two components are asking for the same data, when a cached entry can be
reused, and which queries an invalidation should touch.

A key is always an **array** (`QueryKey = readonly unknown[]`), and it must be
**JSON-serializable** — the library hashes it with `JSON.stringify` to identify
the cache entry.

The rule of thumb: **the key must uniquely and completely describe the data it
points to.**

## Simple keys

For a resource with no parameters, a single constant is enough:

```ts
// A list of todos
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
}))
```

Two components using `['todos']` get **one** cache entry and **one** in-flight
request — deduplication happens automatically, no coordination needed.

## Keys with variables

Whenever the data depends on something, put that something in the key:

```ts
// A single todo
queryKey: ['todo', 5]

// A filtered list
queryKey: ['todos', { type: 'done' }]

// Paginated data
queryKey: ['todos', { page: 2, perPage: 20 }]
```

Each distinct key is a distinct cache entry. `['todo', 5]` and `['todo', 6]`
never overwrite each other.

## Hashing is deterministic

Keys are hashed with `JSON.stringify`, but **object keys are sorted first**.
That means the property order inside an object doesn't matter — these are the
**same** key:

```ts
queryKey: ['todos', { status: 'done', page: 2 }]
queryKey: ['todos', { page: 2, status: 'done' }] // identical
```

But the **order of array items does matter**. These are three **different**
keys:

```ts
queryKey: ['todos', status, page]
queryKey: ['todos', page, status] // different!
queryKey: [status, page, 'todos'] // different again!
```

> **Keep keys serializable.** Because hashing goes through `JSON.stringify`,
> anything it can't represent has no business being in a key — functions, class
> instances, `Symbol`s. Stick to strings, numbers, booleans, plain objects and
> arrays.

## Keys are reactive

This is where signals pay off. Build a key from a signal and the query
**follows it automatically** — no manual refetch, no subscription:

```ts
@Component({ /* … */ })
export class TodoComponent {
  readonly #http = inject(HttpClient)

  readonly todoId = signal(1)

  protected readonly todo = injectQuery(() => ({
    queryKey: ['todo', this.todoId()],
    queryFn: () => this.#http.get<Todo>(`/api/todos/${this.todoId()}`),
  }))
}
```

Calling `todoId.set(2)` switches the query to the key `['todo', 2]`: it starts
observing the new entry, fetching it if needed. The data for `['todo', 1]`
**stays in the cache** — flip back and it's there instantly, no refetch.

This leads to the single most important rule on this page:

> **Every variable your `queryFn` reads must appear in the `queryKey`.**

If `queryFn` uses `todoId` but the key is just `['todo']`, all ids collapse
into one cache entry: you'd get stale data from a previous id and no refetch on
change. The key *is* the dependency list.

## Keys are hierarchical

Keys aren't just opaque identifiers — a shorter key **matches** the longer keys
that start with it. `['todos']` matches `['todos', 1]` and
`['todos', { type: 'done' }]`.

This is what makes bulk operations possible:

```ts
const client = injectQueryClient()

// Invalidates ['todos'], ['todos', 1], ['todos', { type: 'done' }] — the lot
client.invalidateQueries({ queryKey: ['todos'] })

// Invalidates ONLY the exact key
client.invalidateQueries({ queryKey: ['todos'], exact: true })
```

The same partial matching drives `cancelQueries`, `removeQueries` and the
filters accepted by `injectIsFetching`.

## Structuring keys

Because matching works by prefix, order your keys from **generic to specific**
— it gives you a hierarchy you can invalidate at any level:

```ts
queryKey: ['todos']                              // everything about todos
queryKey: ['todos', 'list', { type: 'done' }]    // one filtered list
queryKey: ['todos', 'detail', 5]                 // one item
```

Now `invalidateQueries({ queryKey: ['todos'] })` refreshes everything,
`['todos', 'list']` refreshes just the lists, and `['todos', 'detail', 5]` just
that one item.

Finally: **keep keys next to the queries that use them.** Building them inline
in components invites typos and drift — a stray `['todo']` where you meant
`['todos']` is a silent cache miss. Colocate them in a service using
`queryOptions`:

```ts
@Injectable({ providedIn: 'root' })
export class TodoQueries {
  readonly #http = inject(HttpClient)

  public list(filters: TodoFilters) {
    return queryOptions({
      queryKey: ['todos', 'list', filters],
      queryFn: () => this.#http.get<Todo[]>('/api/todos', { params: filters }),
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
