import { Injector } from '@angular/core'

/**
 * Whether `injector` is destroyed. Angular counts it destroyed as soon as it
 * starts destroying it: before it calls its services' ngOnDestroy,
 * ApplicationRef's among them, which destroys the app's components, and
 * before it runs its own DestroyRef callbacks. So this holds for the code
 * those run too, unlike a flag set from one of those callbacks.
 *
 * TODO: once the minimum supported Angular is 20.1, where DestroyRef.destroyed
 * became public, the callers can inject DestroyRef up front and read that
 * instead: looking it up through a destroyed injector throws too.
 *
 * @internal
 */
export function isDestroyed(injector: Injector): boolean {
  // A destroyed injector throws for any token, its own included.
  try {
    injector.get(Injector)

    return false
  } catch {
    return true
  }
}
