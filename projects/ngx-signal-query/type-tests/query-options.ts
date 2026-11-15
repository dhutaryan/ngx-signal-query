// Type tests for queryOptions: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import {
  injectQuery,
  keepPreviousData,
  queryOptions,
  type QueryFunction,
  type QueryKey,
  type QueryOptions,
} from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

declare const http: HttpClient
declare const id: number

// A definition with keepPreviousData keeps the data type of queryFn.
const page = queryOptions({
  queryKey: ['todos', 2],
  queryFn: () => http.get<Todo[]>('/api/todos?page=2'),
  placeholderData: keepPreviousData,
})
const todos = injectQuery(() => page)

expectTypeOf(todos.data()).toEqualTypeOf<Todo[] | undefined>()

// queryFn's context

// The query function gets the key with the type queryKey has, and a signal.
queryOptions({
  queryKey: ['todo', id] as const,
  queryFn: ({ queryKey, signal }) => {
    expectTypeOf(queryKey).toEqualTypeOf<readonly ['todo', number]>()
    expectTypeOf(signal).toEqualTypeOf<AbortSignal>()

    return http.get<Todo>(`/api/todos/${queryKey[1]}`)
  },
})

// Without `as const`, a key written inline is an array of its elements.
queryOptions({
  queryKey: ['todo', id],
  queryFn: ({ queryKey }) => {
    expectTypeOf(queryKey).toEqualTypeOf<Array<string | number>>()

    return http.get<Todo>(`/api/todos/${queryKey[1]}`)
  },
})

// With the generics written out, the key is any key.
queryOptions<Todo>({
  queryKey: ['todo', id],
  queryFn: ({ queryKey }) => {
    expectTypeOf(queryKey).toEqualTypeOf<QueryKey>()

    return http.get<Todo>(`/api/todos/${id}`)
  },
})

// A query function that takes no context fits as before, but calling a
// definition's query function takes one, as the query passes it.
const list = queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
})

// @ts-expect-error -- no context
list.queryFn()
list.queryFn({ queryKey: list.queryKey, signal: new AbortController().signal })

// A function with a parameter of its own is an error: it would get the
// context as that parameter.
declare function getTodos(params?: { page?: number }): Promise<Todo[]>

// @ts-expect-error -- the context isn't its params
queryOptions({ queryKey: ['todos'], queryFn: getTodos })

// A definition with a typed key fits where any key is expected, such as a
// helper typed with QueryOptions.
const detail = queryOptions({
  queryKey: ['todo', id] as const,
  queryFn: ({ queryKey: [, todoId] }) => http.get<Todo>(`/api/todos/${todoId}`),
})
const withStaleTime = <TData>(
  options: QueryOptions<TData>,
): QueryOptions<TData> => ({ ...options, staleTime: 60_000 })
const fresh = injectQuery(() => withStaleTime(detail))

expectTypeOf(fresh.data()).toEqualTypeOf<Todo | undefined>()

// The definition keeps the type of its key.
expectTypeOf(detail.queryKey).toEqualTypeOf<readonly ['todo', number]>()

// A query function typed for one key fits that key, and not another.
const fetchTodo: QueryFunction<Todo, readonly ['todo', number]> = ({
  queryKey: [, todoId],
  signal,
}) =>
  fetch(`/api/todos/${todoId}`, { signal }).then(
    (response) => response.json() as Promise<Todo>,
  )

queryOptions({ queryKey: ['todo', id] as const, queryFn: fetchTodo })
// @ts-expect-error -- written for a todo's key
queryOptions({ queryKey: ['user', 'ann'] as const, queryFn: fetchTodo })
