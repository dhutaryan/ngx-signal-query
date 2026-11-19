import { EnvironmentInjector, Injectable, NgZone, inject } from '@angular/core'

import { Cache } from './cache'
import { injectHostApp } from './host-app'
import {
  type MutationFilters,
  type MutationOptions,
  Mutation,
} from './mutation'
import { injectMutationCacheCallbacks } from './mutation-cache-callbacks'
import { lazyPendingTasks } from './pending-tasks'

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
    // Reads the reactive `entries()` so findAll() works inside computed().
    const all = this.entries()

    if (!filters.status) return all

    return all.filter((mutation) => mutation.state().status === filters.status)
  }

  remove<TData, TError, TVariables, TContext>(
    mutation: Mutation<TData, TError, TVariables, TContext>,
  ): void {
    this.removeEntry(String(mutation.mutationId))
  }
}
