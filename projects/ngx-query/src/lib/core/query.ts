import { signal } from '@angular/core'
import { Observable, Subscription, take } from 'rxjs'

import { QueryCache } from './query-cache'
import { QueryStatus } from './types'

const DEFAULT_GC_TIME = 5 * 60 * 1000

export interface QueryState<TData, TError = Error> {
  data: TData | undefined
  status: QueryStatus
  error: TError | null
  isFetching: boolean
  updatedAt: number
}

export class Query<TData, TError = Error> {
  readonly #state = signal<QueryState<TData, TError>>({
    data: undefined,
    status: 'pending',
    error: null,
    isFetching: false,
    updatedAt: 0,
  })
  readonly state = this.#state.asReadonly()

  #subscription: Subscription | null = null
  #observers = 0
  #gcTime = DEFAULT_GC_TIME
  #gcTimer: ReturnType<typeof setTimeout> | null = null
  readonly #cache: QueryCache

  constructor(
    readonly queryHash: string,
    cache: QueryCache,
  ) {
    this.#cache = cache
  }

  get observerCount(): number {
    return this.#observers
  }

  setGcTime(ms: number): void {
    this.#gcTime = ms
  }

  addObserver(): void {
    this.#observers++
    this.#clearGcTimer()
  }

  removeObserver(): void {
    if (this.#observers === 0) return

    this.#observers--

    if (this.#observers === 0) {
      this.cancel()
      this.#scheduleGc()
    }
  }

  fetch(queryFn: () => Observable<TData>): void {
    if (this.#subscription && !this.#subscription.closed) return

    this.#state.update((state) => ({ ...state, isFetching: true }))

    this.#subscription = queryFn()
      .pipe(take(1))
      .subscribe({
        next: (data) =>
          this.#state.set({
            data,
            status: 'success',
            error: null,
            isFetching: false,
            updatedAt: Date.now(),
          }),
        error: (err) =>
          this.#state.update((state) => ({
            ...state,
            status: 'error',
            error: err,
            isFetching: false,
          })),
      })
  }

  setData(data: TData): void {
    this.#state.update((state) => ({
      ...state,
      data,
      status: 'success',
      updatedAt: Date.now(),
    }))
  }

  invalidate(): void {
    this.#state.update((state) => ({ ...state, updatedAt: 0 }))
  }

  isStale(staleTime: number): boolean {
    return Date.now() - this.state().updatedAt > staleTime
  }

  cancel(): void {
    this.#subscription?.unsubscribe()
    this.#subscription = null
  }

  destroy(): void {
    this.cancel()
    this.#clearGcTimer()
  }

  #scheduleGc(): void {
    this.#clearGcTimer()

    this.#gcTimer = setTimeout(() => {
      this.#gcTimer = null
      this.#cache.remove(this)
    }, this.#gcTime)
  }

  #clearGcTimer(): void {
    if (this.#gcTimer === null) return

    clearTimeout(this.#gcTimer)
    this.#gcTimer = null
  }
}
