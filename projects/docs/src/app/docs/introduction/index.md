**ngx-signal-query** is a data fetching, caching and mutation library for
Angular, built on signals and RxJS. Your `queryFn` and `mutationFn` can return
an `Observable` (hello, `HttpClient`) or a `Promise`, and the result is exposed
as plain signals you can compose with everything else Angular gives you. The
model (query keys, staleness, invalidation) follows
[TanStack Query](https://tanstack.com/query).

## The problem: server state is not client state

Most state tooling is great at **client state** — the ephemeral, synchronous,
fully-owned state that lives in your app. **Server state** is a different beast:
it's remote, asynchronous, shared between components, and it goes stale the
moment you fetch it.

Handling it well means solving a familiar list of hard problems:

- **Caching** — arguably one of the hardest things in programming.
- **Deduplication** — collapsing identical in-flight requests into one.
- **Staleness & background updates** — knowing when data is old and refreshing
  it without the user asking.
- **Mutations** — updating server state and reconciling the cache, ideally
  optimistically.
- **Retries & polling** — surviving flaky networks and keeping data fresh.

Angular 19.2 shipped [`httpResource`](https://angular.dev/api/common/http/httpResource),
a signal-based way to fetch data. It's lovely for a single component — but the
moment two components need the same data, the important pieces are missing:
no shared cache, no deduplication, no cross-component invalidation, no mutation
lifecycle, no retries, no `staleTime`. You're left hand-rolling a cache or
reaching for a full query library.

## Why this library

TanStack Query has an Angular adapter, and Angular ships `httpResource`. This
library takes TanStack Query's model and builds it on Angular's own primitives:

1. **Observables end to end.** A `queryFn` or `mutationFn` returns an
   `Observable` as is, so `HttpClient` works without `lastValueFrom`. For a
   query, unsubscribing is the cancellation: once nothing observes it (its key
   changed, its component was destroyed) or you call `cancelQueries()`, the
   HTTP request is aborted, with no `AbortSignal` plumbing.

2. **Angular-native.** Signals for state, `provide*` functions and features for
   configuration, and an injection context for default mutation hooks, so a
   global `onError` can `inject()` what it needs.

3. **Small, and kept honest.** About 5 KB min+gzip. Bug fixes ship with a spec
   that fails without the fix, and releases follow semver, with a `dev` channel
   for previews.

It's deliberately focused. If you need infinite queries, devtools or
persistence today, TanStack Query is the better pick. If you want Observables
and Angular DI all the way through, with a surface you can read in full, this
is for you.

> How it started: [TanStack Query-style caching, the Angular-native way](https://dev.to/dhutaryan/tanstack-query-style-caching-the-angular-native-way-4igc).

## Philosophy: signal-native by default

Query state is exposed as **signals** — `data()`, `status()`, `isFetching()`,
and friends. No manual subscriptions, no `async` pipe, no lifecycle plumbing.
Because everything is a signal, it composes naturally with `computed`,
`effect`, and `OnPush` change detection — it feels like a part of Angular
rather than a bolt-on.

## At a glance

- 🚦 State as signals: read `data()` or `isPending()` in a template or a `computed`, no subscriptions
- 🗄️ Caching, request deduplication and structural sharing
- ♻️ Invalidation, cancellation and manual cache updates
- 🔗 Dependent, parallel (`injectQueries`) and disabled queries
- 🖼️ Seed and placeholder data while a query loads (`initialData`, `placeholderData`, `keepPreviousData`)
- 🔁 Retries, polling, and refetch on window focus and reconnect
- ✏️ Mutations with async lifecycle hooks and optimistic updates
- 🌍 App-wide defaults and global indicators (`injectIsFetching()`, `injectIsMutating()`)

Not here yet: infinite queries, SSR cache hydration, devtools and persistence.

## A quick taste

Provide the client once:

```ts
// app.config.ts
import { ApplicationConfig } from '@angular/core'
import { provideHttpClient } from '@angular/common/http'
import { provideQueryClient } from 'ngx-signal-query'

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(), provideQueryClient()],
}
```

Describe your queries and mutations — note the `queryFn` returning an
`Observable` straight from `HttpClient`, and the optimistic update in
`onMutate`:

```ts
import { inject, Injectable } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import {
  injectQueryClient,
  mutationOptions,
  queryOptions,
} from 'ngx-signal-query'

type Todo = { id: number; title: string }

@Injectable({ providedIn: 'root' })
export class TodoQueries {
  readonly #http = inject(HttpClient)
  readonly #client = injectQueryClient()

  public todos() {
    return queryOptions({
      queryKey: ['todos'],
      queryFn: () => this.#http.get<Todo[]>('/api/todos'),
      retry: (failureCount) => failureCount < 2,
    })
  }

  public addTodo() {
    return mutationOptions({
      mutationFn: (title: string) =>
        this.#http.post<Todo>('/api/todos', { title }),
      // Optimistically add the row, remember the previous state for rollback.
      onMutate: (title) => {
        const previous = this.#client.getQueryData<Todo[]>(['todos']) ?? []

        this.#client.setQueryData<Todo[]>(['todos'], (prev = []) => [
          ...prev,
          { id: -1, title },
        ])

        return { previous }
      },
      onError: (_error, _title, context) => {
        this.#client.setQueryData<Todo[]>(['todos'], context?.previous)
      },
      onSuccess: () => this.#client.invalidateQueries({ queryKey: ['todos'] }),
    })
  }
}
```

Then consume them in a component — the result is just signals:

{% raw %}

```ts
import { Component, inject } from '@angular/core'
import { injectMutation, injectQuery } from 'ngx-signal-query'

import { TodoQueries } from './todo-queries'

@Component({
  selector: 'app-todos',
  template: `
    <p>status: {{ todos.status() }}</p>

    @if (todos.data(); as data) {
      <ul>
        @for (todo of data; track todo.id) {
          <li>{{ todo.title }}</li>
        }
      </ul>
    }

    <button (click)="todos.refetch()">Refetch</button>

    <button
      (click)="addTodo.mutate('Buy milk')"
      [disabled]="addTodo.isPending()"
    >
      Add todo
    </button>
  `,
})
export class TodosComponent {
  readonly #queries = inject(TodoQueries)

  protected readonly todos = injectQuery(() => this.#queries.todos())
  protected readonly addTodo = injectMutation(() => this.#queries.addTodo())
}
```

{% endraw %}

Ready to try it? Head to **Installation** to add it to your project.
