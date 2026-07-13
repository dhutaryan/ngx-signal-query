A query function is the thing that actually fetches. Its contract is small:

```ts
queryFn: () => Observable<TData> | Promise<TData>
```

It takes **no arguments** and returns either an `Observable` or a `Promise`.
That's the whole interface.

## Observables are first-class

`HttpClient` returns an `Observable`, so it plugs in directly — no
`firstValueFrom`, no conversion:

```ts
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
}))
```

A `Promise` works just as well, so `fetch` or any promise-based SDK is fine
too:

```ts
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: async () => {
    const response = await fetch('/api/todos')

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`)
    }

    return (await response.json()) as Todo[]
  },
}))
```

Note the explicit status check in that example — see
[Errors](/queries/query-functions#errors) below for why it's mandatory.

## Only the first value is used

A query is a **one-shot fetch**, not a subscription. Internally the result is
piped through `take(1)`, so if your `Observable` emits more than once, only the
**first** emission becomes the query data; the rest are ignored.

So don't hand a query a long-lived stream (a WebSocket, an interval): it won't
keep the cache in sync, it'll just take the first value and unsubscribe. To
keep data fresh, use polling (`refetchInterval`) or write to the cache
yourself with `setQueryData`.

Conversely, the `Observable` **must** produce a value. If it completes without
emitting anything, the query fails with:

```
Query function completed without emitting a value
```

This is the guard against a query silently sitting in `'success'` with no data.

## Errors

A query fails when the `Observable` errors or the `Promise` rejects. Whatever
was thrown lands in `error()` and the query moves to `status() === 'error'`.

**With `HttpClient` you get this for free** — it errors automatically on any
non-2xx response, so a 404 or 500 becomes a failed query with no extra code.

**With `fetch` you don't.** `fetch` only rejects on network failure; an HTTP
404 or 500 resolves *successfully*. If you don't check the status yourself, a
404 HTML error page gets cached as if it were valid data:

```ts
// ❌ a 500 lands in the cache as "successful" data
queryFn: () => fetch('/api/todos').then((r) => r.json())

// ✅ turn a bad status into a real error
queryFn: async () => {
  const response = await fetch('/api/todos')

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }

  return (await response.json()) as Todo[]
}
```

Failures are retried before the query settles into `'error'` — see the retry
options for how to tune that.

## Cancellation: why `Observable` wins

The library cancels an in-flight fetch by **unsubscribing** from it. That has a
real consequence:

- **`Observable`** — unsubscribing propagates all the way down, and `HttpClient`
  **aborts the actual HTTP request**. Nothing is left in flight.
- **`Promise`** — a promise can't be cancelled. Unsubscribing just means the
  result is ignored; the request keeps running to completion in the background.

Cancellation happens on `refetch()`, when `cancelQueries()` is called, and when
a reactive key changes while a fetch is still running. If you care about not
leaving orphaned requests behind (rapid typing in a search box, say), prefer
`HttpClient` and its `Observable`.

## Where do the variables come from?

There is **no context argument** — the query function is never handed the
`queryKey`. Instead you close over whatever you need, and since keys are
reactive, a signal read inside both the key and the function keeps them in
lockstep:

```ts
export class TodoComponent {
  readonly #http = inject(HttpClient)

  readonly todoId = signal(1)

  protected readonly todo = injectQuery(() => ({
    queryKey: ['todo', this.todoId()],
    queryFn: () => this.#http.get<Todo>(`/api/todos/${this.todoId()}`),
  }))
}
```

Which is exactly why the rule from [Query Keys](/queries/query-keys) matters:
**every variable the query function reads must also appear in the key.** Miss
one, and different data ends up sharing a cache entry.

## Retries re-invoke the function

`queryFn` is called again on every retry attempt — it isn't invoked once and
replayed. This is what makes retrying a `Promise` work at all (a promise is
one-shot; retrying it would just hand back the same rejection), and it means
your function should be safe to call more than once.
