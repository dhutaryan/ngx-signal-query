import { Signal } from '@angular/core'
import { Observable } from 'rxjs'

export type QueryKey = ReadonlyArray<unknown>

export type QueryStatus = 'pending' | 'success' | 'error'

export type QueryFilters = {
  queryKey?: QueryKey
  exact?: boolean
}

export type QueryOptions<TData, TError = Error> = {
  queryKey: QueryKey
  queryFn: () => Observable<TData>
  staleTime?: number
  gcTime?: number
  enabled?: boolean
}

export type DefaultedQueryOptions<TData, TError = Error> = QueryOptions<
  TData,
  TError
> & {
  staleTime: number
}

export type QueryResult<TData, TError = Error> = {
  data: Signal<TData | undefined>
  status: Signal<QueryStatus>
  error: Signal<TError | null>
  isFetching: Signal<boolean>
  isPending: Signal<boolean>
  isSuccess: Signal<boolean>
  isError: Signal<boolean>
}
