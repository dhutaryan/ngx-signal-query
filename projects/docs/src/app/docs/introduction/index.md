**ngx-signal-query** is a tiny, signal-native library for data fetching,
caching, and mutations in Angular — inspired by
[TanStack Query](https://tanstack.com/query), but built from scratch directly on
Angular Signals, with first-class RxJS support. Your `queryFn` can return an
`Observable` (hello, `HttpClient`) or a `Promise`, and the result is exposed as
plain signals you can compose with everything else Angular gives you.

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

## Motivation: why build another one?

There's already TanStack Query (which has an excellent Angular adapter). So why
does this exist? Three honest reasons:

1. **Observable-first.** Most query libraries treat Promises as first-class and
   Observables as an afterthought. Angular is RxJS-native, so here your
   `queryFn` can return an `Observable` directly — `HttpClient` just works, no
   `firstValueFrom`/`lastValueFrom` dance.

2. **Radical simplicity & forkability.** Instead of layering a framework-agnostic
   core under an adapter, this is small and from-scratch, built entirely on
   Angular Signals. Small surface, easy to read, easy to fork and bend to your
   needs.

3. **Understanding by building.** The best way to really understand caching,
   deduplication and mutation lifecycles is to build them. This started as that
   exercise — and turned out usable enough to share.

> If you want the longer story, there's a write-up on dev.to:
> [TanStack Query-style caching, the Angular-native way](https://dev.to/dhutaryan/tanstack-query-style-caching-the-angular-native-way-4igc).

## Philosophy: signal-native by default

Query state is exposed as **signals** — `data()`, `status()`, `isFetching()`,
and friends. No manual subscriptions, no `async` pipe, no lifecycle plumbing.
Because everything is a signal, it composes naturally with `computed`,
`effect`, and `OnPush` change detection — it feels like a part of Angular
rather than a bolt-on.

It's deliberately focused: **not** a TanStack killer, just a smaller,
RxJS-friendly, signal-native take on the same ideas.

## At a glance

- 🚦 **Signal-native** — state as signals (`data()`, `status()`, …), no subscriptions.
- 🗄️ **Caching & deduplication** — identical query keys share one request and cache entry.
- ✏️ **Mutations** — `onMutate` / `onSuccess` / `onError` lifecycle for optimistic updates.
- 🔁 **Retries & polling** — configurable `retry` and `refetchInterval`.
- 🌍 **Global indicators** — `injectIsFetching()` / `injectIsMutating()` for app-wide loading state.
- 🪶 **Lean** — ESM, `sideEffects: false`, no runtime deps beyond `tslib`.

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
