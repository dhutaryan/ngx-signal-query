// Type tests for the callbacks a call of mutate() or mutateAsync() takes:
// compiled by `pnpm test:types`, never run.
import type { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { expectTypeOf } from 'expect-type'
import {
  injectMutation,
  mutationOptions,
  type MutateOptions,
  type MutationResult,
  type QueryClient,
} from 'ngx-signal-query'

type Todo = { id: number; title: string }
type Change = { id: number; title: string }
type Rollback = { previous: Todo[] | undefined }

declare const http: HttpClient
declare const client: QueryClient
declare const todos: Todo[] | undefined
declare const change: Change

const rename = injectMutation(() => ({
  mutationFn: (change: Change) =>
    http.put<Todo>(`/api/todos/${change.id}`, change),
  onMutate: (): Rollback => ({ previous: todos }),
}))

// The result carries the context type that onMutate returns.
expectTypeOf(rename).toEqualTypeOf<
  MutationResult<Todo, Error, Change, Rollback>
>()

// A call's callbacks get what the mutation's own hooks get: the data, the
// error, the variables and the context.
rename.mutate(change, {
  onSuccess: (data, variables, context) => {
    expectTypeOf(data).toEqualTypeOf<Todo>()
    expectTypeOf(variables).toEqualTypeOf<Change>()
    expectTypeOf(context).toEqualTypeOf<Rollback | undefined>()
  },
  onError: (error, variables, context) => {
    expectTypeOf(error).toEqualTypeOf<Error>()
    expectTypeOf(variables).toEqualTypeOf<Change>()
    expectTypeOf(context).toEqualTypeOf<Rollback | undefined>()
  },
  onSettled: (data, error, variables, context) => {
    expectTypeOf(data).toEqualTypeOf<Todo | undefined>()
    expectTypeOf(error).toEqualTypeOf<Error | null>()
    expectTypeOf(variables).toEqualTypeOf<Change>()
    expectTypeOf(context).toEqualTypeOf<Rollback | undefined>()
  },
})

// mutateAsync() takes them too, and still returns a promise of the data.
expectTypeOf(
  rename.mutateAsync(change, {
    onSuccess: (data, _variables, context) => {
      expectTypeOf(data).toEqualTypeOf<Todo>()
      expectTypeOf(context).toEqualTypeOf<Rollback | undefined>()
    },
  }),
).toEqualTypeOf<Promise<Todo>>()

// They're optional, one by one and as a whole.
rename.mutate(change)
rename.mutate(change, {})
rename.mutate(change, undefined)

// One may be async: what it returns isn't waited for.
rename.mutate(change, { onSuccess: async () => undefined })
expectTypeOf<
  ReturnType<NonNullable<MutateOptions<Todo, Error, Change>['onSuccess']>>
>().toBeUnknown()

// The error type given to injectMutation reaches onError and onSettled.
const save = injectMutation<Todo, HttpErrorResponse, Change>(() => ({
  mutationFn: (change) => http.put<Todo>(`/api/todos/${change.id}`, change),
}))

save.mutate(change, {
  onError: (error) => {
    expectTypeOf(error).toEqualTypeOf<HttpErrorResponse>()
  },
  onSettled: (_data, error) => {
    expectTypeOf(error).toEqualTypeOf<HttpErrorResponse | null>()
  },
})

// A mutation defined in a service, with its own onSuccess, and the
// component's reaction in the call: the context comes from the definition.
const update = mutationOptions({
  mutationFn: (change: Change) =>
    http.put<Todo>(`/api/todos/${change.id}`, change),
  onMutate: (): Rollback => ({ previous: todos }),
  onSuccess: (_data, { id }) =>
    client.invalidateQueries({ queryKey: ['todos', id] }),
})

injectMutation(() => update).mutate(change, {
  onSuccess: (data, _variables, context) => {
    expectTypeOf(data).toEqualTypeOf<Todo>()
    expectTypeOf(context).toEqualTypeOf<Rollback | undefined>()
  },
})

// A mutation that takes no variables takes undefined in their place.
const refresh = injectMutation(() => ({
  mutationFn: () => http.post<number>('/api/refresh', null),
}))

refresh.mutate()
refresh.mutate(undefined, {
  onSuccess: (count, variables) => {
    expectTypeOf(count).toEqualTypeOf<number>()
    expectTypeOf(variables).toEqualTypeOf<void>()
  },
})
expectTypeOf(refresh.mutateAsync(undefined, {})).toEqualTypeOf<
  Promise<number>
>()

// A field typed with three type arguments, as one written before the
// context type was added, still takes a result with a context: its
// callbacks get the context as unknown.
const typed: MutationResult<Todo, Error, Change> = rename

typed.mutate(change, {
  onSuccess: (_data, _variables, context) => {
    expectTypeOf(context).toBeUnknown()
  },
})

// Callbacks written apart, typed by the mutation's types.
const reactions: MutateOptions<Todo, Error, Change, Rollback> = {
  onError: (_error, _variables, context) => {
    expectTypeOf(context).toEqualTypeOf<Rollback | undefined>()
  },
}

rename.mutate(change, reactions)

// Callbacks written apart without the context type get it as unknown.
expectTypeOf<
  Parameters<NonNullable<MutateOptions<Todo, Error, Change>['onSuccess']>>[2]
>().toBeUnknown()

// Mistakes

// A callback's parameters must match the mutation's types.
// @ts-expect-error: the data is a Todo, not a string
rename.mutate(change, { onSuccess: (data: string) => data })
// @ts-expect-error: the data is a Todo, not a Todo with more fields
rename.mutate(change, { onSuccess: (data: Todo & { done: boolean }) => data })

// onMutate belongs to the mutation's options, not to a call.
// @ts-expect-error: a call takes onSuccess, onError and onSettled only
rename.mutate(change, { onMutate: () => undefined })
