// Type tests for injectIsMutating: compiled by `pnpm test:types`, never run.
import { type Injector, type Signal, signal } from '@angular/core'
import { expectTypeOf } from 'expect-type'
import { injectIsMutating } from 'ngx-signal-query'

declare const injector: Injector

const todoId = signal(1)

// Without filters, it counts every pending run, in an injection context or
// with an injector.
expectTypeOf(injectIsMutating()).toEqualTypeOf<Signal<number>>()
expectTypeOf(injectIsMutating({ injector })).toEqualTypeOf<Signal<number>>()
expectTypeOf(injectIsMutating(undefined, { injector })).toEqualTypeOf<
  Signal<number>
>()

// It takes the filters as a function, which can read a signal or an input.
expectTypeOf(
  injectIsMutating(() => ({ mutationKey: ['todos', 'update', todoId()] })),
).toEqualTypeOf<Signal<number>>()
expectTypeOf(
  injectIsMutating(() => ({ mutationKey: ['todos'], exact: true }), {
    injector,
  }),
).toEqualTypeOf<Signal<number>>()

// @ts-expect-error -- the filters are a function
injectIsMutating({ mutationKey: ['todos'] })

// 'pending' is a valid status, so the error can only come from the field
// itself.
// @ts-expect-error -- it counts pending runs, so there's no status to filter by
injectIsMutating(() => ({ status: 'pending' as const }))

// @ts-expect-error -- a key is an array
injectIsMutating(() => ({ mutationKey: 'todos' }))
