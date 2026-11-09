import { ErrorHandler, Injectable, inject } from '@angular/core'

import { Log } from './log'

/**
 * Mirrors every error reported to the ErrorHandler into the log, a failing
 * mutation hook's included, so a failing demo shows up on the page.
 */
@Injectable()
export class LogErrorHandler extends ErrorHandler {
  readonly #log = inject(Log)

  public override handleError(error: unknown): void {
    super.handleError(error)

    // An error thrown during change detection is reported from inside the
    // aborted tick, where a signal write doesn't schedule another one. Defer
    // the write so the log actually re-renders.
    queueMicrotask(() =>
      this.#log.add(
        error instanceof Error ? error.message : String(error),
        'error',
      ),
    )
  }
}
