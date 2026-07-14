import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import {
  injectMutation,
  injectQuery,
  injectQueryClient,
} from 'ngx-signal-query'

import { Log } from '../../core/log/log'
import { TodosApi } from '../todos-api'
import { TodoQueries } from '../todos.queries'
import type { AddTodoVars, Todo } from '../todos.types'

@Component({
  selector: 'app-mutation-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mutation-demo.html',
  styleUrl: './mutation-demo.scss',
})
export class MutationDemo {
  readonly #api = inject(TodosApi)
  readonly #queries = inject(TodoQueries)
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)

  protected readonly todos = injectQuery(() => this.#queries.list())

  protected readonly addTodo = injectMutation(() => ({
    mutationFn: (vars: AddTodoVars) => this.#api.add(vars),

    // Optimistic insert. What this returns becomes `context` for the hooks
    // below — that's how the rollback gets its snapshot back.
    onMutate: (vars: AddTodoVars) => {
      this.#log.add(`onMutate("${vars.title}")`)

      const key = this.#queries.list().queryKey
      const previous = this.#client.getQueryData<Todo[]>(key) ?? []
      const tempId = -Date.now()

      this.#client.setQueryData<Todo[]>(key, (todos = []) => [
        ...todos,
        { id: tempId, title: vars.title },
      ])

      return { previous, tempId }
    },

    onSuccess: (created, vars, context) => {
      this.#log.add(`onSuccess("${vars.title}") → id ${created.id}`)

      // dummyjson doesn't persist, so swap the optimistic row for the server's
      // reply rather than invalidating (which would just drop it).
      this.#client.setQueryData<Todo[]>(
        this.#queries.list().queryKey,
        (todos = []) =>
          todos.map((todo) => (todo.id === context?.tempId ? created : todo)),
      )
    },

    onError: (error, vars, context) => {
      this.#log.add(`onError("${vars.title}") — ${error.message}`)

      if (context) {
        this.#client.setQueryData<Todo[]>(
          this.#queries.list().queryKey,
          context.previous,
        )
      }
    },

    onSettled: (_data, _error, vars) => {
      this.#log.add(`onSettled("${vars.title}")`)
    },
  }))

  protected addOne(): void {
    this.#log.add('mutate("one")', 'ui')
    this.addTodo.mutate({ title: `one @ ${stamp()}`, delayMs: 1000 })
  }

  /**
   * Two calls, back to back. The slow one goes first, so the fast one is the
   * last thing you asked for — but it isn't necessarily what you end up with.
   */
  protected race(): void {
    this.#log.add('mutate("SLOW 3s") then mutate("FAST 500ms")', 'ui')
    this.addTodo.mutate({ title: `SLOW @ ${stamp()}`, delayMs: 3000 })
    this.addTodo.mutate({ title: `FAST @ ${stamp()}`, delayMs: 500 })
  }
}

function stamp(): string {
  return new Date().toLocaleTimeString()
}
