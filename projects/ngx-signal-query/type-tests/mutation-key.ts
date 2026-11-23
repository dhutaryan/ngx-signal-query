// Type tests for a mutation's key and the filters that match it: compiled by
// `pnpm test:types`, never run. injectIsMutating's own forms are in
// inject-is-mutating.ts.
import type { HttpClient } from '@angular/common/http'
import { signal } from '@angular/core'
import { expectTypeOf } from 'expect-type'
import {
  injectIsMutating,
  injectMutation,
  mutationOptions,
  type MutationFilters,
  type MutationKey,
  type MutationStatus,
  type QueryClient,
} from 'ngx-signal-query'

type Todo = { id: number; title: string }

declare const http: HttpClient
declare const client: QueryClient

const todoId = signal(1)

// The key

// A key is an array, like a query's.
expectTypeOf<MutationKey>().toEqualTypeOf<readonly unknown[]>()

// A definition names its mutation with a key.
const update = mutationOptions({
  mutationKey: ['todos', 'update'],
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
})

// Its key is there to read, such as for a filter.
expectTypeOf(update.mutationKey).toEqualTypeOf<MutationKey>()

// A definition without a key has none to read: in a filter, a key that's
// undefined would match every mutation.
const keyless = mutationOptions({
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
})

// @ts-expect-error -- a definition without a key has no mutationKey
injectIsMutating(() => ({ mutationKey: keyless.mutationKey }))

// Both are used as they are, and a key can be added to one without.
injectMutation(() => update)
injectMutation(() => keyless)
injectMutation(() => ({ ...keyless, mutationKey: ['todos', 'update'] }))

// A key gets the context from onMutate as it does without one.
mutationOptions({
  mutationKey: ['todos', 'update'],
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
  onMutate: () => ({ previous: [] as Todo[] }),
  onError: (_error, todo, context) => {
    expectTypeOf(todo).toEqualTypeOf<Todo>()
    expectTypeOf(context).toEqualTypeOf<{ previous: Todo[] } | undefined>()
  },
})

// A key that may be undefined has to be written inline: a definition either
// has a key or doesn't.
declare const maybeKey: MutationKey | undefined

mutationOptions({
  // @ts-expect-error -- a definition's key can't be undefined
  mutationKey: maybeKey,
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
})

// A mutation written inline takes a key too, with a signal in it, such as an
// input, or a key that may be undefined.
injectMutation(() => ({
  mutationKey: ['todos', 'update', todoId()],
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
}))
injectMutation(() => ({
  mutationKey: maybeKey,
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
}))

mutationOptions({
  // @ts-expect-error -- a key is an array
  mutationKey: 'todos',
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
})

injectMutation(() => ({
  // @ts-expect-error -- a key is an array
  mutationKey: 'todos',
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
}))

// The filters

// Filters match the key by prefix, or exactly, and the status.
expectTypeOf<MutationFilters>().toEqualTypeOf<{
  mutationKey?: MutationKey
  exact?: boolean
  status?: MutationStatus
}>()

// A definition's key goes into a filter.
injectIsMutating(() => ({ mutationKey: update.mutationKey }))
client.isMutating({ mutationKey: update.mutationKey })

// isMutating() takes them as a value: it counts once.
expectTypeOf(client.isMutating()).toEqualTypeOf<number>()
expectTypeOf(
  client.isMutating({ mutationKey: ['todos'] }),
).toEqualTypeOf<number>()
expectTypeOf(
  client.isMutating({ mutationKey: ['todos', 'update'], exact: true }),
).toEqualTypeOf<number>()

// @ts-expect-error -- it counts pending runs, so there's no status to filter by
client.isMutating({ status: 'success' })
