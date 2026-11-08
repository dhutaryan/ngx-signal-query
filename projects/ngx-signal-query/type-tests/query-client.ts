// Type tests for QueryClient: compiled by `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import type { QueryClient } from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

declare const http: HttpClient
declare const client: QueryClient
declare function shareEqual<T>(oldData: T | undefined, newData: T): T

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
