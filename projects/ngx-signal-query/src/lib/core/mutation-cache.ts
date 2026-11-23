import { EnvironmentInjector, Injectable, NgZone, inject } from '@angular/core'

import { Cache } from './cache'
import { injectHostApp } from './host-app'
import {
  type MutationFilters,
  type MutationKey,
  type MutationOptions,
  Mutation,
} from './mutation'
import { injectMutationCacheCallbacks } from './mutation-cache-callbacks'
import { lazyPendingTasks } from './pending-tasks'
import { hashKey, partialMatchKey } from './utils'

/** @internal */
@Injectable()
export class MutationCache extends Cache<
  Mutation<unknown, unknown, unknown, unknown>
> {
  #lastId = 0
  // What each mutation it builds needs from the app, having no injector of
  // its own (see MutationConfig). The pending tasks are looked up for each
  // task (see lazyPendingTasks).
  readonly #pendingTasks = lazyPendingTasks(inject(EnvironmentInjector))
  readonly #zone = inject(NgZone)
  readonly #callbacks = injectMutationCacheCallbacks()
  readonly #reportError = injectHostApp().reportError

  build<TData, TError, TVariables, TContext>(
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): Mutation<TData, TError, TVariables, TContext> {
    const mutation = new Mutation({
      mutationId: ++this.#lastId,
      options,
      cache: this,
      pendingTasks: this.#pendingTasks,
      zone: this.#zone,
      reportError: this.#reportError,
      callbacks: this.#callbacks,
    })

    this.addEntry(
      String(mutation.mutationId),
      mutation as Mutation<unknown, unknown, unknown, unknown>,
    )

    return mutation
  }

  findAll(
    filters: MutationFilters = {},
  ): Array<Mutation<unknown, unknown, unknown, unknown>> {
    const { status } = filters

    // Reads the reactive `entries()` so findAll() works inside computed().
    // The key is checked before the state, so a computed tracks the state of
    // only the runs whose key matches: a run's key never changes, so no other
    // run can come to match.
    return this.entries().filter(
      (mutation) =>
        matchesKey(mutation.mutationKey, filters) &&
        (!status || mutation.state().status === status),
    )
  }

  remove<TData, TError, TVariables, TContext>(
    mutation: Mutation<TData, TError, TVariables, TContext>,
  ): void {
    this.removeEntry(String(mutation.mutationId))
  }
}

// Whether a run's key matches the filters, the way a query's key does: it
// starts with the filters' key or, with `exact`, equals it. A run without a
// key matches only filters without one.
function matchesKey(
  key: MutationKey | undefined,
  { mutationKey, exact }: MutationFilters,
): boolean {
  if (!mutationKey) return true
  if (!key) return false

  return exact
    ? hashKey(key) === hashKey(mutationKey)
    : partialMatchKey(key, mutationKey)
}
