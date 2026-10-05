If most of your queries want the same `staleTime`, or every failed save should
reach your error handler, don't repeat it on every query and mutation — set it
once, when you provide the client.

## `withDefaultOptions`

Pass it as a feature to `provideQueryClient`:

```ts
// app.config.ts
import { ErrorHandler, inject } from '@angular/core'
import { provideQueryClient, withDefaultOptions } from 'ngx-signal-query'

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    provideQueryClient(
      withDefaultOptions({
        queries: {
          staleTime: 60_000,
          gcTime: 10 * 60_000,
          retry: 1,
        },
        mutations: {
          onError: (error) => inject(ErrorHandler).handleError(error),
        },
      }),
    ),
  ],
}
```

From then on, every query and mutation starts from those values. Anything you
don't set keeps the built-in default: [`staleTime: 0`, `gcTime: 5 min`,
`retry: 3`](/query-client/caching) for queries, no retries and no hooks for
mutations.

## What you can default

For queries, these four:

```ts
type DefaultQueryOptions = {
  staleTime?: number
  gcTime?: number
  retry?: RetryValue
  retryDelay?: RetryDelayValue
}
```

For mutations, the retry policy and the hooks that report how a write ended:

```ts
type DefaultMutationOptions = {
  retry?: RetryValue
  retryDelay?: RetryDelayValue
  onSuccess?: (data, variables, context) => unknown
  onError?: (error, variables, context) => unknown
  onSettled?: (data, error, variables, context) => unknown
}
```

Their arguments are typed `unknown`: one default serves every mutation,
whatever its data and error types, so narrow them before use.

The rest is inherently per-query or per-mutation, so there's nothing to default
there: a query's `queryKey`, `queryFn`, `enabled` and `initialData`; a
mutation's `mutationFn`, and its `onMutate`, which builds the `context` for
that mutation's own hooks.

Mutations don't retry by default, because a write isn't necessarily safe to
send twice. `mutations: { retry }` turns retries on for all of them, so set it
only if every write in your app can be repeated.

## Your own options always win

Defaults are a starting point, not a lock. A query or a mutation that sets its
own value overrides the default for that field only:

```ts
provideQueryClient(withDefaultOptions({ queries: { staleTime: 60_000 } }))

// This one query opts out — everything else still gets 60s
injectQuery(() => ({
  queryKey: ['prices'],
  queryFn: () => this.#http.get<Price[]>('/api/prices'),
  staleTime: 0, // prices must always be fresh
}))
```

Hooks follow the same rule, one by one. A mutation with its own `onError`
handles the error itself, so the default `onError` doesn't run for it, while
the default `onSuccess` and `onSettled` still do:

```ts
// The default onError reports every failed write…
provideQueryClient(
  withDefaultOptions({
    mutations: { onError: (error) => inject(ErrorHandler).handleError(error) },
  }),
)

// …except this one's: it rolls the optimistic update back instead
injectMutation(() => ({
  mutationFn: (todo: Todo) =>
    this.#http.put<Todo>(`/api/todos/${todo.id}`, todo),
  onMutate: (todo) => this.#updateOptimistically(todo),
  onError: (_error, _todo, context) => this.#rollBack(context),
}))
```

A field left `undefined` keeps the default, so a shared definition that passes
an optional hook on doesn't drop it. To turn a default hook off for one
mutation, pass a function that does nothing: `onError: () => {}`. (In TanStack
Query, a hook set to `undefined` turns the default off.)

## Default hooks can use `inject()`

The default hooks run in the injection context of the injector that provides
the client, so they can call `inject()`, as in the examples above. That's your
app's injector, not the component that started the mutation: a service
provided in a component isn't visible to them, and they still work after that
component is destroyed.

As anywhere in Angular, `inject()` works only before the first `await`, so an
async hook injects what it needs first:

```ts
mutations: {
  onError: async (error) => {
    const reporter = inject(ErrorReporter) // inject first…

    await reporter.flush() // …then await
    reporter.report(error)
  },
},
```

Once that injector is destroyed, because the app was torn down or its test has
ended, a mutation that lands afterwards skips the default hooks: the app they
belong to is gone.
