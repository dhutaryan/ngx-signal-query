Queries **read** server state. Mutations **change** it — create, update, delete.

The difference isn't cosmetic. A query runs on its own, whenever the cache says
it should. A mutation runs only when **you** say so, exactly once per call, and
it isn't cached — you don't want a `POST` firing again because something looked
stale.

## The basics

```ts
import { Component, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { injectMutation } from 'ngx-signal-query'

@Component({
  selector: 'app-add-todo',
  template: `…`,
})
export class AddTodoComponent {
  readonly #http = inject(HttpClient)

  protected readonly addTodo = injectMutation(() => ({
    mutationFn: (title: string) =>
      this.#http.post<Todo>('/api/todos', { title }),
  }))

  protected add(title: string): void {
    this.addTodo.mutate(title)
  }
}
```

`mutationFn` takes whatever you pass to `mutate()` and returns an `Observable`
or a `Promise`, same as a `queryFn`. There's no key: a mutation isn't stored in
the cache.

## Mutation states

A mutation has **four** states — one more than a query, because it starts out
having done nothing at all:

| `status()` | meaning |
| --- | --- |
| `'idle'` | not run yet (or `reset()` was called) |
| `'pending'` | running right now |
| `'success'` | the last run succeeded; `data()` holds the result |
| `'error'` | the last run failed; `error()` holds the failure |

The matching booleans are `isIdle()`, `isPending()`, `isSuccess()` and
`isError()`.

That `'idle'` state is the important difference from queries. A query with no
data is `'pending'` — it *will* fetch. A mutation with no data is `'idle'` —
it's waiting for you.

{% raw %}

```html
<button (click)="add('Buy milk')" [disabled]="addTodo.isPending()">
  {{ addTodo.isPending() ? 'Saving…' : 'Add todo' }}
</button>

@if (addTodo.isError()) {
  <p class="error">Couldn't save: {{ addTodo.error()?.message }}</p>
}

@if (addTodo.isSuccess()) {
  <p class="ok">Added "{{ addTodo.data()?.title }}"</p>
}
```

{% endraw %}

`variables()` gives you what was passed to the most recent `mutate()` — handy
for showing *which* item is being saved.

## Resetting

The result of a mutation sticks around after it finishes. `reset()` puts it
back to `'idle'`, clearing `data()` and `error()`:

{% raw %}

```html
@if (addTodo.isError()) {
  <p class="error">{{ addTodo.error()?.message }}</p>
  <button (click)="addTodo.reset()">Dismiss</button>
}
```

{% endraw %}

Useful for clearing an error banner, or resetting a form after a successful
save.

## Side effects

This is where mutations earn their keep. Four hooks fire in a fixed order:

```
onMutate  →  mutationFn  →  onSuccess | onError  →  onSettled
```

- **`onMutate(variables)`** — runs *before* the request. Whatever it returns
  becomes the **context** passed to the later hooks. This is how optimistic
  updates and rollbacks work.
- **`onSuccess(data, variables, context)`** — the request succeeded.
- **`onError(error, variables, context)`** — it failed.
- **`onSettled(data, error, variables, context)`** — runs either way, for
  cleanup.

The most common use is telling queries that their data is now out of date:

```ts
export class AddTodoComponent {
  readonly #http = inject(HttpClient)
  readonly #client = injectQueryClient()

  protected readonly addTodo = injectMutation(() => ({
    mutationFn: (title: string) =>
      this.#http.post<Todo>('/api/todos', { title }),
    onSuccess: () => {
      // The list is stale now — refetch it.
      this.#client.invalidateQueries({ queryKey: ['todos'] })
    },
  }))
}
```

The `context` returned by `onMutate` is what makes rollbacks possible — snapshot
the old data, restore it if the request fails. That's covered in Optimistic
Updates.

## Mutations don't retry

Queries retry three times by default. Mutations **don't retry at all**, and
that's deliberate: a write isn't necessarily idempotent, and quietly re-sending
a `POST` can create the same record twice.

Opt in only when you know the operation is safe to repeat:

```ts
injectMutation(() => ({
  mutationFn: (id: number) => this.#http.delete(`/api/todos/${id}`), // idempotent
  retry: 2,
}))
```

## Things to know

A few sharp edges, especially if you're arriving from TanStack Query.

**`mutate()` returns nothing.** There's no `mutateAsync`, so you can't `await` a
mutation or wrap it in `try`/`catch`. Reach for the hooks and the state signals
instead — the result of the mutation is `data()` / `error()`, not a return
value.

**No per-call callbacks.** `mutate(variables)` takes only the variables;
you can't pass `{ onSuccess }` alongside them. All side effects live in the
options, next to `mutationFn`.

**Hooks are synchronous.** Returning a promise from `onSuccess` won't delay
`onSettled` — the return value is ignored. If you need something to happen after
an async step, do the awaiting inside the hook itself.

**Calls aren't serialized.** Each `mutate()` is its own independent run, so two
of them can be in flight at once and there's no `scope` option to queue them.
The signals always track the **latest** call — an earlier run landing later
won't hijack `data()` — but both writes do reach the server, and both fire their
hooks. If the operation isn't safe to run twice, guard the trigger:

```html
<button (click)="add(title())" [disabled]="addTodo.isPending()">Add</button>
```

**Destroying the component doesn't cancel the write.** A mutation that's already
in flight runs to completion, and its `onSuccess` / `onError` / `onSettled` still
fire. That's deliberate: the request has most likely reached the server already,
so aborting it would only skip the cache update and leave the UI showing stale
data for a write that actually happened.
