`mutationOptions()` is to mutations what
[`queryOptions()`](/queries/query-options) is to queries: an **identity
function** that returns its argument untouched at runtime, and exists purely to
anchor type inference. It lets you define a mutation once, in a service, and
reuse it.

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

For queries, the win from `queryOptions` is mostly not repeating the key. For
mutations there's no key — so what does `mutationOptions` actually buy you?

**It links the hooks' types together.** The value `onMutate` returns becomes
the `context` argument of `onSuccess` / `onError` / `onSettled`. Writing that
inline, TypeScript infers the chain but it's easy to drift. `mutationOptions`
pins all four generics in one place, so an optimistic rollback type-checks
end to end:

```ts
public add() {
  return mutationOptions({
    mutationFn: (title: string) =>
      this.#http.post<Todo>('/api/todos', { title }),

    // onMutate returns { previous } …
    onMutate: (title) => {
      const previous = this.#client.getQueryData<Todo[]>(['todos']) ?? []

      this.#client.setQueryData<Todo[]>(['todos'], (todos = []) => [
        ...todos,
        { id: -1, title },
      ])

      return { previous }
    },

    // … and `context` here is typed as { previous: Todo[] } | undefined,
    // not `unknown`.
    onError: (_error, _title, context) => {
      if (context) {
        this.#client.setQueryData<Todo[]>(['todos'], context.previous)
      }
    },
  })
}
```

Get `context.previous` wrong — a typo, the wrong shape — and it's a compile
error, not a broken rollback at runtime.

## Overriding per component

The returned object is plain, so spread it to tweak one field locally:

```ts
protected readonly addTodo = injectMutation(() => ({
  ...this.#mutations.add(),
  onSuccess: () => this.toast('Added!'), // this component wants a toast too
}))
```

Note a spread **replaces** a hook, it doesn't stack — the override's `onSuccess`
runs instead of the definition's, not after it. If you want both behaviours, call
the original from inside the override.

## Testing

Same payoff as `queryOptions`: a mutation definition is a plain object you can
build and assert without a component or `TestBed`:

```ts
it('invalidates todos on success', () => {
  const options = mutations.add()

  options.onSuccess?.(todo, 'Buy milk', undefined)

  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['todos'] })
})
```

## No `mutationKey`

If you're coming from TanStack Query: there's no `mutationKey` here. Mutations
aren't looked up by key, so there's nothing to name them with, and the mutation
cache can only be filtered by `status` (which is what `injectIsMutating` uses).
`mutationOptions` is purely about typing and reuse, not identity.
