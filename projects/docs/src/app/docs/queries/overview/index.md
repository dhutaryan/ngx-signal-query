A **query** is a declarative dependency on an asynchronous source of data, tied
to a **unique key**. You describe *what* you need and *how to get it*; the
library takes care of fetching, caching, deduplication and keeping the result
fresh.

Use a query for anything you **read** from the server. For anything that
*changes* server state, reach for a mutation instead.

## Query basics

To subscribe to a query, call `injectQuery` with a function returning at least
two things:

- **`queryKey`** — a unique key for this data. It's what the cache is keyed on,
  so two components asking for the same key share one request and one cache
  entry.
- **`queryFn`** — a function that fetches the data. It can return an
  `Observable` **or** a `Promise`, so `HttpClient` works without any conversion.

```ts
import { Component, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { injectQuery } from 'ngx-signal-query'

type Todo = { id: number; title: string }

@Component({
  selector: 'app-todos',
  template: `…`,
})
export class TodosComponent {
  readonly #http = inject(HttpClient)

  protected readonly todos = injectQuery(() => ({
    queryKey: ['todos'],
    queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  }))
}
```

The result is an object of **signals** — read them directly in the template, no
subscriptions and no `async` pipe.

## Query states

Every query is always in exactly one of three states, exposed as `status()`:

| `status()` | meaning |
| --- | --- |
| `'pending'` | no data resolved yet |
| `'success'` | data is available in `data()` |
| `'error'` | the fetch failed and `error()` is set |

For convenience the same information is available as boolean signals, so you
rarely compare strings by hand:

- `isPending()` — `status() === 'pending'`
- `isSuccess()` — `status() === 'success'`
- `isError()` — `status() === 'error'`

## Rendering a query

The simplest approach is a chain of boolean checks. Note that inside the
`@if (todos.data(); as data)` block `data` is narrowed to `Todo[]` — no
non-null assertions needed:

{% raw %}

```html
@if (todos.isPending()) {
  <p>Loading…</p>
} @else if (todos.isError()) {
  <p>Something went wrong: {{ todos.error()?.message }}</p>
} @else {
  @if (todos.data(); as data) {
    <ul>
      @for (todo of data; track todo.id) {
        <li>{{ todo.title }}</li>
      }
    </ul>
  }
}
```

{% endraw %}

If you prefer, `@switch` on `status()` reads a little more explicitly:

{% raw %}

```html
@switch (todos.status()) {
  @case ('pending') {
    <p>Loading…</p>
  }
  @case ('error') {
    <p>Something went wrong: {{ todos.error()?.message }}</p>
  }
  @case ('success') {
    <ul>
      @for (todo of todos.data() ?? []; track todo.id) {
        <li>{{ todo.title }}</li>
      }
    </ul>
  }
}
```

{% endraw %}

## `status` vs `isFetching` — two different questions

This trips people up, so it's worth being precise. `status()` and
`isFetching()` answer **two different questions**:

- **`status()` tells you about the _data_** — do we have it yet?
- **`isFetching()` tells you about the _request_** — is a fetch in flight
  *right now*, including background refetches?

They're independent. A query that already has data can be refetching in the
background — that's `status() === 'success'` **and** `isFetching() === true` at
the same time. This is the stale-while-revalidate pattern: keep showing the old
data, quietly refresh it, swap it in when it lands.

That's exactly why both exist. If you only had `status`, you couldn't tell
"loading for the first time" apart from "refreshing data we already show".

`isLoading()` is the shorthand for the common case — the **first** fetch, with
no data on screen yet:

```ts
// isLoading() is exactly this:
isFetching() && status() === 'pending'
```

A practical combination — a full-page spinner on first load, a subtle indicator
on background refreshes:

{% raw %}

```html
@if (todos.isLoading()) {
  <p>Loading…</p>
} @else {
  @if (todos.isFetching()) {
    <span class="badge">Refreshing…</span>
  }

  <ul>
    @for (todo of todos.data() ?? []; track todo.id) {
      <li>{{ todo.title }}</li>
    }
  </ul>
}
```

{% endraw %}

## Refetching manually

`refetch()` forces a fresh fetch, ignoring `staleTime`:

{% raw %}

```html
<button (click)="todos.refetch()" [disabled]="todos.isFetching()">
  Refresh
</button>
```

{% endraw %}

## Errors and retries

When `queryFn` throws (or the `Observable` errors), the query moves to
`'error'` and exposes the failure:

- `error()` — the last error, or `null`
- `failureCount()` — how many attempts have failed in a row
- `failureReason()` — the error from the most recent failed attempt

Failed queries are **retried automatically** before landing in the `'error'`
state, so `failureCount()` can climb while `status()` is still `'pending'` —
useful for showing "retrying…" feedback. Retry behaviour is configurable via
`retry` and `retryDelay`.
