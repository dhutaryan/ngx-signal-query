import { isPlatformBrowser } from '@angular/common'
import { PLATFORM_ID, inject } from '@angular/core'

/**
 * Whether the app runs in the browser rather than on the server. On the
 * server, DOCUMENT is an emulated document that has listeners, a window and
 * no visibilityState: only the platform tells. Must run in an injection
 * context.
 *
 * @internal
 */
export function inBrowser(): boolean {
  return isPlatformBrowser(inject(PLATFORM_ID))
}
