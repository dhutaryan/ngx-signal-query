// Type tests for injectQueries: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import { injectQueries, keepPreviousData } from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

declare const http: HttpClient
declare const ids: number[]

// Entries with keepPreviousData keep the data type of queryFn.
const todos = injectQueries(() => ({
  queries: ids.map((id) => ({
    queryKey: ['todo', id],
    queryFn: () => http.get<Todo>(`/api/todos/${id}`),
    placeholderData: keepPreviousData,
  })),
}))

expectTypeOf(todos()[0].data()).toEqualTypeOf<Todo | undefined>()
