// Type tests for injectQueries: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import {
  injectQueries,
  keepPreviousData,
  queryOptions,
  type QueryKey,
} from 'ngx-signal-query'

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
expectTypeOf(todos()[0].isFetched()).toEqualTypeOf<boolean>()
expectTypeOf(todos()[0].isFetchedAfterMount()).toEqualTypeOf<boolean>()

// queryFn's context

// An entry's query function gets its key as any key, and a signal.
injectQueries(() => ({
  queries: ids.map((id) => ({
    queryKey: ['todo', id],
    queryFn: ({ queryKey, signal }) => {
      expectTypeOf(queryKey).toEqualTypeOf<QueryKey>()
      expectTypeOf(signal).toEqualTypeOf<AbortSignal>()

      return http.get<Todo>(`/api/todos/${id}`)
    },
  })),
}))

// Definitions with typed keys fit as entries.
const todoQuery = (id: number) =>
  queryOptions({
    queryKey: ['todo', id] as const,
    queryFn: ({ queryKey: [, todoId] }) =>
      http.get<Todo>(`/api/todos/${todoId}`),
  })
const fromDefinitions = injectQueries(() => ({ queries: ids.map(todoQuery) }))

expectTypeOf(fromDefinitions()[0].data()).toEqualTypeOf<Todo | undefined>()
