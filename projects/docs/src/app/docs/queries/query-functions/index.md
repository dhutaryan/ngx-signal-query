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
keep data fresh, use [polling](/queries/polling) (`refetchInterval`) or write
to the cache yourself with `setQueryData`.

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

## Cancellation: `Observable` or `Promise`

The library cancels an in-flight fetch by **unsubscribing** from it. What that
does depends on what `queryFn` returned:

- **`Observable`** — unsubscribing propagates all the way down, and `HttpClient`
  **aborts the actual HTTP request**. Nothing is left in flight.
- **`Promise`** — a promise can't be cancelled. Unsubscribing only means its
  result is ignored; the request still runs to completion.

So when no component shows a key any more (the last one showing it is
destroyed, or its reactive key moves on), a fetch still running stops only if
it's an `Observable`. A `Promise` fetch runs on, and its response is cached as
usual: come back before the query is [removed](/query-client/caching), and the
data shows at once. Until then it still counts as fetching, in
`injectIsFetching()` too. Nobody is left to want a failure tried again, though,
so a failed attempt isn't retried, unless a component shows the key again
before the fetch ends.

`refetch()` and `invalidateQueries()` cancel a fetch in flight to start a fresh
one, and `cancelQueries()` and `removeQueries()` cancel it outright, whatever
`queryFn` returned: a promise's response is ignored then.

So pick per query. To leave no requests behind (rapid typing in a search box,
say), use `HttpClient` and its `Observable`. To keep a response the user may
come back for, return a promise, e.g. `lastValueFrom(this.#http.get(...))`.
Don't wrap a promise in an `Observable` (`from(fetch(...))`): unsubscribing
can't abort the request, and its response is thrown away. Return the promise
itself.

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

A retry calls the `queryFn` of a component showing the key at that moment,
when there is one, rather than always the one the fetch started with. So a
function that reads a signal when it runs, as the one above does, still
fetches the key it's retried for, even if its own component has moved on to
another key by then.
