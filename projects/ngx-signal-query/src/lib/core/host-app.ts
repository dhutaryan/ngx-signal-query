import {
  EnvironmentInjector,
  ErrorHandler,
  NgZone,
  inject,
  runInInjectionContext,
} from '@angular/core'

import { isDestroyed } from './injector'

/**
 * What the app's own code needs from the app when the client calls it back,
 * such as a default mutation hook or a cache callback: to run in the app's
 * injection context, not to run at all once the app is gone, and to have
 * what it throws reach the app's ErrorHandler.
 *
 * @internal
 */
export type HostApp = {
  /**
   * Wraps `hook` to run in the injection context of the injector that
   * provides the client, so it can call inject(). The hook belongs to the
   * app, so it's this injector, not that of the component that started the
   * fetch or the run. Gives undefined for no hook.
   */
  inContext: <TArgs extends unknown[]>(
    hook: ((...args: TArgs) => unknown) | undefined,
  ) => ((...args: TArgs) => unknown) | undefined
  /** Hands the error of a failing hook to the app's ErrorHandler. Never throws. */
  reportError: (error: unknown) => void
}

/**
 * The app that the injector providing the client belongs to (see HostApp).
 * Must run in that injector's injection context, such as in the field
 * initializers of the client or of one of its caches.
 *
 * @internal
 */
export function injectHostApp(): HostApp {
  const injector = inject(EnvironmentInjector)
  const zone = inject(NgZone)

  return {
    inContext: (hook) => {
      if (!hook) return

      return (...args) => {
        // Once that injector, or one above it, is destroyed, the app the
        // hook belongs to is gone: a fetch or a run that lands after that,
        // once its test has ended say, skips the hook. So does one that lands
        // while Angular tears the app down, such as a save that a component
        // starts while it's destroyed: the app's injector counts as destroyed
        // by then (see isDestroyed).
        if (isDestroyed(injector)) return

        return runInInjectionContext(injector, () => hook(...args))
      }
    },
    // The ErrorHandler is looked up each time, not injected: the app's
    // ErrorHandler may use the client, which is created along with its
    // caches, and then neither could be. All of it runs outside Angular's
    // zone, where Angular calls the ErrorHandler for the errors it catches:
    // a timer the handler sets, to hide the message it shows say, doesn't
    // keep a zone.js app busy. An error the ErrorHandler can't take, because
    // it throws or the injector is gone, surfaces as an unhandled rejection;
    // outside the zone too, or zone.js would hand it to that ErrorHandler
    // again. So this never throws, and whatever called the hook carries on.
    reportError: (error) =>
      zone.runOutsideAngular(() => {
        try {
          injector.get(ErrorHandler).handleError(error)
        } catch {
          void Promise.reject(error)
        }
      }),
  }
}
