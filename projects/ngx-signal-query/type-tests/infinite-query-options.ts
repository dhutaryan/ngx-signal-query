// Type tests for infiniteQueryOptions: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import type { Observable } from 'rxjs'
import {
  infiniteQueryOptions,
  keepPreviousData,
  type InfiniteData,
  type InfiniteQueryOptions,
  type QueryKey,
} from 'ngx-signal-query'

type Todo = { id: number; title: string }
type TodoPage = { todos: Todo[]; nextCursor: number | null }

declare const http: HttpClient
declare const userId: number

// The page type comes from queryFn, the param type from initialPageParam.
const todos = infiniteQueryOptions({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) => {
    expectTypeOf(pageParam).toEqualTypeOf<number>()

    return http.get<TodoPage>(`/api/todos?cursor=${pageParam}`)
  },
  initialPageParam: 0,
  getNextPageParam: (lastPage, allPages, lastPageParam, allPageParams) => {
    expectTypeOf(lastPage).toEqualTypeOf<TodoPage>()
    expectTypeOf(allPages).toEqualTypeOf<TodoPage[]>()
    expectTypeOf(lastPageParam).toEqualTypeOf<number>()
    expectTypeOf(allPageParams).toEqualTypeOf<number[]>()

    return lastPage.nextCursor
  },
})

expectTypeOf(todos).toEqualTypeOf<
  InfiniteQueryOptions<TodoPage, Error, string[], number>
>()

// The query function gets the key with the type queryKey has, a signal and
// the page's param, and nothing else: no direction.
infiniteQueryOptions({
  queryKey: ['todos', userId] as const,
  queryFn: (context) => {
    const { queryKey, signal, pageParam } = context

    expectTypeOf<keyof typeof context>().toEqualTypeOf<
      'queryKey' | 'signal' | 'pageParam'
    >()
    expectTypeOf(queryKey).toEqualTypeOf<readonly ['todos', number]>()
    expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
    expectTypeOf(pageParam).toEqualTypeOf<string>()

    return http.get<TodoPage>(`/api/users/${queryKey[1]}/todos?${pageParam}`)
  },
  initialPageParam: '',
  getNextPageParam: (lastPage) => lastPage.nextCursor?.toString(),
})

// A cursor of another type than initialPageParam's is an error.
infiniteQueryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<TodoPage>('/api/todos'),
  initialPageParam: 0,
  // @ts-expect-error -- a string cursor where the param is a number
  getNextPageParam: (lastPage) => String(lastPage.nextCursor),
})

// A first page asked for with no cursor: the param type is written out, as
// null alone would be the param's whole type.
const feed = infiniteQueryOptions({
  queryKey: ['feed'],
  queryFn: ({ pageParam }) => {
    expectTypeOf(pageParam).toEqualTypeOf<string | null>()

    return http.get<{ items: string[]; next: string | null }>(
      `/api/feed?after=${pageParam ?? ''}`,
    )
  },
  initialPageParam: null as string | null,
  getNextPageParam: (lastPage) => lastPage.next,
})

expectTypeOf(feed.initialPageParam).toEqualTypeOf<string | null>()

// Both directions, with maxPages.
infiniteQueryOptions({
  queryKey: ['todos', 'window'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  getPreviousPageParam: (firstPage, allPages, firstPageParam) => {
    expectTypeOf(firstPage).toEqualTypeOf<TodoPage>()
    expectTypeOf(firstPageParam).toEqualTypeOf<number>()

    return firstPageParam > 0 ? firstPageParam - 20 : null
  },
  maxPages: 3,
})

// initialData, placeholderData and structuralSharing have the pages' type.
infiniteQueryOptions({
  queryKey: ['todos', 'seeded'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  initialData: { pages: [{ todos: [], nextCursor: 20 }], pageParams: [0] },
  placeholderData: keepPreviousData,
  structuralSharing: (oldData, newData) => {
    expectTypeOf(oldData).toEqualTypeOf<
      InfiniteData<TodoPage, number> | undefined
    >()

    return newData
  },
})

infiniteQueryOptions({
  queryKey: ['todos', 'seeded'],
  queryFn: () => http.get<TodoPage>('/api/todos'),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  // @ts-expect-error -- one page isn't the pages
  initialData: { todos: [], nextCursor: null },
})

// A query function that takes no context fits.
const plain: () => Observable<TodoPage> = () => http.get<TodoPage>('/api/todos')

infiniteQueryOptions({
  queryKey: ['todos'],
  queryFn: plain,
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

// A definition with a typed key fits where any key is expected, such as a
// helper typed with InfiniteQueryOptions.
declare function withAnyKey(
  options: InfiniteQueryOptions<TodoPage, Error, QueryKey, number>,
): void

withAnyKey(todos)
