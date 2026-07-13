When a query fails, it doesn't give up immediately. It retries a few times
first, and only then settles into `status() === 'error'`.

That's the default, and it's usually what you want: most failures are a blip.

## The defaults

- **`retry: 3`** — three retries after the initial attempt (so **four** calls to
  `queryFn` in total before the query errors).
- **`retryDelay`** — exponential backoff: **1s**, then **2s**, then **4s**,
  doubling each time and capped at **30s**.

Note that `queryFn` is called again for each retry — it isn't invoked once and
replayed.

## retry

Takes one of four things:

```ts
retry: false // never retry — fail on the first error
retry: true // retry forever
retry: 3 // retry 3 times, then error
retry: (failureCount, error) => boolean // decide per failure
```

The numeric form counts **retries**, not attempts. `retry: 2` means one initial
call plus two retries — three calls to `queryFn`, and `failureCount()` ends up
at `3`.

## Don't retry what won't succeed

Retrying a `404` or a `403` is pointless — the answer won't change. The useful
pattern is to retry only on failures that might be transient:

```ts
import { HttpErrorResponse } from '@angular/common/http'

injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  retry: (failureCount, error) => {
    // Client errors are permanent — give up at once.
    if (error instanceof HttpErrorResponse && error.status < 500) {
      return false
    }

    return failureCount < 3
  },
}))
```

## `retryDelay`

A fixed number of milliseconds, or a function of the attempt:

```ts
retryDelay: 1000 // always wait a second

retryDelay: (failureCount) => Math.min(1000 * 2 ** failureCount, 30_000) // the default

retryDelay: (failureCount, error) =>
  error instanceof HttpErrorResponse && error.status === 429
    ? 10_000 // rate-limited: back off hard
    : 1000
```

## The counter passed to your callbacks

One detail worth pinning down: the `failureCount` argument handed to `retry`
and `retryDelay` is **not** the same number as the `failureCount()` signal.

The argument counts **retries already made**, so it's **`0` on the first
failure**. The signal counts **failed attempts**, so it reads `1` at that same
moment.

| after failure № | argument to `retry` / `retryDelay` | `failureCount()` signal |
| --------------- | ---------------------------------- | ----------------------- |
| 1st             | `0`                                | `1`                     |
| 2nd             | `1`                                | `2`                     |
| 3rd             | `2`                                | `3`                     |

This isn't an accident, and it isn't a local quirk — TanStack Query behaves
exactly the same way (it evaluates the retry predicate _before_ incrementing its
counter). The 0-based argument is what makes `retry: 3` and
`retry: (failureCount) => failureCount < 3` mean the same thing, and it lines up
with `retryDelay`, where attempt `0` should produce the first — and shortest —
wait.

## Watching a retry happen

While a query is retrying, it's still `'pending'` — it hasn't failed yet. Two
signals let you show what's going on:

- **`failureCount()`** — failed attempts so far
- **`failureReason()`** — the error from the most recent failure

{% raw %}

```html
@if (todos.isLoading()) {
  <p>Loading…</p>

  @if (todos.failureCount() > 0) {
    <p class="muted">
      Attempt {{ todos.failureCount() + 1 }} — {{ todos.failureReason()?.message }}
    </p>
  }
}
```

{% endraw %}

Once retries are exhausted the query flips to `'error'`, and `error()` holds the
final failure.

## Setting it once

Rather than repeating a retry policy on every query, set it globally when you
provide the client:

```ts
provideQueryClient(
  withDefaultOptions({
    queries: {
      retry: 2,
      retryDelay: 500,
    },
  }),
)
```

Individual queries can still override it.

## Mutations are different

Mutations default to **no retry at all** (`retry: 0`). That's deliberate: a
write isn't necessarily idempotent, and blindly re-sending a `POST` can create
two records. Opt in only when you know the operation is safe to repeat.
