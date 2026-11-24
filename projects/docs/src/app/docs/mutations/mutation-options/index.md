`mutationOptions()` is to mutations what [`queryOptions()`](/queries/query-options) is to queries: an **identity function** that returns its argument untouched at runtime, and exists purely to anchor type inference. It lets you define a mutation once, in a service, and reuse it.

```ts
import { inject, Injectable } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { injectQueryClient, mutationOptions } from 'ngx-signal-query'

@Injectable({ providedIn: 'root' })
export class TodoMutations {
  readonly #http = inject(HttpClient)
  readonly #client = injectQueryClient()

  public add() {
    return mutationOptions({
      mutationFn: (title: string) =>
        this.#http.post<Todo>('/api/todos', { title }),
      onSuccess: () => this.#client.invalidateQueries({ queryKey: ['todos'] }),
    })
  }
}
```

The component just wires it up:

```ts
export class AddTodoComponent {
  readonly #mutations = inject(TodoMutations)

  protected readonly addTodo = injectMutation(() => this.#mutations.add())
}
```

## Why it earns its keep

For queries, the win from `queryOptions` is mostly not repeating the key. A mutation's key is optional — so what does `mutationOptions` actually buy you?

**It gives a mutation defined outside `injectMutation` its types.** Inline, `injectMutation(() => ({ … }))` types the hooks for you: the variables, the data, and the `context` argument of `onSuccess` / `onError` / `onSettled`, which is the value `onMutate` returns. An object a service method returns has nothing to take its types from, so its hooks' parameters are implicitly `any`, an error under `strict`. `mutationOptions` types it as `injectMutation` would, so an optimistic rollback type-checks end to end:

```ts
public add() {
  return mutationOptions({
    mutationFn: (title: string) =>
      this.#http.post<Todo>('/api/todos', { title }),

    // onMutate returns { previous } …
    onMutate: (title) => {
      const previous = this.#client.getQueryData<Todo[]>(['todos'])

      this.#client.setQueryData<Todo[]>(
        ['todos'],
        (todos) => todos && [...todos, { id: -1, title }],
      )

      return { previous }
    },

    // … and `context` here is typed as
    // { previous: Todo[] | undefined } | undefined, not `unknown`.
    onError: (_error, _title, context) => {
      this.#client.setQueryData<Todo[]>(['todos'], context?.previous)
    },
  })
}
```

Get `context?.previous` wrong — a typo, the wrong shape — and it's a compile error, not a broken rollback at runtime.

Inline or not, **write `onMutate` above the hooks that take `context`**. TypeScript infers `context` in the order the object is written: with `onError: (error, title, context) => …` above `onMutate: (title) => …`, it's `unknown` in every hook.

## Overriding per component

The returned object is plain, so a component can spread it and change an option. A spread **replaces** what it overrides, hooks included: an `onSuccess` written after `...this.#mutations.add()` runs instead of the definition's, and the list is no longer invalidated. For the component's own reaction to a write, pass callbacks to `mutate()` instead. They run after the definition's hooks, which stay as they are:

```ts
protected readonly addTodo = injectMutation(() => this.#mutations.add())

protected add(title: string): void {
  this.addTodo.mutate(title, {
    onSuccess: () => this.toast('Added!'), // this component wants a toast too
  })
}
```

See [Callbacks for one call](/mutations/overview#callbacks-for-one-call).

## Testing

Same payoff as `queryOptions`: a mutation definition is a plain object. A test gets the service from `TestBed` and calls its hooks, with no component and nothing rendered (see [Testing](/testing)):

```ts
it('invalidates todos on success', () => {
  const options = mutations.add()

  options.onSuccess?.(todo, 'Buy milk', undefined)

  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['todos'] })
})
```

## Naming a mutation: `mutationKey`

A definition can name its mutation with a `mutationKey`, an array like a query key, from broad to specific. It's optional: a mutation runs the same without one. Give it one to tell its writes apart from the others: for a "Saving…" that counts only some of them (see [Global Indicators](/query-client/global-indicators#scoping-it-with-a-key)), for a list of the ones in flight in another component (see [`injectMutationState`](/query-client/global-indicators#injectmutationstate)), or for the [global callbacks](/query-client/global-callbacks), which get it as `mutation.mutationKey`.

```ts
updateTodo() {
  return mutationOptions({
    mutationKey: ['todos', 'update'],
    mutationFn: (todo: Todo) =>
      this.#http.put<Todo>(`/api/todos/${todo.id}`, todo),
  })
}
```

The definition gives the key back typed, ready for a filter:

```ts
protected readonly saving = injectIsMutating(() => ({
  mutationKey: this.#todos.updateTodo().mutationKey,
}))
```

A definition without a key has no `mutationKey` to read, so it can't end up in a filter, where a key that's `undefined` would match every mutation. For the same reason, a definition's key can't be `undefined`: one that may be missing, such as `id ? ['todos', id] : undefined`, goes in the options you pass to `injectMutation()` instead.

Each run keeps the key that the options give when `mutate()` is called, so the key can use what the component has by then, such as an input. When it changes, the mutation resets: see [When the key changes](/mutations/overview#when-the-key-changes).
