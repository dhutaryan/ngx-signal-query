// Type tests for declaration files: compiled by `pnpm test:types` with
// `declaration: true`, never run. A library that exports query definitions,
// such as an Angular library built with ng-packagr, emits declaration files
// for them, and each type they use has to be one those files can name: an
// error here (TS4023) means a library like that doesn't build.
import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { infiniteQueryOptions, queryOptions } from 'ngx-signal-query'

export type Todo = { id: number; title: string }
export type TodoPage = { todos: Todo[]; nextCursor: number | null }

declare const http: HttpClient

// A definition, with its key as written or `as const`.
export const todos = queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
})
export const todo = (id: number) =>
  queryOptions({
    queryKey: ['todo', id] as const,
    queryFn: () => http.get<Todo>(`/api/todos/${id}`),
  })

// An infinite list's.
export const todoPages = infiniteQueryOptions({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

// A key on its own, and a definition with an option changed.
export const todosKey = todos.queryKey
export const freshTodos = { ...todos, staleTime: 60_000 }

// A service whose methods return definitions, as the docs keep queries.
@Injectable({ providedIn: 'root' })
export class TodoQueries {
  readonly #http = inject(HttpClient)

  detail(id: number) {
    return queryOptions({
      queryKey: ['todos', 'detail', id],
      queryFn: () => this.#http.get<Todo>(`/api/todos/${id}`),
    })
  }
}
