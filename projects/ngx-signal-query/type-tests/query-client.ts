// Type tests for QueryClient: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import type { QueryClient } from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

declare const http: HttpClient
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
