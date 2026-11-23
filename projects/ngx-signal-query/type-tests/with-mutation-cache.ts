// Type tests for withMutationCache and a mutation's meta: compiled by
// `pnpm test:types`, never run.
import type { HttpClient } from '@angular/common/http'
import { inject } from '@angular/core'
import { expectTypeOf } from 'expect-type'
import {
  QueryClient,
  injectMutation,
  mutationOptions,
  withMutationCache,
  type MutationKey,
  type MutationMeta,
  type MutationSnapshot,
  type MutationState,
  type QueryKey,
} from 'ngx-signal-query'

type Todo = { id: number; title: string; done: boolean }

declare const http: HttpClient

// Without a type declared on Register, meta is any plain object.
expectTypeOf<MutationMeta>().toEqualTypeOf<Record<string, unknown>>()

// The callbacks

// Each gets the run as a snapshot. One callback serves every mutation, so
// everything else is unknown.
withMutationCache({
  onMutate: (variables, mutation) => {
    expectTypeOf(variables).toBeUnknown()
    expectTypeOf(mutation).toEqualTypeOf<MutationSnapshot>()
  },
  onSuccess: (data, variables, context, mutation) => {
    expectTypeOf(data).toBeUnknown()
    expectTypeOf(variables).toBeUnknown()
    expectTypeOf(context).toBeUnknown()
    expectTypeOf(mutation).toEqualTypeOf<MutationSnapshot>()
  },
  onError: (error, variables, context, mutation) => {
    expectTypeOf(error).toBeUnknown()
    expectTypeOf(variables).toBeUnknown()
    expectTypeOf(context).toBeUnknown()
    expectTypeOf(mutation).toEqualTypeOf<MutationSnapshot>()
  },
  onSettled: (data, error, variables, context, mutation) => {
    expectTypeOf(data).toBeUnknown()
    expectTypeOf(error).toBeUnknown()
    expectTypeOf(variables).toBeUnknown()
    expectTypeOf(context).toBeUnknown()
    expectTypeOf(mutation).toEqualTypeOf<MutationSnapshot>()
  },
})

// The snapshot holds the state, the meta and the key.
withMutationCache({
  onError: (_error, _variables, _context, mutation) => {
    expectTypeOf(mutation.state).toEqualTypeOf<
      Readonly<MutationState<unknown, unknown, unknown, unknown>>
    >()
    expectTypeOf(mutation.meta).toEqualTypeOf<
      Record<string, unknown> | undefined
    >()
    expectTypeOf(mutation.mutationKey).toEqualTypeOf<MutationKey | undefined>()
  },
})

// It's read-only, its state too.
withMutationCache({
  onError: (_error, _variables, _context, mutation) => {
    // @ts-expect-error -- the snapshot can't be changed
    mutation.meta = {}
    // @ts-expect-error -- nor can its key
    mutation.mutationKey = ['todos']
    // @ts-expect-error -- nor can its state
    mutation.state.status = 'success'
  },
})

// A callback may call inject() and return a promise, which the run waits
// for: here, until what the mutation's meta lists is fresh again.
withMutationCache({
  onSuccess: async (_data, _variables, _context, mutation) => {
    const client = inject(QueryClient)

    await client.invalidateQueries({
      queryKey: mutation.meta?.['invalidates'] as QueryKey | undefined,
    })
  },
})

// A mutation's meta

// Every place that takes a mutation's options takes meta.
mutationOptions({
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
  meta: { invalidates: ['todos'] },
})

injectMutation(() => ({
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
  meta: { invalidates: ['todos'] },
}))

// meta is an object.
injectMutation(() => ({
  mutationFn: (todo: Todo) => http.put<Todo>(`/api/todos/${todo.id}`, todo),
  // @ts-expect-error -- a string isn't an object
  meta: 'silent',
}))
