A **query** is a declarative dependency on an asynchronous source of data, tied to a **unique key**. You describe _what_ you need and _how to get it_; the library takes care of fetching, caching, deduplication and keeping the result fresh.

Use a query for anything you **read** from the server. For anything that _changes_ server state, reach for a mutation instead.

## Query basics

To subscribe to a query, call `injectQuery` with a function returning at least two things:

- **`queryKey`** — a unique key for this data. It's what the cache is keyed on, so two components asking for the same key share one request and one cache entry.
- **`queryFn`** — a function that fetches the data. It can return an `Observable` **or** a `Promise`, so `HttpClient` works without any conversion.

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

The result is an object of **signals** — read them directly in the template, no subscriptions and no `async` pipe.

## Query states

Every query is always in exactly one of three states, exposed as `status()`:

| `status()`  | meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `'pending'` | no data yet: the first load, or a new attempt after a failure |
| `'success'` | data is available in `data()`                                 |
| `'error'`   | the fetch failed and `error()` is set                         |

A query that failed before it had any data is back in `'pending'` while it's tried again; see [Trying again after an error](/queries/overview#trying-again-after-an-error).

For convenience the same information is available as boolean signals, so you rarely compare strings by hand:

- `isPending()` — `status() === 'pending'`
- `isSuccess()` — `status() === 'success'`
- `isError()` — `status() === 'error'`

## Rendering a query

The simplest approach is a chain of boolean checks. Note that inside the `@if (todos.data(); as data)` block `data` is narrowed to `Todo[]` — no non-null assertions needed:

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

A query whose `initialData` always seeds it can do without the `@if (todos.data(); as data)` block: its `data()` is `Todo[]` from the first read, not `Todo[] | undefined`. See [Initial Data](/queries/initial-data).

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

This trips people up, so it's worth being precise. `status()` and `isFetching()` answer **two different questions**:

- **`status()` tells you about the _data_** — do we have it yet?
- **`isFetching()` tells you about the _request_** — is a fetch in flight _right now_, including background refetches?

They're independent. A query that already has data can be refetching in the background — that's `status() === 'success'` **and** `isFetching() === true` at the same time. This is the stale-while-revalidate pattern: keep showing the old data, quietly refresh it, swap it in when it lands.

That's exactly why both exist. If you only had `status`, you couldn't tell "loading for the first time" apart from "refreshing data we already show".

`isLoading()` is the shorthand for the common case — a fetch with **no data on screen yet**: the first one, or a new attempt after a failure:

```ts
// isLoading() is exactly this:
isFetching() && status() === 'pending'
```

A practical combination — a full-page spinner on first load, a subtle indicator on background refreshes:

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

## Waiting for fresh data

Most screens are happy to show cached data while it refreshes. A form that edits a record isn't: it takes its values once, so filled from the cache it shows what was cached, and the refetch that lands a moment later either never reaches it or overwrites what the user has typed. Such a page waits for a fetch of its own, even when the cache already holds the record because a list loaded it, or `initialData` seeds it from the list.

The signals above can't tell that moment apart: cached data is `'success'` at once, `isFetching()` turns on again with every background refetch, and `dataUpdatedAt()` moves for a seed of `initialData` as it does for a fetch. Two signals can:

- **`isFetchedAfterMount()`** — a fetch of the key has landed since this component started showing it, with data or with an error, whoever made it. A key change starts it over for the new key.
- **`isFetched()`** — a fetch of the key has landed at all, here or before this component. Data that only `initialData` or `placeholderData` gave doesn't count.

A `setQueryData()` write counts as a fetch for both; see [Manual Cache Updates](/query-client/manual-cache-updates).

The edit page shows its form once its own fetch is in:

```ts
export class EditTodoComponent {
  readonly #http = inject(HttpClient)

  readonly id = input.required<number>()

  protected readonly todo = injectQuery(() => ({
    queryKey: ['todo', this.id()],
    queryFn: () => this.#http.get<Todo>(`/api/todos/${this.id()}`),
  }))
}
```

{% raw %}

```html
@if (!todo.isFetchedAfterMount()) {
  <p>Loading…</p>
} @else {
  @if (todo.data(); as data) {
    <app-todo-form [todo]="data" />
  } @else if (todo.isError()) {
    <p>Couldn't load the todo: {{ todo.error()?.message }}</p>
    <button (click)="todo.refetch()">Retry</button>
  } @else {
    <p>Loading…</p>
  }
}
```

{% endraw %}

A failed fetch counts too: the flag says the fetch is over, not that it worked. With no data, the error branch offers a retry, and the last branch shows the new attempt. With data from before, a failed fetch keeps it, so the form starts from that data; read `isError()` next to the form if the user should know. Once the form is up, a background refetch, back to the tab or after an invalidation, doesn't turn the flag back to `false`, so the form stays while the user types, whether the refetch works or not.

The flag waits for a fetch, so one has to happen: a component fetches as it starts only when the cached data is stale. With the [default](/important-defaults) `staleTime` of `0` it always is. With a longer one, data that's still fresh is shown as it is, and `isFetchedAfterMount()` stays `false` until something else fetches the key: if your [default options](/query-client/default-options) set a `staleTime`, give the edit page's query `staleTime: 0`.

`isFetched()` asks less: whether any fetch of the key has landed, here or before this component. It's `false` while a detail shows only the list row `initialData` seeded it with, and turns `true` with the first fetch, wherever it's made.

## Refetching manually

`refetch()` forces a fresh fetch, ignoring `staleTime`:

{% raw %}

```html
<button (click)="todos.refetch()" [disabled]="todos.isFetching()">
  Refresh
</button>
```

{% endraw %}

It returns a promise that resolves once the fetch is back, with the `data` and `error` the query shows then. Called while the first load is still running, it lets that load show first, and the promise waits for a fetch made after the call. No such fetch comes if that load is cancelled or removed, or if by the time it lands the component has moved to another key or been destroyed and no enabled component shows the key: the promise then resolves as soon as the load is done. It never rejects: a failed fetch resolves with its error.

```ts
protected async refresh(): Promise<void> {
  const { error } = await this.todos.refetch()

  if (!error) this.#toast.show('Up to date')
}
```

## Errors and retries

When `queryFn` throws (or the `Observable` errors), the query moves to `'error'` and exposes the failure:

- `error()` — the last error, or `null`
- `failureCount()` — how many attempts have failed in a row
- `failureReason()` — the error from the most recent failed attempt

Failed queries are **retried automatically** before landing in the `'error'` state, so `failureCount()` can climb while `status()` is still `'pending'` — useful for showing "retrying…" feedback. Retry behaviour is configurable via `retry` and `retryDelay`.

### Trying again after an error

A query in `'error'` fetches again on the same occasions as any other query: a `refetch()`, an invalidation, a component that starts showing it, the user coming back to the tab. What it reads meanwhile depends on whether it has data:

- **No data yet** — it's back in `'pending'` with `error()` at `null`, so the new attempt reads like a first load: `isLoading()` is `true` and `placeholderData` shows. If the attempt fails too, the query is back in `'error'` with the new error.
- **Data from before** — it keeps its data, its `'error'` status and the error while it refetches; `isFetching()` tells you a refetch is running.

So a Retry button only has to call `refetch()`: the template shows "Loading…" while the new attempt runs, then the data or the error.

{% raw %}

```html
@if (todos.isPending()) {
  <p>Loading…</p>
} @else if (todos.isError()) {
  <p>Something went wrong: {{ todos.error()?.message }}</p>
  <button (click)="todos.refetch()">Retry</button>
} @else {
  <ul>
    @for (todo of todos.data() ?? []; track todo.id) {
      <li>{{ todo.title }}</li>
    }
  </ul>
}
```

{% endraw %}

Cancel the new attempt with `cancelQueries` and the query goes back to how it was before it, error included; see [Cancellation and Removal](/query-client/cancellation-and-removal).
