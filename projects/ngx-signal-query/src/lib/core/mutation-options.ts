import type { MutationOptions } from './mutation'

/**
 * Identity helper that defines a typed, reusable set of {@link MutationOptions}.
 *
 * Returns the options unchanged at runtime. It types a mutation defined
 * outside {@link injectMutation}, in a service say, as `injectMutation` types
 * one written inline: the hooks get the variables, the data and, as
 * `context`, what `onMutate` returns. TypeScript infers `context` in the
 * order the object is written, so put `onMutate` above the hooks that take
 * it.
 *
 * @typeParam TData - Type of the data resolved by `mutationFn`.
 * @typeParam TError - Type of the error thrown by `mutationFn`.
 * @typeParam TVariables - Type of the argument passed to `mutate()`.
 * @typeParam TContext - Type returned by `onMutate`, passed to later hooks.
 * @param options - The {@link MutationOptions} to define.
 * @returns The same `options`, typed.
 *
 * @example
 * ```ts
 * addTodo() {
 *   return mutationOptions({
 *     mutationFn: (title: string) => this.http.post<Todo>('/api/todos', { title }),
 *     onSuccess: () => this.client.invalidateQueries({ queryKey: ['todos'] }),
 *   })
 * }
 * ```
 */
export function mutationOptions<
  TData,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: MutationOptions<TData, TError, TVariables, TContext>,
): MutationOptions<TData, TError, TVariables, TContext> {
  return options
}
