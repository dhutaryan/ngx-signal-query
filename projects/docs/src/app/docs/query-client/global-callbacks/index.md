Some things should happen for every request in the app, not for one: reporting each failure to your error handler, showing a toast, logging, refreshing what a save changed. Instead of repeating that on every query and mutation, give the client callbacks once, with `withQueryCache()` and `withMutationCache()`.

## Every failed query, once

Pass `withQueryCache()` to `provideQueryClient()`:

```ts
// app.config.ts
import { ErrorHandler, inject } from '@angular/core'
import { provideQueryClient, withQueryCache } from 'ngx-signal-query'

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(),
    provideQueryClient(
      withQueryCache({
        onError: (error) => inject(ErrorHandler).handleError(error),
      }),
    ),
  ],
}
```

`onError` runs **once per failed fetch, after its retries**. That's what sets it apart from catching the error where the request is made, in an `HttpInterceptor` or with `tap()` in `queryFn`: those run on every attempt, so with the default `retry: 3` one failed query reports four times.

It runs whatever started the fetch: a component's `injectQuery`, `injectQueries` or `injectInfiniteQuery`, a prefetch with `query()`, `infiniteQuery()` or `fetchQuery()`, an invalidation, `refetch()`, polling, or a refetch on window focus or reconnect. A fetch that several components share calls it once.

There are three callbacks, all optional:

```ts
withQueryCache({
  onSuccess: (data, query) => {},
  onError: (error, query) => {},
  onSettled: (data, error, query) => {},
})
```

`onSuccess` gets the query's new data, `onError` the error the fetch failed with. `onSettled` runs after either: with the data and `null`, or with the data the query still holds and the error.

### What `query` tells you

The last argument is the query as the fetch left it:

| Field | What it holds |
| --- | --- |
| `queryKey` | The query's key. |
| `queryHash` | The key's hash, which the cache keeps the query under. |
| `state` | The query's state: `data`, `status`, `error`, `failureCount` and the rest of `QueryState`. |
| `meta` | The `meta` of the options that the fetch ran with; see [`meta`](#meta) below. |

It stays as it is: read it later, and it still shows the query as the fetch left it.

A common use: a toast only when a **background** refetch fails. A query that still holds data keeps showing it, so the user may not notice the failure, while a first load that fails shows its error on the page anyway:

```ts
withQueryCache({
  onError: (error, query) => {
    if (query.state.data !== undefined) {
      inject(Notifications).show('Could not refresh the data') // your app's own service
    }
  },
})
```

### What doesn't call them

A fetch that stops before it ends calls none: one that's cancelled or replaced, one whose query is removed, and one stopped once no component shows the query any more. Neither does data that no fetch brings: what `setQueryData()` writes, what `initialData` seeds, and what [`withHydration()`](/server-rendering) brings over from the server.

## Every mutation

`withMutationCache()` does the same for mutations, with the hooks a mutation has:

```ts
withMutationCache({
  onMutate: (variables, mutation) => {},
  onSuccess: (data, variables, context, mutation) => {},
  onError: (error, variables, context, mutation) => {},
  onSettled: (data, error, variables, context, mutation) => {},
})
```

Each one runs **right before the mutation's own hook of the same name**, or before the [default one](/query-client/default-options), whether the mutation has a hook of its own or not:

```
onMutate (global)  →  onMutate  →  mutationFn  →  onSuccess | onError (global)  →  onSuccess | onError  →  onSettled (global)  →  onSettled
```

That's what sets them apart from the default hooks of `withDefaultOptions()`. A default hook is a fallback, which a mutation's own hook replaces; a global callback always runs. So to report every failed write, including one whose own `onError` rolls an optimistic update back, use `withMutationCache()`:

```ts
provideQueryClient(
  withMutationCache({
    onError: (error) => inject(ErrorHandler).handleError(error),
  }),
)
```

`variables` and `context` are the run's: `context` is what the mutation's own `onMutate` returned, and what the global `onMutate` returns is dropped. `mutation` holds the run's `state`, still `'pending'` while the hooks run, and its `meta`.

As with the mutation's own hooks, a callback that returns a promise holds the run: the mutation stays `'pending'`, and `mutateAsync()` settles, once it's done.

### Calling a write off

The global `onMutate` runs before anything else. If it throws, or the promise it returns rejects, the run fails with its error before the write is sent, as when the mutation's own `onMutate` fails, and that `onMutate` doesn't run. That makes it the place for a check every write needs:

```ts
withMutationCache({
  onMutate: () => {
    if (inject(Session).expired()) throw new Error('Your session has expired') // your app's own service
  },
})
```

Like the other callbacks, it no longer runs once the app is torn down: a write started after that, such as one a component sends while the app is destroyed, goes out without the check.

## `meta`

A callback often needs to know something about the query or the mutation it reports: the message to show, whether the component shows the error itself, which queries a save makes stale. Give it in `meta`, on any query or mutation:

```ts
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  meta: { errorMessage: 'Could not load your todos' },
}))

injectMutation(() => ({
  mutationFn: (todo: Todo) => this.#http.post<Todo>('/api/todos', todo),
  meta: { invalidates: ['todos'] },
}))
```

The library itself doesn't read it. It goes wherever a query's or a mutation's options go: [definitions](/queries/query-options), `injectQueries`, `injectInfiniteQuery` and the client's `query()`, `infiniteQuery()` and `fetchQuery()`.

### Typing it

`meta` is any plain object, `Record<string, unknown>`, unless you declare its type once for the whole app. Then every query's and mutation's `meta` is checked against it, and the callbacks get it typed:

```ts
// src/meta.d.ts
import type { QueryKey } from 'ngx-signal-query'

declare module 'ngx-signal-query' {
  interface Register {
    queryMeta: { errorMessage?: string; silent?: boolean }
    mutationMeta: { invalidates?: QueryKey }
  }
}
```

The file needs an import or an export, such as the `import type` above, or `export {}` if it uses no type from the library: without one, the declaration replaces the library's types rather than adding to them, and every other import from `ngx-signal-query` fails.

A type literal works, and so does an interface of your own. With the types declared, the callbacks read `meta` like any typed object:

```ts
provideQueryClient(
  withQueryCache({
    onError: (error, query) => {
      if (query.meta?.silent) return // its component shows the error itself

      inject(Notifications).show(query.meta?.errorMessage ?? 'Something went wrong')
    },
  }),
  withMutationCache({
    onSuccess: (data, variables, context, mutation) => {
      const invalidates = mutation.meta?.invalidates

      // Returned, so the mutation stays pending until those queries are fresh
      return invalidates && injectQueryClient().invalidateQueries({ queryKey: invalidates })
    },
  }),
)
```

### Whose `meta`

Several components showing one key with different `meta` still share one fetch, and the callbacks get one `meta`: that of the options the fetch ran with, such as those of the component it was fetched for, or of the `query()` call that started it. A call that joins a fetch already in flight doesn't change it. Keep `meta` in a [definition](/queries/query-options), and every component showing the key has the same.

## In your app

The callbacks run in the injection context of the injector that provides the client, so they can call `inject()`, before their first `await`, as anywhere in Angular. That's your app's injector, not the component's that started the fetch or the write. Once the app is torn down, they no longer run.

With zone.js, a query's callbacks run in Angular's zone when the fetch was asked for from there, by a component or a click handler, and outside it otherwise, such as for a poll. A mutation's callbacks run where `mutate()` was called from, as its hooks do. A plain field that a callback sets outside the zone doesn't show until something else runs change detection: set a signal instead. See [With zone.js](/queries/query-functions#with-zonejs).

A component's query whose `queryFn` answers at once, with `of()` say, calls them during change detection, when the component fetches it. A plain field that a callback sets then, shown by a component that change detection has already checked, makes Angular report `NG0100` in development, with zone.js or without. A signal works there too.

A callback that throws, other than the global `onMutate` (see [Calling a write off](#calling-a-write-off)), doesn't change the outcome: its error goes to the app's `ErrorHandler`, once, the query keeps its data or its error, and the mutation its result. The callbacks and the hooks after it still run. A promise a callback returns that rejects goes to the `ErrorHandler` the same way.

Nothing waits for a promise that a **query** callback returns: by the time it's called, the query shows the outcome. So on the server, one that rejects after the page is sent, with the app torn down by then, surfaces as an unhandled rejection rather than in the `ErrorHandler`. A request a callback makes with `HttpClient` holds the page up all the same, as any `HttpClient` request does. **Mutation** callbacks are waited for, as the mutation's own hooks are.

## Default hooks or global callbacks?

|  | Default hooks | Global callbacks |
| --- | --- | --- |
| Set with | `withDefaultOptions()` | `withQueryCache()`, `withMutationCache()` |
| For | mutations | queries and mutations |
| A mutation with a hook of its own | runs its own instead of the default | runs the global one, then its own |
| Good for | a fallback a mutation may replace | what every request needs |

They work together: the global callback first, then the mutation's own hook, or the default one if it has none.

If you come from TanStack Query: these are its `QueryCache` and `MutationCache` callbacks, given to the client as features. The differences: a callback that throws here, other than `onMutate`, goes to the `ErrorHandler` and leaves the outcome as it is; `query` and `mutation` are snapshots, with no `options`; and `meta` reaches only the callbacks, not `queryFn` or `mutationFn`.
