// Type tests for an app that declares its mutations' meta type on Register:
// compiled by `pnpm test:types` along with query-meta.ts, whose declaration
// merges with this one (see tsconfig.type-tests.register.json). Never run.
import type { HttpClient } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import {
  injectMutation,
  injectMutationState,
  mutationOptions,
  withMutationCache,
  type MutationMeta,
  type QueryKey,
} from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

// An interface, which has no index signature, works too.
interface AppMutationMeta {
  invalidates?: QueryKey
}

declare module 'ngx-signal-query' {
  interface Register {
    mutationMeta: AppMutationMeta
  }
}

declare const http: HttpClient

expectTypeOf<MutationMeta>().toEqualTypeOf<AppMutationMeta>()

// The callbacks get the app's type.
withMutationCache({
  onSuccess: (_data, _variables, _context, mutation) => {
    expectTypeOf(mutation.meta).toEqualTypeOf<AppMutationMeta | undefined>()
  },
})

// So does injectMutationState's select.
injectMutationState(() => ({
  select: (mutation) => {
    expectTypeOf(mutation.meta).toEqualTypeOf<AppMutationMeta | undefined>()

    return mutation.meta?.invalidates
  },
}))

// A mutation's meta must fit it.
mutationOptions({
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
  meta: { invalidates: ['todos'] },
})

mutationOptions({
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
  // @ts-expect-error -- the app's meta has no such field
  meta: { refresh: ['todos'] },
})

injectMutation(() => ({
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
  // @ts-expect-error -- invalidates is a query key
  meta: { invalidates: 'todos' },
}))
