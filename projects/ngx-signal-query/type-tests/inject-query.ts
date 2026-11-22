// Type tests for injectQuery: compiled by `pnpm test:types`, never run.
import type { HttpClient, HttpErrorResponse } from '@angular/common/http'
import type { Injector } from '@angular/core'
import { expectTypeOf } from 'expect-type'
import {
  injectQuery,
  keepPreviousData,
  queryOptions,
  withDefaultOptions,
  type DefinedQueryResult,
  type QueryKey,
  type QueryResult,
  type QueryStatus,
} from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }
type Ticket = { id: number; status: 'open' | 'done' }

declare const http: HttpClient
declare const id: number

// The data type comes from queryFn.
const todos = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
}))

expectTypeOf(todos.data()).toEqualTypeOf<Todo[] | undefined>()

// Whether a fetch has landed, at all or since the component started showing
// the query.
expectTypeOf(todos.isFetched()).toEqualTypeOf<boolean>()
expectTypeOf(todos.isFetchedAfterMount()).toEqualTypeOf<boolean>()

// initialData

// A seed that's always there gives the query data from its first read, so
// data() has no undefined in its type: a value, or a function whose return
// type leaves undefined out.
declare const savedTodos: Todo[]

const seeded = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  initialData: savedTodos,
}))

expectTypeOf(seeded.data()).toEqualTypeOf<Todo[]>()

const seededLazily = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  initialData: () => savedTodos,
}))

expectTypeOf(seededLazily.data()).toEqualTypeOf<Todo[]>()

// The same with a Promise queryFn, with keepPreviousData, and with the
// generics written out.
const seededAsync = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: async () => savedTodos,
  initialData: savedTodos,
}))

expectTypeOf(seededAsync.data()).toEqualTypeOf<Todo[]>()

const seededPage = injectQuery(() => ({
  queryKey: ['todos', 2],
  queryFn: () => http.get<Todo[]>('/api/todos?page=2'),
  initialData: savedTodos,
  placeholderData: keepPreviousData,
}))

expectTypeOf(seededPage.data()).toEqualTypeOf<Todo[]>()

const seededTyped = injectQuery<Todo[]>(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  initialData: savedTodos,
}))

expectTypeOf(seededTyped.data()).toEqualTypeOf<Todo[]>()

// The error type written out stays.
const seededWithError = injectQuery<Todo[], HttpErrorResponse>(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  initialData: savedTodos,
}))

expectTypeOf(seededWithError.data()).toEqualTypeOf<Todo[]>()
expectTypeOf(seededWithError.error()).toEqualTypeOf<HttpErrorResponse | null>()

// So does the defined data, with an injector given for a query made outside
// an injection context.
declare const injector: Injector

const seededWithInjector = injectQuery(
  () => ({
    queryKey: ['todos'],
    queryFn: () => http.get<Todo[]>('/api/todos'),
    initialData: savedTodos,
  }),
  { injector },
)

expectTypeOf(seededWithInjector.data()).toEqualTypeOf<Todo[]>()

// null seeds too: only undefined means no seed.
const noTodo = injectQuery(() => ({
  queryKey: ['todo', id],
  queryFn: () => http.get<Todo | null>(`/api/todos/${id}`),
  initialData: null,
}))

expectTypeOf(noTodo.data()).toEqualTypeOf<Todo | null>()

// A seed with fewer fields than queryFn's data widens the data type to the
// seed's, since initialData takes part in inferring it. Such a seed is always
// there too, so data() has no undefined. (The docs advise against seeding
// part of the data.)
const partlySeeded = injectQuery(() => ({
  queryKey: ['todo', 1],
  queryFn: () => http.get<Todo>('/api/todos/1'),
  initialData: { id: 1 },
}))

expectTypeOf(partlySeeded.data()).toEqualTypeOf<{ id: number }>()

// A seed that may be undefined leaves undefined in: a function that may
// return it, such as a lookup in a list another query holds, or a value that
// may be undefined, such as one a condition picks.
declare const cachedTodos: Todo[] | undefined

const fromList = injectQuery(() => ({
  queryKey: ['todo', id],
  queryFn: () => http.get<Todo>(`/api/todos/${id}`),
  initialData: () => cachedTodos?.find((todo) => todo.id === id),
}))

expectTypeOf(fromList.data()).toEqualTypeOf<Todo | undefined>()

const maybeSeeded = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  initialData: id > 0 ? savedTodos : undefined,
}))

expectTypeOf(maybeSeeded.data()).toEqualTypeOf<Todo[] | undefined>()

// Only data() changes: status() and the flags keep their types, so a check
// for 'pending' still compiles, and refetch() resolves with data that may be
// undefined, like any query's refetch().
expectTypeOf(seeded.status()).toEqualTypeOf<QueryStatus>()
expectTypeOf(seeded.isPending()).toEqualTypeOf<boolean>()
expectTypeOf(seeded.isLoading()).toEqualTypeOf<boolean>()
expectTypeOf(seeded.isPlaceholderData()).toEqualTypeOf<boolean>()
expectTypeOf(seeded.refetch).returns.resolves.toEqualTypeOf<{
  data: Todo[] | undefined
  error: Error | null
}>()

// Its type can be written out, and it fits where any query's result goes.
declare function showSaved(query: DefinedQueryResult<Todo[]>): void
declare function showAny(query: QueryResult<Todo[]>): void

showSaved(seeded)
showAny(seeded)

// A seed or a placeholder that doesn't fit is an error at the option.
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- a seed of another type
  initialData: 'none',
}))

declare const savedTodo: Todo

injectQuery(() => ({
  queryKey: ['todo', 1],
  queryFn: () => http.get<Todo>('/api/todos/1'),
  initialData: savedTodo,
  // @ts-expect-error -- a placeholder missing fields
  placeholderData: { id: 1 },
}))

// placeholderData

// keepPreviousData keeps the data type of queryFn.
const page = injectQuery(() => ({
  queryKey: ['todos', 2],
  queryFn: () => http.get<Todo[]>('/api/todos?page=2'),
  placeholderData: keepPreviousData,
}))

expectTypeOf(page.data()).toEqualTypeOf<Todo[] | undefined>()

// So does a definition spread with it, as when overriding per component.
const todosQuery = queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
})
const pageFromDefinition = injectQuery(() => ({
  ...todosQuery,
  placeholderData: keepPreviousData,
}))

expectTypeOf(pageFromDefinition.data()).toEqualTypeOf<Todo[] | undefined>()

// A placeholder function gets the previous data with the data type.
const previous = injectQuery(() => ({
  queryKey: ['todos', 2],
  queryFn: () => http.get<Todo[]>('/api/todos?page=2'),
  placeholderData: (previousData) => {
    expectTypeOf(previousData).toEqualTypeOf<Todo[] | undefined>()

    return previousData
  },
}))

expectTypeOf(previous.data()).toEqualTypeOf<Todo[] | undefined>()

// A placeholder that fits the data type is taken as it is.
const preview = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  placeholderData: [{ id: 1, title: 'Buy milk', done: false }],
}))

expectTypeOf(preview.data()).toEqualTypeOf<Todo[] | undefined>()

// A placeholder that doesn't fit is an error, not a wider data type.
injectQuery(() => ({
  queryKey: ['todo', 1],
  queryFn: () => http.get<Todo>('/api/todos/1'),
  // @ts-expect-error -- a placeholder missing fields
  placeholderData: { id: 1 },
}))

// So is a placeholder function returning a narrower type.
declare const rows: Array<{ id: number; title: string }>

injectQuery(() => ({
  queryKey: ['todo', 1],
  queryFn: () => http.get<Todo>('/api/todos/1'),
  // @ts-expect-error -- a list row has fewer fields than the todo
  placeholderData: () => rows.find((row) => row.id === 1),
}))

// A placeholder that can be null is an error: null would show as the data.
declare const cached: Todo[] | null

injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- null isn't the data type
  placeholderData: cached,
}))

// So is a placeholder function returning null: undefined means none.
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- return undefined for no placeholder
  placeholderData: () => null,
}))

// An inline placeholder with a literal-typed field fits with satisfies.
const ticket = injectQuery(() => ({
  queryKey: ['ticket', 1],
  queryFn: () => http.get<Ticket>('/api/tickets/1'),
  placeholderData: { id: 1, status: 'open' } satisfies Ticket,
}))

expectTypeOf(ticket.data()).toEqualTypeOf<Ticket | undefined>()

// structuralSharing

// A generic merge function keeps the data type of queryFn...
declare function shareEqual<T>(oldData: T | undefined, newData: T): T

const shared = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  structuralSharing: shareEqual,
}))

expectTypeOf(shared.data()).toEqualTypeOf<Todo[] | undefined>()

// ...and fits withDefaultOptions too.
withDefaultOptions({ queries: { structuralSharing: shareEqual } })

// An inline merge function gets both data with the data type.
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  structuralSharing: (oldData, newData) => {
    expectTypeOf(oldData).toEqualTypeOf<Todo[] | undefined>()
    expectTypeOf(newData).toEqualTypeOf<Todo[]>()

    return newData
  },
}))

// One that returns something other than the data is an error.
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- returns a number, not the data
  structuralSharing: (_oldData: Todo[] | undefined, newData: Todo[]) =>
    newData.length,
}))

// So is one that may return undefined: the query would hold no data.
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- may return undefined
  structuralSharing: (oldData, newData) => (newData.length ? newData : oldData),
}))

// One for another data type is an error at the option, not at queryFn.
const mistyped = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- merges strings, not todos
  structuralSharing: (_oldData: string | undefined, newData: string) => newData,
}))

// The data type stays queryFn's. A call with an error takes the type of
// injectQuery's first signature, the one for a seed that's always there, so
// the check leaves undefined out.
expectTypeOf(mistyped.data()).exclude<undefined>().toEqualTypeOf<Todo[]>()

// queryFn's context

// The query function gets the key with the type queryKey has, and a signal,
// and the data type still comes from what it returns.
const todo = injectQuery(() => ({
  queryKey: ['todo', id] as const,
  queryFn: ({ queryKey, signal }) => {
    expectTypeOf(queryKey).toEqualTypeOf<readonly ['todo', number]>()
    expectTypeOf(signal).toEqualTypeOf<AbortSignal>()

    return http.get<Todo>(`/api/todos/${queryKey[1]}`)
  },
}))

expectTypeOf(todo.data()).toEqualTypeOf<Todo | undefined>()

// With the generics written out, the key is any key.
injectQuery<Todo>(() => ({
  queryKey: ['todo', id],
  queryFn: ({ queryKey }) => {
    expectTypeOf(queryKey).toEqualTypeOf<QueryKey>()

    return http.get<Todo>(`/api/todos/${id}`)
  },
}))
