import { DOCUMENT } from '@angular/common'
import { inject } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { filter, fromEvent } from 'rxjs'

import { inBrowser } from './platform'

/**
 * Returns a function that tells whether the user can see the page right now:
 * `false` while its tab is in the background or its window is minimized. A
 * page that is neither visible nor hidden, as a test DOM may say
 * (`'prerender'`), counts as visible. Must run in an injection context.
 *
 * @internal
 */
export function pageVisibility(): () => boolean {
  const document = inject(DOCUMENT)

  return () => document.visibilityState !== 'hidden'
}

/**
 * Calls `listener` whenever the user comes back to the page, as the tab or
 * the window turns visible again. The window's `focus` event isn't used: it
 * also fires when an alert or a file picker closes, or on coming back from
 * DevTools, with the user on the page all along.
 *
 * Listens until the current injector is destroyed, and only in the browser:
 * on the server there is no page to come back to. Must run in an injection
 * context.
 *
 * @internal
 */
export function onWindowFocus(listener: () => void): void {
  if (!inBrowser()) return

  const document = inject(DOCUMENT)
  const visible = pageVisibility()

  fromEvent(document, 'visibilitychange')
    .pipe(
      filter(() => visible()),
      takeUntilDestroyed(),
    )
    .subscribe(() => listener())
}

/**
 * Calls `listener` whenever the browser reports that the network is back
 * (`online`). Each such event means it was off: the browser fires it only
 * when going from offline to online, a page opened offline included.
 *
 * Listens until the current injector is destroyed, and only in the browser.
 * Must run in an injection context.
 *
 * @internal
 */
export function onReconnect(listener: () => void): void {
  if (!inBrowser()) return

  const window = inject(DOCUMENT).defaultView

  if (!window) return

  fromEvent(window, 'online')
    .pipe(takeUntilDestroyed())
    .subscribe(() => listener())
}
