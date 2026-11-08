// Type tests for injectQuery: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import { injectQuery } from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

declare const http: HttpClient

// The data type comes from queryFn.
const todos = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
}))

expectTypeOf(todos.data()).toEqualTypeOf<Todo[] | undefined>()
