// Type tests for queryOptions: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import { injectQuery, keepPreviousData, queryOptions } from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

declare const http: HttpClient

// A definition with keepPreviousData keeps the data type of queryFn.
const page = queryOptions({
  queryKey: ['todos', 2],
  queryFn: () => http.get<Todo[]>('/api/todos?page=2'),
  placeholderData: keepPreviousData,
})
const todos = injectQuery(() => page)

expectTypeOf(todos.data()).toEqualTypeOf<Todo[] | undefined>()
