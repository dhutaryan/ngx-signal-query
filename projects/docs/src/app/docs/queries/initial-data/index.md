Sometimes you already have the data before the query runs — it came from the
server render, from a parent list, from `localStorage`. `initialData` lets you
seed the cache with it so the query renders as `'success'` straight away, with
no loading state.

## The basics

```ts
protected readonly todos = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  initialData: [{ id: 1, title: 'Buy milk' }],
}))
```

The query never shows `'pending'`. `data()` is populated from the first render,
`status()` is `'success'`.

Crucially, **`initialData` is written into the cache**. It's not a temporary
placeholder — it becomes the real cached value for that key, and other
components reading the same key will see it.

## A value or a function

If computing the data is expensive, pass a function. It's only called when the
query actually needs seeding — a query that already has data in the cache won't
call it at all:

```ts
initialData: () => JSON.parse(localStorage.getItem('todos') ?? '[]')
```

## It refetches immediately (by default)

This surprises people. Seed a query and it *still* fires a request straight
away.

There's no trick to it: the seed is treated as data fetched **right now**, and
the default `staleTime` is `0` — meaning "stale immediately". So a background
refetch kicks off at once, while the seeded data is on screen.

That's usually what you want: show something instantly, quietly replace it with
fresh data.

To stop it, say how long the seed stays good with `staleTime`:

```ts
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  initialData: todosFromServerRender,
  staleTime: 60_000, // fresh for a minute — no refetch
}))
```

## When the seed isn't new

`staleTime` alone assumes the seed is fresh as of now. Often it isn't — it came
from a server render a few seconds ago, or from `localStorage` last week. Say so
with `initialDataUpdatedAt`:

```ts
initialData: todosFromLocalStorage,
initialDataUpdatedAt: Number(localStorage.getItem('todos:at')),
staleTime: 60_000,
```

Now the query does the arithmetic properly: if that timestamp is older than a
minute, it refetches; if not, it doesn't.

The two options are a pair — `initialDataUpdatedAt` says *when* the data is
from, `staleTime` says *how long* that stays good.

## Seeding from another query

The classic case: you have a list, the user clicks a row, and the detail page
starts from scratch — even though you already have most of that todo.

Pull it out of the cache instead:

```ts
export class TodoDetailComponent {
  readonly #http = inject(HttpClient)
  readonly #client = injectQueryClient()

  readonly todoId = input.required<number>()

  protected readonly todo = injectQuery(() => ({
    queryKey: ['todos', 'detail', this.todoId()],
    queryFn: () => this.#http.get<Todo>(`/api/todos/${this.todoId()}`),
    initialData: () =>
      this.#client
        .getQueryData<Todo[]>(['todos', 'list'])
        ?.find((todo) => todo.id === this.todoId()),
  }))
}
```

The detail view renders instantly from the list's data, then refetches in the
background to fill in whatever the list row didn't have.

This works with a reactive key too: the seed function runs again for each new
id, so navigating between todos keeps seeding from the list.

## Seeding with the right timestamp

The version above treats the seed as brand new, which isn't true — that row is
as old as the list it came from. If you add a `staleTime`, the detail query
would trust the seed for the full duration, even if the list was fetched an hour
ago.

You *know* how old the data is. Use it:

```ts
initialData: () =>
  this.#client
    .getQueryData<Todo[]>(['todos', 'list'])
    ?.find((todo) => todo.id === this.todoId()),

initialDataUpdatedAt: () =>
  this.#client.getQueryCache().get(['todos', 'list'])?.state().updatedAt ?? 0,
```

Now the detail query only refetches if the list data was itself stale. If the
list was fetched two seconds ago and `staleTime` is a minute, no request is
made at all.

> There's no `getQueryState()` shorthand yet, so reading another query's
> `updatedAt` means going through the cache:
> `client.getQueryCache().get(key)?.state().updatedAt`.

## Only seed if the source is fresh enough

Sometimes stale is worse than empty — you'd rather show a spinner than a price
from an hour ago. Check the age before deciding:

```ts
initialData: () => {
  const list = this.#client.getQueryCache().get(['todos', 'list'])
  const updatedAt = list?.state().updatedAt ?? 0

  // Older than 10 seconds? Don't seed — fetch properly instead.
  if (Date.now() - updatedAt > 10_000) return undefined

  return this.#client
    .getQueryData<Todo[]>(['todos', 'list'])
    ?.find((todo) => todo.id === this.todoId())
}
```

Returning `undefined` means "no initial data" — the query starts `'pending'` as
normal.

## Don't use it for partial data

Worth repeating, because it's the one real trap here: **`initialData` goes into
the cache.**

So it must be *real* data — complete, and correct for that key. If you seed a
detail query with a half-populated row from a list, that half-populated object
is now the cached value for that key. Anything else reading it gets the partial
version, and a mutation writing to that key merges into it.

For "show this while we load the real thing" there's a separate mechanism —
[`placeholderData`](../placeholder-data), which shows data **without** writing it
to the cache:

- Data you'd be happy to keep? `initialData`.
- Data that's just a stand-in? `placeholderData`.
