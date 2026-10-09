Every response is a new object: JSON parsing makes one each time, even when the
server sends exactly what it sent before. So a query compares each response
with the data it already holds and keeps everything that didn't change. When
nothing did, `data()` keeps its reference, and nothing that reads it runs
again: no `computed` recomputes, no `effect` re-runs, no template updates.

It's on by default, there's nothing to set up.

## Why it matters

Say an effect fills a form field from the query's data, and the query polls:

```ts
export class TodoEditorComponent {
  readonly #http = inject(HttpClient)

  readonly id = input.required<number>()

  protected readonly todo = injectQuery(() => ({
    queryKey: ['todo', this.id()],
    queryFn: () => this.#http.get<Todo>(`/api/todos/${this.id()}`),
    refetchInterval: 10_000,
  }))

  protected readonly title = signal('')

  constructor() {
    // Fills the field whenever the todo changes.
    effect(() => {
      const todo = this.todo.data()

      if (todo) this.title.set(todo.title)
    })
  }
}
```

The user starts typing a new title, and a poll brings the same todo. As a new
object, it would run the effect again and reset the field while the user
types. As it is, `data()` doesn't change, so the effect runs only when the todo
really changes on the server.

When only part of the data changes, the rest keeps its references. Refetch a
list where one row changed, and every other row is the same object as before:

<!-- prettier-ignore -->
```html
@for (todo of todos.data(); track todo.id) {
  <app-todo-row [todo]="todo" />
}
```

Only the row that changed is a new object, so only its `<app-todo-row>` gets a
new input.

## What it compares

Plain objects and arrays, the kind JSON parsing makes, value by value. Anything
else counts as changed on every response: a `Date`, a `Map`, an instance of a
class, say a `queryFn` that turns each row into `new Todo(...)`. What's around
such a value is still shared: a row with a `Date` field is a new object every
time, but the arrays and objects inside it that didn't change keep their
references.

## Turning it off, or merging your own way

Comparing walks through the whole response, which takes longer than parsing
it. Most responses are too small for that to matter. For a large one refetched
often, turn it off:

```ts
injectQuery(() => ({
  queryKey: ['prices'],
  queryFn: () => this.#http.get<Price[]>('/api/prices'),
  refetchInterval: 1_000,
  structuralSharing: false, // every response is stored as is
}))
```

To turn it off for every query, set it in
[`withDefaultOptions`](/query-client/default-options).

You can also pass a function that merges the data your own way. Say your
responses carry dates, and you have a deep comparison that understands them:

```ts
structuralSharing: (oldData, newData) =>
  oldData !== undefined && isDeepEqual(oldData, newData) ? oldData : newData,
```

It gets the data the query holds, `undefined` before the first response, and
the new data, and returns what to store. It runs for every response and for
every `setQueryData` write to the key, but not for `initialData`. So it has to
merge, not pick: a function that returns `oldData` whenever, say, a `version`
field matches also throws away an optimistic update that leaves the version as
it was. If it throws, the fetch fails with its error and the query keeps its
data, and `setQueryData` throws to its caller.

## setQueryData

[`setQueryData`](/query-client/manual-cache-updates) merges what it writes the
same way. Writing what the cache already holds, say a save whose response
repeats the cached todo, changes nothing, and nothing re-runs. A write that
changes part of the data keeps the rest, so what lands in the cache can be a
new object built from the one you passed, not that object itself.

It has no options of its own. It merges as the component showing the key asks,
enabled or not. With none showing it, it merges the way the data in the cache
was fetched, and a key nothing has fetched yet gets the app-wide default.

> This works like structural sharing in TanStack Query: on by default and
> comparing the same way. Here the function's parameters are typed from
> `queryFn`.
