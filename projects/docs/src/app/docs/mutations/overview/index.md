Queries **read** server state. Mutations **change** it — create, update, delete.

The difference isn't cosmetic. A query runs on its own, whenever the cache says it should. A mutation runs only when **you** say so, exactly once per call, and it isn't cached — you don't want a `POST` firing again because something looked stale.

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

`mutationFn` takes whatever you pass to `mutate()` and returns an `Observable` or a `Promise`, same as a `queryFn`. A mutation needs no key: nothing looks its result up by key, the way components look up a query's data. Give it a [`mutationKey`](/mutations/mutation-options#naming-a-mutation-mutationkey) only to tell its writes apart from others, such as for a "Saving…" that counts one kind, or to list the ones in flight in another component.

## Mutation states

A mutation has **four** states — one more than a query, because it starts out having done nothing at all:

| `status()` | meaning |
| --- | --- |
| `'idle'` | not run yet (or `reset()` was called, or [its key changed](#when-the-key-changes)) |
| `'pending'` | running right now |
| `'success'` | the last run succeeded; `data()` holds the result |
| `'error'` | the last run failed; `error()` holds the failure |

The matching booleans are `isIdle()`, `isPending()`, `isSuccess()` and `isError()`.

That `'idle'` state is the important difference from queries. A query with no data is `'pending'` — it _will_ fetch. A mutation with no data is `'idle'` — it's waiting for you.

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

`variables()` gives you what was passed to the most recent `mutate()` — handy for showing _which_ item is being saved.

## Resetting

The result of a mutation sticks around after it finishes. `reset()` puts it back to `'idle'`, clearing `data()` and `error()`:

{% raw %}

```html
@if (addTodo.isError()) {
  <p class="error">{{ addTodo.error()?.message }}</p>
  <button (click)="addTodo.reset()">Dismiss</button>
}
```

{% endraw %}

Useful for clearing an error banner, or resetting a form after a successful save.

`reset()` means _"forget the result"_, not _"stop the request"_. If a mutation is still in flight when you call it, the signals go back to `'idle'` but the write itself carries on, and its hooks and the [call's callbacks](#callbacks-for-one-call) still fire. That's deliberate — the request has probably reached the server already, and aborting it wouldn't un-send the write, it would only stop the cache from finding out that it happened.

### When the key changes

A mutation with a [`mutationKey`](/mutations/mutation-options#naming-a-mutation-mutationkey) that reads an input resets itself when that key changes. Say the router keeps a todo's page as the user moves on to the next todo:

```ts
export class TodoPage {
  readonly #http = inject(HttpClient)
  readonly id = input.required<number>()

  protected readonly save = injectMutation(() => ({
    mutationKey: ['todos', 'update', this.id()],
    mutationFn: (todo: Todo) =>
      this.#http.put<Todo>(`/api/todos/${todo.id}`, todo),
  }))
}
```

Once `id` changes, `save` reads as `'idle'`, the way it does after `reset()`: the page never sees how saving the previous todo went, in its template or in its effects. A save still in flight carries on and fires its hooks, and `injectIsMutating()` counts it under the key it was started with. The [callbacks passed to its `mutate()`](#callbacks-for-one-call) don't run, though: by the time it's done, the page shows another todo. The same goes for a mutation that a service holds, with a signal in its key, such as a store whose id the page sets from its input.

An equal key, though made anew, changes nothing, and neither do options that give no key for a while, such as while the next todo loads. A mutation without a key keeps showing its last run until the next `mutate()` or `reset()`.

## Side effects

This is where mutations earn their keep. Four hooks fire in a fixed order:

```
onMutate  →  mutationFn  →  onSuccess | onError  →  onSettled
```

- **`onMutate(variables)`** — runs _before_ the request. Whatever it returns becomes the **context** passed to the later hooks. This is how optimistic updates and rollbacks work. If it returns a promise, the request waits for it, and the context is what it resolves to.
- **`onSuccess(data, variables, context)`** — the request succeeded.
- **`onError(error, variables, context)`** — it failed.
- **`onSettled(data, error, variables, context)`** — runs either way, for cleanup.

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

This hook starts the refetch and returns nothing, so the mutation finishes as the write lands. Return the promise `invalidateQueries` gives instead, and the mutation stays `'pending'` until the list is fresh; see [Invalidation from Mutations](/mutations/invalidation-from-mutations#waiting-for-the-fresh-data).

The `context` returned by `onMutate` is what makes rollbacks possible — snapshot the old data, restore it if the request fails. That's covered in Optimistic Updates.

A hook every mutation needs, such as reporting failed writes, doesn't have to be repeated on each one: a [global callback](/query-client/global-callbacks) runs for every mutation, before its own hooks, and a [default hook](/query-client/default-options) for each mutation that has no hook of its own.

## Callbacks for one call

`mutate()` and `mutateAsync()` take a second argument: an `onSuccess`, `onError` and `onSettled` for that call alone, each getting what the hook of the same name gets. That's where the component's own reaction to the write goes, such as closing a dialog:

```ts
export class AddTodoDialog {
  readonly #http = inject(HttpClient)
  readonly #client = injectQueryClient()
  readonly #dialog = inject(DialogRef)

  protected readonly addTodo = injectMutation(() => ({
    mutationFn: (title: string) =>
      this.#http.post<Todo>('/api/todos', { title }),
    // What the cache needs, whatever the dialog does.
    onSuccess: () => this.#client.invalidateQueries({ queryKey: ['todos'] }),
  }))

  protected add(title: string): void {
    this.addTodo.mutate(title, {
      // What the dialog does about this write.
      onSuccess: () => this.#dialog.close(),
    })
  }
}
```

So each side effect has its place:

- **In the options**, next to `mutationFn`: what the cache needs whatever the UI does, such as invalidating queries, or an optimistic update and its rollback. These hooks run for every call, even once the component is gone.
- **In the call**: what the component does about that write, such as closing a dialog, showing a message or navigating. These callbacks run once the run is done: after the mutation's own hooks and the [global callbacks](/query-client/global-callbacks), with the outcome already in the signals.

They come with a few rules:

- **Every call gets its own.** Two calls in flight each get their callbacks, with their own outcome, though the signals show only the latest call. `reset()` and the client's `clear()` don't drop them either: the write happened.
- **They belong to the component that created the mutation.** If it's destroyed before the run is done, its hooks included, the callbacks don't run, while the hooks still do. That's the component where `injectMutation()` ran, not the one that called `mutate()`: for a mutation that a service holds, they run as long as the service is there. To have them stop with a dialog, create the mutation in the dialog, from the service's [definition](/mutations/mutation-options).
- **And to the key the call was made under.** With a `mutationKey`, they don't run if, by the time the run is done, the options give another key: the component shows [another item](#when-the-key-changes) by then, and marking a form saved or navigating away would act on the wrong one. The hooks still run.
- **Nothing waits for them.** By the time they're called, the mutation is no longer pending, and `mutateAsync()` settles right after them. A promise one returns isn't waited for.
- **A failing one changes nothing else.** What one throws, or what a promise it returns rejects with, goes to the app's `ErrorHandler`, as with a failing hook. The outcome and the other callbacks stay as they are.

A mutation without variables takes `undefined` in their place: `refresh.mutate(undefined, { onSuccess })`. To start one per item, wrap `mutate` in an arrow, `ids.forEach((id) => removeTodo.mutate(id))`: passed as it is, it would get the index as its second argument.

## Awaiting a mutation: `mutateAsync`

`mutate()` returns nothing: the outcome shows in the signals, the hooks and the call's callbacks. When code has to wait for it, for several writes at once say, call `mutateAsync()` instead. It runs the mutation the same way, and returns a promise that resolves with the data once the last hook is done, or rejects with the error:

```ts
protected async removeSelected(ids: number[]): Promise<void> {
  const results = await Promise.allSettled(
    ids.map((id) => this.removeTodo.mutateAsync(id)),
  )
  const failed = results.filter((result) => result.status === 'rejected')

  if (failed.length > 0) this.#toast.show(`${failed.length} not removed`)
}
```

Catch what it rejects with, or wait with `Promise.allSettled()` as above. As with any `async` call, a rejection nobody handles surfaces as an unhandled rejection. `mutate()` doesn't throw when the write fails, which is why it's the one to call when nothing waits for the outcome. `mutate()` and `mutateAsync()` both throw at once if the options function itself throws: nothing is sent, and the signals keep showing the run before.

The promise settles once the run is done, even if the component is gone by then, and the code after `await` runs either way. For a reaction that should stop with the component, such as closing a dialog, pass [callbacks for the call](#callbacks-for-one-call) instead.

## Mutations don't retry

Queries retry three times [by default](/important-defaults). Mutations **don't retry at all**, and that's deliberate: a write isn't necessarily idempotent, and quietly re-sending a `POST` can create the same record twice.

Opt in only when you know the operation is safe to repeat:

```ts
injectMutation(() => ({
  mutationFn: (id: number) => this.#http.delete(`/api/todos/${id}`), // idempotent
  retry: 2,
}))
```

To turn retries on for every mutation, set `mutations: { retry }` in [Default Options](/query-client/default-options), but only if every write in your app is safe to repeat.

## Things to know

A few sharp edges, especially if you're arriving from TanStack Query.

**Every call keeps its callbacks.** The callbacks passed to `mutate()` run for each call, also for one that a later call or `reset()` came after. TanStack Query runs only the latest call's, so a loop that passes `onSuccess` to each call gets it once per call here, not once in all.

**Hooks can be async.** A hook that returns a promise holds up the next one: `onSettled` waits for an async `onSuccess`, and the mutation stays `'pending'` — and counted by `injectIsMutating` — until its last hook is done. Return a promise, not an Observable: an Observable a hook returns isn't subscribed, so `onSuccess: () => this.#http.post(…)` sends nothing. Wrap it in `firstValueFrom()`. The callbacks passed to `mutate()` hold nothing up: nothing waits for a promise they return.

**A failing hook doesn't undo the write.** If `onSuccess` throws, the mutation still ends in `'success'`, because the write went through, `onSettled` still runs, and `mutateAsync()` resolves with the data; the same goes for `onError` and `onSettled`. The error isn't swallowed: it goes to your app's `ErrorHandler`, once, with zone.js or without, in the browser and during a server render, which still finishes. Only `onMutate` is different: if it fails, the request isn't sent and the mutation ends in `'error'`. (In TanStack Query, a failing `onSuccess` turns the mutation into an error.)

**Calls aren't serialized.** Each `mutate()` is its own independent run, so two of them can be in flight at once and there's no `scope` option to queue them. The signals always track the **latest** run — an earlier one landing later won't hijack `data()` — but both writes do reach the server, and both fire their hooks and their callbacks. If the operation isn't safe to run twice, guard the trigger:

```html
<button (click)="add(title())" [disabled]="addTodo.isPending()">Add</button>
```

**Destroying the component doesn't cancel the write.** A mutation that's already in flight runs to completion, and its `onSuccess` / `onError` / `onSettled` still fire. That's deliberate: the request has most likely reached the server already, so aborting it would only skip the cache update and leave the UI showing stale data for a write that actually happened. Emptying the cache with the client's [`clear()`](/query-client/cancellation-and-removal#clear--empty-the-cache) doesn't stop it either: the mutation is forgotten, but it lands and its hooks fire. A `mutate()` that comes after the component is gone, say from a timer or the next step of a promise chain, runs too: the write is sent and its hooks fire. The callbacks passed to `mutate()` are the exception: they belong to the component, so they don't run once it's gone.
