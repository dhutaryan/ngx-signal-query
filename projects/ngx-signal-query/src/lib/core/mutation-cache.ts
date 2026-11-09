import {
  EnvironmentInjector,
  ErrorHandler,
  Injectable,
  NgZone,
  PendingTasks,
  inject,
} from '@angular/core'

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
  // The app's pending tasks and Angular's zone, handed to each mutation it
  // builds, which has no injector of its own, along with #reportError.
  readonly #pendingTasks = inject(PendingTasks)
  readonly #zone = inject(NgZone)
  readonly #injector = inject(EnvironmentInjector)

  build<TData, TError, TVariables, TContext>(
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): Mutation<TData, TError, TVariables, TContext> {
    const mutation = new Mutation(
      ++this.#lastId,
      options,
      this,
      this.#pendingTasks,
      this.#zone,
      this.#reportError,
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

  // Hands the error of a failing hook to the app's ErrorHandler. It's looked
  // up each time, not injected: the app's ErrorHandler may use the client,
  // which is created along with this cache, and then neither could be. All
  // of it runs outside Angular's zone, where Angular calls the ErrorHandler
  // for the errors it catches: a timer the handler sets, to hide the message
  // it shows say, doesn't keep a zone.js app busy. An error the ErrorHandler
  // can't take, as it throws or the injector is gone, surfaces as an
  // unhandled rejection; outside the zone too, or zone.js would hand it to
  // that ErrorHandler again. So this never throws, and the run settles.
  readonly #reportError = (error: unknown): void =>
    this.#zone.runOutsideAngular(() => {
      try {
        this.#injector.get(ErrorHandler).handleError(error)
      } catch {
        void Promise.reject(error)
      }
    })
}
