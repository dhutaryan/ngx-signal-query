# ngx-signal-query

[![npm version](https://img.shields.io/npm/v/ngx-signal-query.svg)](https://www.npmjs.com/package/ngx-signal-query)
[![bundle size](https://deno.bundlejs.com/badge?q=ngx-signal-query&config=%7B%22esbuild%22%3A%7B%22external%22%3A%5B%22%40angular/core%22%2C%22%40angular/common%22%2C%22rxjs%22%2C%22rxjs/operators%22%2C%22tslib%22%5D%7D%7D)](https://bundlejs.com/?q=ngx-signal-query&config=%7B%22esbuild%22%3A%7B%22external%22%3A%5B%22%40angular/core%22%2C%22%40angular/common%22%2C%22rxjs%22%2C%22rxjs/operators%22%2C%22tslib%22%5D%7D%7D)
[![license](https://img.shields.io/npm/l/ngx-signal-query.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-ngx--signal--query-blue)](https://dhutaryan.github.io/ngx-signal-query/)

A data fetching, caching and mutation library for Angular, built on signals and
RxJS. Queries and mutations take an `Observable` as is, so `HttpClient` works
without `lastValueFrom`, and when no component needs a query any more, its
`HttpClient` request is cancelled. The model (query keys, staleness,
invalidation) follows [TanStack Query](https://tanstack.com/query), so what you
know from it carries over.

## Why this one

- 🔌 **Observables end to end.** Return `http.get()` from a `queryFn` or `mutationFn`. For a query, unsubscribing is the cancellation: once no component needs it, the request is aborted, with no `AbortSignal` plumbing.
- 🅰️ **Angular all the way down.** State is signals, configuration is `provideQueryClient(withDefaultOptions(...))`, and default mutation hooks run in an injection context, so a global `onError` can `inject()` what it needs.
- 🪶 **Small.** Tree-shakable ESM, no runtime dependencies beyond `tslib`.
- 🧭 **Familiar concepts.** `queryKey`, `staleTime`, `invalidateQueries` and `placeholderData` mean what you'd expect. Moving to TanStack Query later is mostly mechanical: wrap Observables in `lastValueFrom` and swap the provider.

## Features

- 🚦 State as signals: read `data()` or `isPending()` in a template or a `computed`, no subscriptions
- 🗄️ Caching, request deduplication and structural sharing
- ♻️ Invalidation, cancellation and manual cache updates
- 🔗 Dependent, parallel (`injectQueries`) and disabled queries
- 🖼️ Seed and placeholder data while a query loads (`initialData`, `placeholderData`, `keepPreviousData`)
- 🔁 Retries, polling, and refetch on window focus and reconnect
- ✏️ Mutations with async lifecycle hooks and optimistic updates
- 🌍 App-wide defaults and global indicators (`injectIsFetching()`, `injectIsMutating()`)

## Not here (yet)

Infinite queries, SSR cache hydration, devtools and persistence. If you need
them today, TanStack Query has them.

## Installation

```bash
npm install ngx-signal-query
```

Requires **Angular 19+** and **RxJS 7.4+** (peer dependencies `@angular/core`,
`@angular/common` and `rxjs`).

## Quick start

### 1. Provide the query client

```ts
// app.config.ts
import { ApplicationConfig } from '@angular/core'
import { provideHttpClient } from '@angular/common/http'
import { provideQueryClient } from 'ngx-signal-query'

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(), provideQueryClient()],
}
```

### 2. Fetch data in a component

```ts
import { Component, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { injectQuery } from 'ngx-signal-query'

type Todo = { id: number; title: string }

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
  `,
})
export class TodosComponent {
  private readonly http = inject(HttpClient)

  protected readonly todos = injectQuery(() => ({
    queryKey: ['todos'],
    queryFn: () => this.http.get<Todo[]>('/api/todos'),
  }))
}
```

### 3. Mutate and reconcile the cache

`injectMutation` works the same way: call `mutate()`, read `isPending()` /
`status()` as signals, and invalidate affected queries once it succeeds.

```ts
import { Component, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { injectMutation, injectQueryClient } from 'ngx-signal-query'

type Todo = { id: number; title: string }

@Component({
  selector: 'app-add-todo',
  template: `
    <button
      (click)="addTodo.mutate('Buy milk')"
      [disabled]="addTodo.isPending()"
    >
      Add todo
    </button>
  `,
})
export class AddTodoComponent {
  private readonly http = inject(HttpClient)
  private readonly client = injectQueryClient()

  protected readonly addTodo = injectMutation(() => ({
    mutationFn: (title: string) =>
      this.http.post<Todo>('/api/todos', { title }),
    onSuccess: () => this.client.invalidateQueries({ queryKey: ['todos'] }),
  }))
}
```

## Documentation

📖 **[Read the docs](https://dhutaryan.github.io/ngx-signal-query/)** — guides and examples.

## License

[MIT](./LICENSE)
