// Type tests for an app that declares its meta type on Register: compiled by
// `pnpm test:types` on their own (see tsconfig.type-tests.register.json),
// since the declaration changes the types of every file compiled with it.
// Never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import {
  injectQuery,
  queryOptions,
  withQueryCache,
  type QueryClient,
  type QueryMeta,
} from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

// An interface, which has no index signature, works too.
interface AppQueryMeta {
  errorMessage?: string
  silent?: boolean
}

declare module 'ngx-signal-query' {
  interface Register {
    queryMeta: AppQueryMeta
  }
}

declare const http: HttpClient
declare const client: QueryClient

expectTypeOf<QueryMeta>().toEqualTypeOf<AppQueryMeta>()

// The callbacks get the app's type.
withQueryCache({
  onError: (_error, query) => {
    expectTypeOf(query.meta).toEqualTypeOf<AppQueryMeta | undefined>()
  },
})

// A query's meta must fit it.
queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  meta: { errorMessage: 'Could not load the todos' },
})

queryOptions({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- the app's meta has no such field
  meta: { message: 'Could not load the todos' },
})

injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => http.get<Todo[]>('/api/todos'),
  // @ts-expect-error -- silent is a boolean
  meta: { silent: 'yes' },
}))

client.fetchQuery(['todos'], () => http.get<Todo[]>('/api/todos'), {
  // @ts-expect-error -- the app's meta has no such field
  meta: { message: 'Could not load the todos' },
})
