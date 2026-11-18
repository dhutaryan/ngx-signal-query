// Type tests for QueryClient: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  type DefaultedQueryOptions,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }
type TodoPage = { todos: Todo[]; nextCursor: number | null }
type ApiError = { status: number }

declare const http: HttpClient
declare const id: number
declare const client: QueryClient
declare function shareEqual<T>(oldData: T | undefined, newData: T): T
declare const newTodo: Todo
declare const saved: Todo
// What onMutate returns for a rollback: the list as it was, if it was cached.
declare const context: { previous: Todo[] | undefined } | undefined

// fetchQuery with a generic merge function keeps the data type of queryFn.
const todos = client.fetchQuery(
  ['todos'],
  () => http.get<Todo[]>('/api/todos'),
  { structuralSharing: shareEqual },
)

expectTypeOf(todos).resolves.toEqualTypeOf<Todo[]>()

// An inline merge function gets both data with the data type.
client.fetchQuery(['todos'], () => http.get<Todo[]>('/api/todos'), {
  structuralSharing: (oldData, newData) => {
    expectTypeOf(oldData).toEqualTypeOf<Todo[] | undefined>()
    expectTypeOf(newData).toEqualTypeOf<Todo[]>()

    return newData
  },
})

// One that returns something other than the data is an error.
client.fetchQuery(['todos'], () => http.get<Todo[]>('/api/todos'), {
  // @ts-expect-error -- returns a number, not the data
  structuralSharing: (_oldData: Todo[] | undefined, newData: Todo[]) =>
    newData.length,
})

// One for another data type is an error at the option, not at queryFn.
const mistyped = client.fetchQuery(
  ['todos'],
  () => http.get<Todo[]>('/api/todos'),
  {
    // @ts-expect-error -- merges strings, not todos
    structuralSharing: (_oldData: string | undefined, newData: string) =>
      newData,
  },
)

expectTypeOf(mistyped).resolves.toEqualTypeOf<Todo[]>()

// setQueryData

// An updater gets the data the key holds, undefined while it holds none, and
// may return undefined to leave the cache as it is: it updates only what's
// cached.
client.setQueryData<Todo[]>(['todos'], (todos) => {
  expectTypeOf(todos).toEqualTypeOf<Todo[] | undefined>()

  return todos?.map((todo) => (todo.id === saved.id ? saved : todo))
})
client.setQueryData<Todo[]>(['todos'], (todos) => todos && [...todos, newTodo])
client.setQueryData<Todo[]>(['todos'], () => undefined)

// So may a value: a rollback with nothing to put back writes nothing.
client.setQueryData<Todo[]>(['todos'], context?.previous)

// A default still writes, seeding a key that holds nothing.
client.setQueryData<Todo[]>(['todos'], (todos = []) => [...todos, newTodo])

// Data of another type is an error, from an updater or as a value.
// @ts-expect-error -- returns a number, not the data
client.setQueryData<Todo[]>(['todos'], (todos) => todos?.length)
// @ts-expect-error -- a todo isn't the list
client.setQueryData<Todo[]>(['todos'], saved)

// So is null: only undefined leaves the cache as it is.
// @ts-expect-error -- null isn't the data
client.setQueryData<Todo[]>(['todos'], (todos) => todos ?? null)
// @ts-expect-error -- null isn't the data
client.setQueryData<Todo[]>(['todos'], null)

// An updater returns the new data: one that changes the data in place and
// returns nothing is an error.
// @ts-expect-error -- returns nothing
client.setQueryData<Todo[]>(['todos'], (todos) => {
  todos?.push(newTodo)
})

// fetchQuery's context

// The query function gets the key with the type the key has, and a signal.
client.fetchQuery(['todo', id] as const, ({ queryKey, signal }) => {
  expectTypeOf(queryKey).toEqualTypeOf<readonly ['todo', number]>()
  expectTypeOf(signal).toEqualTypeOf<AbortSignal>()

  return http.get<Todo>(`/api/todos/${queryKey[1]}`)
})

// A definition's key and query function go in together.
const todoQuery = queryOptions({
  queryKey: ['todo', id] as const,
  queryFn: ({ queryKey: [, todoId] }) => http.get<Todo>(`/api/todos/${todoId}`),
})

expectTypeOf(
  client.fetchQuery(todoQuery.queryKey, todoQuery.queryFn),
).resolves.toEqualTypeOf<Todo>()

// query()

// A definition goes in as it is, the options that only a component uses
// included, and the promise has its data type.
const list = queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  staleTime: 30_000,
  placeholderData: keepPreviousData,
})

expectTypeOf(client.query(list)).resolves.toEqualTypeOf<Todo[]>()

// So does one with an option changed for this call.
expectTypeOf(
  client.query({ ...list, staleTime: Infinity }),
).resolves.toEqualTypeOf<Todo[]>()

// Written in the call, its query function gets the key with the type the key
// has, and a signal.
client.query({
  queryKey: ['todo', id] as const,
  queryFn: ({ queryKey, signal }) => {
    expectTypeOf(queryKey).toEqualTypeOf<readonly ['todo', number]>()
    expectTypeOf(signal).toEqualTypeOf<AbortSignal>()

    return http.get<Todo>(`/api/todos/${queryKey[1]}`)
  },
})

// retry and retryDelay get the error with the query's error type.
const detail = queryOptions<Todo, ApiError>({
  queryKey: ['todo', id],
  queryFn: () => http.get<Todo>(`/api/todos/${id}`),
})

client.query({
  ...detail,
  retry: (failureCount, error) => {
    expectTypeOf(error).toEqualTypeOf<ApiError>()

    return failureCount < 2 && error.status !== 404
  },
  retryDelay: (_failureCount, error) => {
    expectTypeOf(error).toEqualTypeOf<ApiError>()

    return 1_000
  },
})
client.query({
  ...detail,
  // @ts-expect-error -- a typo in the error's field
  retry: (_failureCount, error) => error.statsu !== 404,
})

// An infinite list's definition doesn't fit: query() fetches a plain query.
const pages = infiniteQueryOptions({
  queryKey: ['todos', 'infinite'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

// @ts-expect-error -- an infinite list's definition
client.query(pages)

// The generics can be written out.
expectTypeOf(
  client.query<Todo>({
    queryKey: ['todo', id],
    queryFn: () => http.get<Todo>(`/api/todos/${id}`),
  }),
).resolves.toEqualTypeOf<Todo>()

// Written out, the generics leave the error type Error.
client.query<Todo>({
  queryKey: ['todo', id],
  queryFn: () => http.get<Todo>(`/api/todos/${id}`),
  retry: (_failureCount, error) => {
    expectTypeOf(error).toEqualTypeOf<Error>()

    return true
  },
})

// initialData goes in with the rest of the options.
expectTypeOf(client.query({ ...list, initialData: [] })).resolves.toEqualTypeOf<
  Todo[]
>()

// A query function is needed.
// @ts-expect-error -- no queryFn
client.query({ queryKey: ['todos'] })

// cancelRefetch is fetchQuery's, and there's no select.
// @ts-expect-error -- not an option of query()
client.query({ ...list, cancelRefetch: true })
// @ts-expect-error -- no select
client.query({ ...list, select: (todos: Todo[]) => todos.length })

// fetchQuery takes gcTime, as the client honours it, and only as a number.
client.fetchQuery(['todos'], () => http.get<Todo[]>('/api/todos'), {
  gcTime: 60_000,
})
client.fetchQuery(['todos'], () => http.get<Todo[]>('/api/todos'), {
  // @ts-expect-error -- not a number
  gcTime: '60000',
})

// infiniteQuery()

// A list's definition goes in as it is, the options that only a component
// uses included, and the promise has the list's type.
const todoList = infiniteQueryOptions({
  queryKey: ['todos', 'list'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  placeholderData: keepPreviousData,
})

expectTypeOf(client.infiniteQuery(todoList)).resolves.toEqualTypeOf<
  InfiniteData<TodoPage, number>
>()

// So does one with pages, or with an option changed for this call.
expectTypeOf(
  client.infiniteQuery({ ...todoList, pages: 3 }),
).resolves.toEqualTypeOf<InfiniteData<TodoPage, number>>()
expectTypeOf(
  client.infiniteQuery({ ...todoList, staleTime: Infinity }),
).resolves.toEqualTypeOf<InfiniteData<TodoPage, number>>()

// Written in the call, its query function gets the key with the type the key
// has, a signal and the page's param.
client.infiniteQuery({
  queryKey: ['todos', id] as const,
  queryFn: ({ queryKey, signal, pageParam }) => {
    expectTypeOf(queryKey).toEqualTypeOf<readonly ['todos', number]>()
    expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
    expectTypeOf(pageParam).toEqualTypeOf<number>()

    return http.get<TodoPage>(`/api/todos?user=${queryKey[1]}&c=${pageParam}`)
  },
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

// retry and retryDelay get the error with the list's error type.
const typedList = infiniteQueryOptions<TodoPage, ApiError, QueryKey, number>({
  queryKey: ['todos', 'list'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
})

client.infiniteQuery({
  ...typedList,
  retry: (failureCount, error) => {
    expectTypeOf(error).toEqualTypeOf<ApiError>()

    return failureCount < 2 && error.status !== 404
  },
  retryDelay: (_failureCount, error) => {
    expectTypeOf(error).toEqualTypeOf<ApiError>()

    return 1_000
  },
})

// The generics can be written out, the page type first.
expectTypeOf(
  client.infiniteQuery<TodoPage, Error, QueryKey, number>({
    queryKey: ['todos', 'list'],
    queryFn: ({ pageParam }) =>
      http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  }),
).resolves.toEqualTypeOf<InfiniteData<TodoPage, number>>()

// initialData is a list, not a page.
client.infiniteQuery({
  ...todoList,
  initialData: { pages: [{ todos: [], nextCursor: 20 }], pageParams: [0] },
})
client.infiniteQuery({
  ...todoList,
  // @ts-expect-error -- one page isn't the list
  initialData: { todos: [], nextCursor: null },
})

// A plain query's definition doesn't fit: it has no pages.
// @ts-expect-error -- a plain query's definition
client.infiniteQuery(list)

// getNextPageParam is needed: a stale list refetches the pages after the
// first with it.
// @ts-expect-error -- no getNextPageParam
client.infiniteQuery({
  queryKey: ['todos', 'list'],
  queryFn: ({ pageParam }: { pageParam: number }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
})

// pages is a number, and it's the call's, not an option of the definition.
// @ts-expect-error -- not a number
client.infiniteQuery({ ...todoList, pages: '3' })
infiniteQueryOptions({
  queryKey: ['todos', 'list'],
  queryFn: ({ pageParam }) =>
    http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  // @ts-expect-error -- not an option of a definition
  pages: 3,
})

// cancelRefetch is fetchQuery's, and there's no select.
// @ts-expect-error -- not an option of infiniteQuery()
client.infiniteQuery({ ...todoList, cancelRefetch: true })
// @ts-expect-error -- no select
client.infiniteQuery({ ...todoList, select: () => 0 })

// defaultQueryOptions()

// It fills in the defaults for any kind of query: the data type comes from
// the options, and so does what queryFn gives, the data itself or a page.
expectTypeOf(client.defaultQueryOptions(list)).toEqualTypeOf<
  DefaultedQueryOptions<Todo[], Error, Todo[]>
>()
expectTypeOf(client.defaultQueryOptions(todoList)).toEqualTypeOf<
  DefaultedQueryOptions<InfiniteData<TodoPage, number>, Error, TodoPage>
>()

// Written in the call, the options take the data type from queryFn.
expectTypeOf(
  client.defaultQueryOptions({
    queryKey: ['todos'],
    queryFn: () => http.get<Todo[]>('/api/todos'),
  }),
).toEqualTypeOf<DefaultedQueryOptions<Todo[], Error, Todo[]>>()
