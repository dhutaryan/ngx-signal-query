import { type Injector, PendingTasks } from '@angular/core'

import { isDestroyed } from './injector'

/**
 * The app's pending tasks, reached through `injector` each time a task is
 * added rather than injected up front. On Angular 19, PendingTasks needs
 * change detection, which creates the app's ErrorHandler, so a cache that
 * injected it along with the client would keep an app whose ErrorHandler
 * uses the client from starting.
 *
 * A fetch or a mutation run that starts once `injector` is destroyed goes on
 * without a task. Angular tears the app down that way after each server
 * render: it marks the injector destroyed before it destroys the components,
 * whose DestroyRef callbacks may still start one.
 *
 * Any other failure is thrown. On Angular 19, a fetch or a mutation started
 * while Angular creates the ErrorHandler, by a service the ErrorHandler
 * injects say, fails with NG0200, as an effect created there does. That
 * failure also leaves PendingTasks broken for the rest of the app, so
 * swallowing it would leave every fetch after it without a task.
 *
 * @internal
 */
export function lazyPendingTasks(
  injector: Injector,
): Pick<PendingTasks, 'add'> {
  return {
    add: () => {
      try {
        return injector.get(PendingTasks).add()
      } catch (error) {
        if (!isDestroyed(injector)) throw error

        return () => undefined
      }
    },
  }
}
