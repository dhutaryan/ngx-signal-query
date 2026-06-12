import { Signal } from '@angular/core'
import { Observable } from 'rxjs'

export type QueryKey = ReadonlyArray<unknown>

export type QueryStatus = 'pending' | 'success' | 'error'

export interface QueryState<TData, TError = Error> {
  data: TData | undefined
  status: QueryStatus
  error: TError | null
  isFetching: boolean
  isInvalidated: boolean
  failureCount: number
  failureReason: TError | null
  updatedAt: number
}

export type QueryFilters = {
  queryKey?: QueryKey
  exact?: boolean
}

// Receives a snapshot of the query (state as a plain object, TanStack-style)
// and returns the next interval, or false to stop polling.
export type RefetchIntervalValue<TData, TError> =
  | number
  | false
  | ((query: {
      state: QueryState<TData, TError>
    }) => number | false | undefined)

export type RetryValue<TError> =
  | boolean
  | number
  | ((failureCount: number, error: TError) => boolean)

export type RetryDelayValue<TError> =
  | number
  | ((failureCount: number, error: TError) => number)

export type QueryOptions<TData, TError = Error> = {
  queryKey: QueryKey
  queryFn: () => Observable<TData>
  staleTime?: number
  gcTime?: number
  retry?: RetryValue<TError>
  retryDelay?: RetryDelayValue<TError>
  refetchInterval?: RefetchIntervalValue<TData, TError>
  enabled?: boolean
}

export type DefaultedQueryOptions<TData, TError = Error> = QueryOptions<
  TData,
  TError
> & {
  staleTime: number
  retry: RetryValue<TError>
  retryDelay: RetryDelayValue<TError>
}

export type QueryResult<TData, TError = Error> = {
  data: Signal<TData | undefined>
  status: Signal<QueryStatus>
  error: Signal<TError | null>
  isFetching: Signal<boolean>
  isLoading: Signal<boolean>
  isPending: Signal<boolean>
  isSuccess: Signal<boolean>
  isError: Signal<boolean>
  failureCount: Signal<number>
  failureReason: Signal<TError | null>
}
