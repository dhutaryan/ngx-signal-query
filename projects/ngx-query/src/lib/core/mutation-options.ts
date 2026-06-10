import { MutationOptions } from './mutation'

export function mutationOptions<TData, TError = Error, TVariables = void>(
  options: MutationOptions<TData, TError, TVariables>,
): MutationOptions<TData, TError, TVariables> {
  return options
}
