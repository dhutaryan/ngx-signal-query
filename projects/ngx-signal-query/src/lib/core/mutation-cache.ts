import { Injectable, PendingTasks, inject } from '@angular/core'

import { Cache } from './cache'
import {
  type MutationFilters,
  type MutationOptions,
  Mutation,
} from './mutation'

/** @internal */
@Injectable()
export class MutationCache extends Cache<
  Mutation<unknown, unknown, unknown, unknown>
> {
  #lastId = 0
  // Handed to each mutation it builds, which has no injector of its own.
  readonly #pendingTasks = inject(PendingTasks)

  build<TData, TError, TVariables, TContext>(
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): Mutation<TData, TError, TVariables, TContext> {
    const mutation = new Mutation(
      ++this.#lastId,
      options,
      this,
      this.#pendingTasks,
    )

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
