import { InjectionToken, type Injector } from '@angular/core'

// No injector provides it, so a lookup of it, with a value to fall back on,
// asks every injector up to the platform's, where a lookup of a token that
// some injector provides would stop at that injector.
const PROVIDED_NOWHERE = new InjectionToken<null>('PROVIDED_NOWHERE')

/**
 * Whether `injector`, or any injector above it, is destroyed. A client that a
 * route provides sits in an injector below the app's, which the router never
 * destroys, not even along with the app. Once the app is torn down, that
 * injector, and its DestroyRef, still count as alive, but whatever the client
 * looks up through it from the app's injector throws.
 *
 * Angular counts an injector destroyed as soon as it starts destroying it:
 * before it calls its services' ngOnDestroy, ApplicationRef's among them,
 * which destroys the app's components, and before it runs its own DestroyRef
 * callbacks. So this holds for the code those run too, unlike a flag set from
 * one of those callbacks.
 *
 * @internal
 */
export function isDestroyed(injector: Injector): boolean {
  // A lookup throws as it reaches a destroyed injector.
  try {
    injector.get(PROVIDED_NOWHERE, null)

    return false
  } catch {
    return true
  }
}
