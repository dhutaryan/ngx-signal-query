import type { MutationKey, MutationOptions } from './mutation'

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
 * A definition with a `mutationKey` gives it back typed as a key, ready for
 * a filter (see {@link injectIsMutating}).
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
 * // In a service:
 * updateTodo() {
 *   return mutationOptions({
 *     mutationKey: ['todos', 'update'],
 *     mutationFn: (todo: Todo) => this.http.put<Todo>(`/api/todos/${todo.id}`, todo),
 *   })
 * }
 *
 * // In a component, a "Saving…" for those writes:
 * readonly saving = injectIsMutating(() => ({
 *   mutationKey: this.#todos.updateTodo().mutationKey,
 * }))
 * ```
 */
export function mutationOptions<
  TData,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: MutationOptions<TData, TError, TVariables, TContext> & {
    mutationKey: MutationKey
  },
): MutationOptions<TData, TError, TVariables, TContext> & {
  mutationKey: MutationKey
}
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
 * A definition without a `mutationKey` has none to read, so its key can't
 * end up in a filter, where a key that's `undefined` would match every
 * mutation.
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
  options: Omit<
    MutationOptions<TData, TError, TVariables, TContext>,
    'mutationKey'
  >,
): Omit<MutationOptions<TData, TError, TVariables, TContext>, 'mutationKey'>

export function mutationOptions<TData, TError, TVariables, TContext>(
  options: MutationOptions<TData, TError, TVariables, TContext>,
): MutationOptions<TData, TError, TVariables, TContext> {
  return options
}
