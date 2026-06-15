import { QueryOptions } from './types'

export function queryOptions<TData, TError = Error>(
  options: QueryOptions<TData, TError>,
): QueryOptions<TData, TError> {
  return options
}
