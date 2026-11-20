// Type tests for injectInfiniteQuery: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import {
  infiniteQueryOptions,
  injectInfiniteQuery,
  keepPreviousData,
  type InfiniteData,
  type QueryKey,
} from 'ngx-signal-query'

type Todo = { id: number; title: string }
type TodoPage = { todos: Todo[]; nextCursor: number | null }

declare const http: HttpClient
declare const filter: () => string

// data() holds the pages and their params, typed from the options.
const todos = injectInfiniteQuery(() => ({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
}))

expectTypeOf(todos.data()).toEqualTypeOf<
  InfiniteData<TodoPage, number> | undefined
>()
expectTypeOf(todos.error()).toEqualTypeOf<Error | null>()
expectTypeOf(todos.isFetched()).toEqualTypeOf<boolean>()
expectTypeOf(todos.isFetchedAfterMount()).toEqualTypeOf<boolean>()

// A Promise page, and a key with `as const`, whose type the query function
// gets.
injectInfiniteQuery(() => ({
  queryKey: ['todos', filter()] as const,
  queryFn: async ({ queryKey, pageParam, signal }) => {
    expectTypeOf(queryKey).toEqualTypeOf<readonly ['todos', string]>()

    const response = await fetch(
      `/api/todos?filter=${queryKey[1]}&cursor=${pageParam}`,
      { signal },
    )

    return (await response.json()) as TodoPage
  },
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  placeholderData: keepPreviousData,
}))

// A definition made with infiniteQueryOptions, spread with more options.
const definition = infiniteQueryOptions({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})
const fromDefinition = injectInfiniteQuery(() => ({
  ...definition,
  enabled: filter() !== '',
}))

expectTypeOf(fromDefinition.data()).toEqualTypeOf<
  InfiniteData<TodoPage, number> | undefined
>()

// The generics written out, the page type first, as for injectQuery.
const typed = injectInfiniteQuery<TodoPage, Error, QueryKey, number>(() => ({
  queryKey: ['todos'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
}))

expectTypeOf(typed.data()).toEqualTypeOf<
  InfiniteData<TodoPage, number> | undefined
>()

// The page fields: signals, and functions whose promise gives the data and
// the error, as refetch() does.
expectTypeOf(todos.hasNextPage()).toEqualTypeOf<boolean>()
expectTypeOf(todos.hasPreviousPage()).toEqualTypeOf<boolean>()
expectTypeOf(todos.isFetchingNextPage()).toEqualTypeOf<boolean>()
expectTypeOf(todos.isFetchingPreviousPage()).toEqualTypeOf<boolean>()
expectTypeOf(todos.isFetchNextPageError()).toEqualTypeOf<boolean>()
expectTypeOf(todos.isFetchPreviousPageError()).toEqualTypeOf<boolean>()
expectTypeOf(todos.fetchNextPage).returns.resolves.toEqualTypeOf<{
  data: InfiniteData<TodoPage, number> | undefined
  error: Error | null
}>()
expectTypeOf(todos.fetchPreviousPage).returns.resolves.toEqualTypeOf<{
  data: InfiniteData<TodoPage, number> | undefined
  error: Error | null
}>()
expectTypeOf(todos.fetchNextPage).parameters.toEqualTypeOf<[]>()
