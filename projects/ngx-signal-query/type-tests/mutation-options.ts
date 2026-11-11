// Type tests for mutationOptions: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import { injectMutation, mutationOptions } from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

declare const http: HttpClient
declare const todos: Todo[] | undefined

// A definition gets its types as one written inline does: the variables,
// the data, and what onMutate returns as context.
const add = mutationOptions({
  mutationFn: (title: string) => http.post<Todo>('/api/todos', { title }),
  onMutate: (title) => {
    expectTypeOf(title).toEqualTypeOf<string>()

    return { previous: todos }
  },
  onSuccess: (data) => {
    expectTypeOf(data).toEqualTypeOf<Todo>()
  },
  onError: (_error, _title, context) => {
    expectTypeOf(context).toEqualTypeOf<
      { previous: Todo[] | undefined } | undefined
    >()
  },
})

injectMutation(() => add)
