// Type tests for queryOptions: compiled by `pnpm test:types`, never run.
import type { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import { of } from 'rxjs'
import {
  injectQueries,
  injectQuery,
  keepPreviousData,
  queryOptions,
  type DataTag,
  type DefinedInitialDataOptions,
  type QueryClient,
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
// A key written out fits as well, as a test might pass one.
list.queryFn({ queryKey: ['todos'], signal: new AbortController().signal })

// So does a definition written out, as a test's stub of one: Jasmine's
// `and.returnValue()` takes the type that the stubbed method returns.
declare function returnValue(stub: typeof list): void

returnValue({ queryKey: ['todos'], queryFn: () => of([]) })

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

// The definition keeps the type of its key, which carries the data type.
expectTypeOf(detail.queryKey).toEqualTypeOf<
  DataTag<readonly ['todo', number], Todo>
>()

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

// initialData

// A definition whose seed is always there says so in its type, and the query
// made of it has data from its first read.
declare const savedTodos: Todo[]

const seededList = queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  initialData: savedTodos,
})

expectTypeOf(seededList).toEqualTypeOf<
  DefinedInitialDataOptions<Todo[], Error, DataTag<string[], Todo[]>>
>()
expectTypeOf(injectQuery(() => seededList).data()).toEqualTypeOf<Todo[]>()

// It keeps an error type written out, and so does the query made of it.
const seededWithError = queryOptions<Todo[], HttpErrorResponse>({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  initialData: savedTodos,
})

expectTypeOf(
  injectQuery(() => seededWithError).error(),
).toEqualTypeOf<HttpErrorResponse | null>()

// Spread with other options, it keeps the seed, unless they set initialData
// to undefined.
expectTypeOf(
  injectQuery(() => ({ ...seededList, staleTime: 60_000 })).data(),
).toEqualTypeOf<Todo[]>()
expectTypeOf(
  injectQuery(() => ({ ...seededList, initialData: undefined })).data(),
).toEqualTypeOf<Todo[] | undefined>()

// Either of two definitions, one of them without a seed, may have no data.
declare const showSaved: boolean

expectTypeOf(
  injectQuery(() => (showSaved ? seededList : list)).data(),
).toEqualTypeOf<Todo[] | undefined>()

// A seed that may be undefined leaves the data type as queryFn gives it: a
// merge function gets a todo, not one that may be undefined, and the query
// made of the definition may have no data.
declare const cachedTodos: Todo[] | undefined

const seededFromList = queryOptions({
  queryKey: ['todo', id],
  queryFn: () => http.get<Todo>(`/api/todos/${id}`),
  initialData: () => cachedTodos?.find((todo) => todo.id === id),
  structuralSharing: (_oldData, newData) => {
    expectTypeOf(newData).toEqualTypeOf<Todo>()

    return newData
  },
})

expectTypeOf(injectQuery(() => seededFromList).data()).toEqualTypeOf<
  Todo | undefined
>()

// The same for a value that may be undefined.
queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  initialData: cachedTodos,
  structuralSharing: (_oldData, newData) => {
    expectTypeOf(newData).toEqualTypeOf<Todo[]>()

    return newData
  },
})

// A method with its return type written out keeps the seed with
// DefinedInitialDataOptions; with QueryOptions, data() may be undefined.
const savedList = (): DefinedInitialDataOptions<
  Todo[],
  Error,
  DataTag<QueryKey, Todo[]>
> => seededList
const anyList = (): QueryOptions<Todo[], Error, DataTag<QueryKey, Todo[]>> =>
  seededList

expectTypeOf(injectQuery(() => savedList()).data()).toEqualTypeOf<Todo[]>()
expectTypeOf(injectQuery(() => anyList()).data()).toEqualTypeOf<
  Todo[] | undefined
>()

// It goes wherever a definition does. injectQueries gives one result type
// for all its queries, data that may be undefined.
declare const client: QueryClient

expectTypeOf(client.query(seededList)).resolves.toEqualTypeOf<Todo[]>()

const both = injectQueries(() => ({ queries: [seededList, list] }))

expectTypeOf(both()[0].data()).toEqualTypeOf<Todo[] | undefined>()
