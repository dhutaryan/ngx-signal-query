Most of the time you can wait for a mutation to finish, then refetch. But for
something that almost always succeeds — liking a post, adding a todo — waiting
for the round trip feels sluggish. An **optimistic update** shows the result
immediately, assuming success, and quietly reconciles (or rolls back) when the
server answers.

There are two ways to do it, and they trade off simplicity against reach.

## Approach 1: from the mutation's `variables`

The simplest option touches nothing — no cache writes, no rollback. While the
mutation is pending, you render its input directly, using `variables()` and
`isPending()`:

```ts
export class TodosComponent {
  readonly #http = inject(HttpClient)
  readonly #client = injectQueryClient()
  readonly #queries = inject(TodoQueries)

  protected readonly todos = injectQuery(() => this.#queries.list())

  protected readonly addTodo = injectMutation(() => ({
    mutationFn: (title: string) =>
      this.#http.post<Todo>('/api/todos', { title }),
    // Pull the real list once the write settles, either way.
    onSettled: () => this.#client.invalidateQueries({ queryKey: ['todos'] }),
  }))
}
```

{% raw %}

```html
<ul>
  @for (todo of todos.data() ?? []; track todo.id) {
    <li>{{ todo.title }}</li>
  }

  <!-- The pending todo, shown optimistically. -->
  @if (addTodo.isPending()) {
    <li style="opacity: 0.5">{{ addTodo.variables() }}</li>
  }
</ul>

@if (addTodo.isError()) {
  <p class="error">
    Couldn't add “{{ addTodo.variables() }}”.
    <button (click)="addTodo.mutate(addTodo.variables()!)">Retry</button>
  </p>
}
```

{% endraw %}

The dimmed row appears the instant you submit, and when the refetch lands the
real todo takes its place — no flicker, because the row was there the whole
time. On error there's nothing to undo: the optimistic row simply isn't in the
cache to begin with.

This is the approach to reach for first. It's less code and easier to reason
about — **when the optimistic result only needs to show in one place.** Because
it reads the mutation's own `variables()`, it's local to the component that owns
the mutation.

## Approach 2: writing to the cache

When the change needs to be reflected **everywhere** that reads the data — the
list, a counter, a detail view — update the cache itself in `onMutate`, and keep
a snapshot so you can roll back on failure.

```ts
protected readonly addTodo = injectMutation(() => ({
  mutationFn: (title: string) => this.#http.post<Todo>('/api/todos', { title }),

  onMutate: (title) => {
    // Stop any in-flight refetch from landing on top of our optimistic write.
    this.#client.cancelQueries({ queryKey: ['todos'] })

    // Snapshot for rollback…
    const previous = this.#client.getQueryData<Todo[]>(['todos']) ?? []

    // …then write the optimistic todo. A temporary negative id keeps it
    // distinct until the server assigns a real one.
    this.#client.setQueryData<Todo[]>(['todos'], (todos = []) => [
      ...todos,
      { id: -Date.now(), title },
    ])

    return { previous }
  },

  onError: (_error, _title, context) => {
    // Put the snapshot back.
    if (context) {
      this.#client.setQueryData<Todo[]>(['todos'], context.previous)
    }
  },

  onSettled: () => {
    // Reconcile with the server — swaps the temp row for the real one.
    this.#client.invalidateQueries({ queryKey: ['todos'] })
  },
}))
```

Every query reading `['todos']` shows the new row at once, and any of them
reverts if the write fails. The three hooks split the work cleanly:

- **`onMutate`** — cancel, snapshot, write. Its return value becomes the
  `context` the other hooks receive.
- **`onError`** — restore the snapshot from `context`.
- **`onSettled`** — invalidate, so the optimistic guess is replaced by real
  server data whether it succeeded or failed.

### Why `cancelQueries` first

If a background refetch for `['todos']` is already in flight, it will resolve
*after* your optimistic write and overwrite it with the old list — the new row
would flash in, then vanish until the mutation completes.
`cancelQueries({ queryKey: ['todos'] })` stops that in-flight fetch so your
optimistic data is the last word until `onSettled` refetches deliberately. It's
synchronous here — no `await` needed.

### Updating a single item

The same shape works for editing one entry — snapshot it, overwrite it, restore
on error:

```ts
onMutate: (updated) => {
  this.#client.cancelQueries({ queryKey: ['todos', 'detail', updated.id] })

  const previous = this.#client.getQueryData<Todo>([
    'todos',
    'detail',
    updated.id,
  ])

  this.#client.setQueryData<Todo>(['todos', 'detail', updated.id], updated)

  return { previous, id: updated.id }
},

onError: (_error, _updated, context) => {
  if (context) {
    this.#client.setQueryData(['todos', 'detail', context.id], context.previous)
  }
},
```

## Which to use

| | `variables` | cache |
| --- | --- | --- |
| code | minimal | more |
| rollback | none needed | manual snapshot |
| shows up in | one component | everywhere the key is read |

Start with **`variables`**. Move to the **cache** approach only when the same
change has to appear in more than one place at once, or when the rollback needs
to be exact.

> **Note for TanStack Query users.** There's no `injectMutationState` and no
> `mutationKey` here, so the `variables` approach can't be read from a *different*
> component the way it can in TanStack. If the optimistic result must be seen
> outside the mutation's own component, use the cache approach — it's global by
> nature.
