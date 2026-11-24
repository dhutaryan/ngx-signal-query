// Type tests for injectMutationState: compiled by `pnpm test:types`, never
// run.
import type { HttpClient } from '@angular/common/http'
import { type Injector, type Signal, signal } from '@angular/core'
import { expectTypeOf } from 'expect-type'
import {
  injectMutationState,
  mutationOptions,
  type MutationKey,
  type MutationSnapshot,
  type MutationState,
  type MutationStateOptions,
} from 'ngx-signal-query'

type Todo = { id: number; title: string }

declare const http: HttpClient
declare const injector: Injector

const todoId = signal(1)

// Without select, each item is a run's state. The filters can match any
// mutation, so its types are unknown, and it's read-only, like the state a
// cache callback gets.
type AnyState = Readonly<MutationState<unknown, unknown, unknown, unknown>>

expectTypeOf(injectMutationState()).toEqualTypeOf<Signal<AnyState[]>>()
expectTypeOf(injectMutationState(undefined, { injector })).toEqualTypeOf<
  Signal<AnyState[]>
>()
expectTypeOf(
  injectMutationState(() => ({ filters: { status: 'pending' } }), {
    injector,
  }),
).toEqualTypeOf<Signal<AnyState[]>>()

// @ts-expect-error -- an item is the run's own state, which can't be changed
injectMutationState()()[0].status = 'idle'

// select gets the run the way the cache callbacks get it: its state, meta
// and key.
injectMutationState(() => ({
  select: (mutation) => {
    expectTypeOf(mutation).toEqualTypeOf<MutationSnapshot>()
    expectTypeOf(mutation.mutationKey).toEqualTypeOf<MutationKey | undefined>()

    return mutation.state.submittedAt
  },
}))

// Each item is what select returns. The types are unknown there, so select
// says what it expects.
expectTypeOf(
  injectMutationState(() => ({
    filters: { mutationKey: ['todos', 'delete'], status: 'pending' },
    select: (mutation) => mutation.state.variables as number,
  })),
).toEqualTypeOf<Signal<number[]>>()

// Without that, an item is unknown.
expectTypeOf(
  injectMutationState(() => ({
    select: (mutation) => mutation.state.variables,
  })),
).toEqualTypeOf<Signal<unknown[]>>()

injectMutationState(() => ({
  // @ts-expect-error -- variables are unknown until select says what they are
  select: (mutation): number => mutation.state.variables,
}))

// Or select's parameter gives the types of the runs that the filters match.
expectTypeOf(
  injectMutationState(() => ({
    select: (mutation: MutationSnapshot<void, Error, number>) =>
      mutation.state.variables,
  })),
).toEqualTypeOf<Signal<Array<number | undefined>>>()

// @ts-expect-error -- select gets a run's snapshot, not just any object
injectMutationState(() => ({
  select: (mutation: { id: number }) => mutation.id,
}))

// Without select, a type argument says what the states are. Readonly keeps
// them read-only, like the default.
expectTypeOf(
  injectMutationState<Readonly<MutationState<Todo, Error, Todo, unknown>>>(
    () => ({ filters: { mutationKey: ['todos', 'update'] } }),
  ),
).toEqualTypeOf<
  Signal<Array<Readonly<MutationState<Todo, Error, Todo, unknown>>>>
>()

// The filters take a status, unlike injectIsMutating's, and can read a
// signal or an input.
injectMutationState(() => ({
  filters: {
    mutationKey: ['todos', 'delete', todoId()],
    exact: true,
    status: 'error',
  },
}))

// A definition's key goes into the filters.
const remove = mutationOptions({
  mutationKey: ['todos', 'delete'],
  mutationFn: (id: number) => http.delete<void>(`/api/todos/${id}`),
})

injectMutationState(() => ({
  filters: { mutationKey: remove.mutationKey, status: 'pending' },
  select: (mutation) => mutation.state.variables as number,
}))

// The options have a type of their own, for code that builds them.
const deleting: MutationStateOptions<number> = {
  filters: { mutationKey: ['todos', 'delete'], status: 'pending' },
  select: (mutation) => mutation.state.variables as number,
}

expectTypeOf(injectMutationState(() => deleting)).toEqualTypeOf<
  Signal<number[]>
>()

// Without type arguments, they list the states.
const pending: MutationStateOptions = { filters: { status: 'pending' } }

expectTypeOf(injectMutationState(() => pending)).toEqualTypeOf<
  Signal<AnyState[]>
>()

// @ts-expect-error -- the options are a function
injectMutationState({ filters: { status: 'pending' } })

// @ts-expect-error -- a key is an array
injectMutationState(() => ({ filters: { mutationKey: 'todos' } }))

// @ts-expect-error -- there's no such status
injectMutationState(() => ({ filters: { status: 'done' } }))
