import { HttpClient } from '@angular/common/http'
import { Injectable, inject, signal } from '@angular/core'
import { type Observable, defer, delay, map, of, throwError } from 'rxjs'

import type { AddTodoVars, Backend, DummyTodo, Todo } from './todos.types'

const API = 'https://dummyjson.com/todos'

/**
 * Two interchangeable backends behind one interface.
 *
 * dummyjson's `?delay=` param gives us controllable latency on real HTTP, which
 * is what makes both the race and the cancellation observable.
 *
 * Note: its POST is a stub — it echoes back a created todo but never persists
 * it. So the demo reconciles the optimistic row with the response rather than
 * refetching the list.
 */
@Injectable({ providedIn: 'root' })
export class TodosApi {
  readonly backend = signal<Backend>('real')

  /** Flip to make the next write fail — for testing onError and rollback. */
  readonly shouldFail = signal(false)

  readonly #http = inject(HttpClient)

  #nextFakeId = 100
  #fakeTodos: Todo[] = [
    { id: 1, title: 'Read the docs' },
    { id: 2, title: 'Try a mutation' },
  ]

  public list(): Observable<Todo[]> {
    if (this.backend() === 'fake') {
      return of(this.#fakeTodos.map((todo) => ({ ...todo }))).pipe(delay(400))
    }

    return this.#http
      .get<{ todos: DummyTodo[] }>(`${API}?limit=5&delay=400`)
      .pipe(map(({ todos }) => todos.map(toTodo)))
  }

  public add({ title, delayMs }: AddTodoVars): Observable<Todo> {
    // defer: the body runs on subscribe, so each retry gets a fresh attempt.
    return defer(() => {
      if (this.shouldFail()) {
        return throwError(() => new Error(`Server refused "${title}"`))
      }

      if (this.backend() === 'fake') {
        const created: Todo = { id: this.#nextFakeId++, title }

        this.#fakeTodos = [...this.#fakeTodos, created]

        return of(created).pipe(delay(delayMs))
      }

      return this.#http
        .post<DummyTodo>(`${API}/add?delay=${delayMs}`, {
          todo: title,
          completed: false,
          userId: 1,
        })
        .pipe(map(toTodo))
    })
  }
}

function toTodo({ id, todo }: DummyTodo): Todo {
  return { id, title: todo }
}
