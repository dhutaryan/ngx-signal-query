Install the package with your favorite package manager:

```bash
npm install ngx-signal-query
```

```bash
pnpm add ngx-signal-query
```

```bash
yarn add ngx-signal-query
```

Requires **Angular 19+** — `@angular/core` is the only peer dependency. There
are no other runtime dependencies beyond `tslib`.

## 1. Provide the query client

Register the query client once, at the root of your application:

```ts
// app.config.ts
import { ApplicationConfig } from '@angular/core'
import { provideHttpClient } from '@angular/common/http'
import { provideQueryClient } from 'ngx-signal-query'

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(), provideQueryClient()],
}
```

## 2. Fetch data in a component

`injectQuery` returns signals — read them straight from the template, no
subscriptions required. The `queryFn` can return an `Observable`, so
`HttpClient` works as-is:

{% raw %}

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
  readonly #http = inject(HttpClient)

  protected readonly todos = injectQuery(() => ({
    queryKey: ['todos'],
    queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  }))
}
```

{% endraw %}

## 3. Mutate and reconcile the cache

`injectMutation` works the same way. Call `mutate()` to run it, read
`isPending()` / `status()` as signals, and use `injectQueryClient()` to
invalidate affected queries once it succeeds:

{% raw %}

```ts
import { Component, inject } from '@angular/core'
import { HttpClient } from '@angular/common/http'
import { injectMutation, injectQueryClient } from 'ngx-signal-query'

type Todo = { id: number; title: string }

@Component({
  selector: 'app-add-todo',
  template: `
    <button (click)="add('Buy milk')" [disabled]="addTodo.isPending()">
      Add todo
    </button>

    <p>status: {{ addTodo.status() }}</p>
  `,
})
export class AddTodoComponent {
  readonly #http = inject(HttpClient)
  readonly #client = injectQueryClient()

  protected readonly addTodo = injectMutation(() => ({
    mutationFn: (title: string) =>
      this.#http.post<Todo>('/api/todos', { title }),
    onSuccess: () => this.#client.invalidateQueries({ queryKey: ['todos'] }),
  }))

  protected add(title: string): void {
    this.addTodo.mutate(title)
  }
}
```

{% endraw %}

That's it — you're ready to go.
