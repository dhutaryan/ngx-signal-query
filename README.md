# ngx-signal-query

[![npm version](https://img.shields.io/npm/v/ngx-signal-query.svg)](https://www.npmjs.com/package/ngx-signal-query)
[![license](https://img.shields.io/npm/l/ngx-signal-query.svg)](./LICENSE)

Signal-first asynchronous state management for Angular — querying, caching, and
mutations built entirely on Angular Signals. Inspired by
[TanStack Query](https://tanstack.com/query), reimagined for the signal era: no
`Observable` subscriptions to manage, just signals you read in templates.

> ⚠️ Pre-1.0 — the API may still change between minor versions.

## Features

- 🚦 **Signal-native** — query state is exposed as signals (`data()`, `status()`, …), no manual subscriptions.
- 🗄️ **Caching & deduplication** — identical query keys share a single in-flight request and cache entry.
- ✏️ **Mutations** — with `onMutate` / `onSuccess` / `onError` lifecycle for optimistic updates.
- 🔁 **Retries & polling** — configurable `retry` and `refetchInterval`.
- 🌍 **Global indicators** — `injectIsFetching()` / `injectIsMutating()` for app-wide loading state.
- 🪶 **Lean** — ESM, `sideEffects: false`, no runtime deps beyond `tslib`.

## Installation

```bash
npm install ngx-signal-query
```

Requires **Angular 20+** (`@angular/core` and `@angular/common` are peer dependencies).

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

## Mutations

```ts
import {
  mutationOptions,
  injectMutation,
  injectQueryClient,
} from 'ngx-signal-query'

const client = injectQueryClient()

const addTodo = injectMutation(() =>
  mutationOptions({
    mutationFn: (title: string) => http.post<Todo>('/api/todos', { title }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['todos'] }),
  }),
)

// in a template
// <button (click)="addTodo.mutate('Buy milk')" [disabled]="addTodo.isPending()">Add</button>
```

## Documentation

📖 Full guides and API reference — **coming soon** (documentation site is in progress).

## License

[MIT](./LICENSE)
