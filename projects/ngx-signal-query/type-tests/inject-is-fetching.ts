// Type tests for injectIsFetching: compiled by `pnpm test:types`, never run.
import { type Injector, type Signal, signal } from '@angular/core'
import { expectTypeOf } from 'expect-type'
import { injectIsFetching } from 'ngx-signal-query'

declare const injector: Injector

const todoId = signal(1)

// Without filters, it counts every fetching query, in an injection context
// or with an injector.
expectTypeOf(injectIsFetching()).toEqualTypeOf<Signal<number>>()
expectTypeOf(injectIsFetching(undefined, { injector })).toEqualTypeOf<
  Signal<number>
>()

// It takes the filters as a function, which can read a signal or an input.
expectTypeOf(
  injectIsFetching(() => ({ queryKey: ['todo', todoId()] })),
).toEqualTypeOf<Signal<number>>()
expectTypeOf(
  injectIsFetching(() => ({ queryKey: ['todos'], exact: true }), {
    injector,
  }),
).toEqualTypeOf<Signal<number>>()

// Or as a value, like before.
expectTypeOf(injectIsFetching({ queryKey: ['todos'] })).toEqualTypeOf<
  Signal<number>
>()
expectTypeOf(
  injectIsFetching({ queryKey: ['todos'], exact: true }, { injector }),
).toEqualTypeOf<Signal<number>>()

// @ts-expect-error -- a key is an array
injectIsFetching(() => ({ queryKey: 'todos' }))
