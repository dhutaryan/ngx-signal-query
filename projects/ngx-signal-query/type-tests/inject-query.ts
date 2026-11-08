// Type tests for injectQuery: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import {
  injectQuery,
  keepPreviousData,
  queryOptions,
  withDefaultOptions,
} from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }
type Ticket = { id: number; status: 'open' | 'done' }

declare const http: HttpClient

// The data type comes from queryFn.
const todos = injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
}))

expectTypeOf(todos.data()).toEqualTypeOf<Todo[] | undefined>()

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

expectTypeOf(mistyped.data()).toEqualTypeOf<Todo[] | undefined>()
