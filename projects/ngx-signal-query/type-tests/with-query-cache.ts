// Type tests for withQueryCache and a query's meta: compiled by
// `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { ErrorHandler, inject } from '@angular/core'
import { expectTypeOf } from 'expect-type'
import {
  infiniteQueryOptions,
  injectInfiniteQuery,
  injectQueries,
  injectQuery,
  queryOptions,
  withQueryCache,
  type QueryClient,
  type QueryKey,
  type QueryMeta,
  type QuerySnapshot,
  type QueryState,
} from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }
type TodoPage = { todos: Todo[]; nextCursor: number | null }

declare const http: HttpClient
declare const client: QueryClient
declare const ids: number[]

// Without a type declared on Register, meta is any plain object.
expectTypeOf<QueryMeta>().toEqualTypeOf<Record<string, unknown>>()

// The callbacks

// Each gets the query as a snapshot. One callback serves every query, so the
// data and the error are unknown.
withQueryCache({
  onSuccess: (data, query) => {
    expectTypeOf(data).toBeUnknown()
    expectTypeOf(query).toEqualTypeOf<QuerySnapshot>()
  },
  onError: (error, query) => {
    expectTypeOf(error).toBeUnknown()
    expectTypeOf(query).toEqualTypeOf<QuerySnapshot>()
  },
  onSettled: (data, error, query) => {
    expectTypeOf(data).toBeUnknown()
    expectTypeOf(error).toBeUnknown()
    expectTypeOf(query).toEqualTypeOf<QuerySnapshot>()
  },
})

// The snapshot holds the key, its hash, the state and the meta.
withQueryCache({
  onError: (_error, query) => {
    expectTypeOf(query.queryKey).toEqualTypeOf<QueryKey>()
    expectTypeOf(query.queryHash).toEqualTypeOf<string>()
    expectTypeOf(query.state).toEqualTypeOf<
      Readonly<QueryState<unknown, unknown>>
    >()
    expectTypeOf(query.meta).toEqualTypeOf<
      Record<string, unknown> | undefined
    >()
  },
})

// It's read-only, its state too: a write there would change the query's
// state behind its back.
withQueryCache({
  onError: (_error, query) => {
    // @ts-expect-error -- the snapshot can't be changed
    query.meta = {}
    // @ts-expect-error -- nor can its state
    query.state.status = 'success'
  },
})

// A callback may call inject() and return a promise.
withQueryCache({
  onError: async (error) => {
    const errorHandler = inject(ErrorHandler)

    await Promise.resolve()
    errorHandler.handleError(error)
  },
})

// A query's meta

// Every place that takes a query's options takes meta.
queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  meta: { errorMessage: 'Could not load the todos' },
})

infiniteQueryOptions({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  meta: { errorMessage: 'Could not load the todos' },
})

injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  meta: { silent: true },
}))

injectInfiniteQuery(() => ({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  meta: { silent: true },
}))

injectQueries(() => ({
  queries: ids.map((id) => ({
    queryKey: ['todo', id],
    queryFn: () => http.get<Todo>(`/api/todos/${id}`),
    meta: { silent: true },
  })),
}))

client.query({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  meta: { silent: true },
})

client.infiniteQuery({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  meta: { silent: true },
})

client.fetchQuery(['todos'], () => http.get<Todo[]>('/api/todos'), {
  meta: { silent: true },
})

// meta is an object.
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- a string isn't an object
  meta: 'silent',
}))
