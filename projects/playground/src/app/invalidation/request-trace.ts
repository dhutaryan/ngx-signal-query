import { Injectable, inject, signal } from '@angular/core'
import { type Observable, tap } from 'rxjs'

import { Log } from '../core/log/log'

/**
 * Records every request the invalidation demo's observers fire and how it
 * ended. Provided by the demo, so all of its observers share one instance;
 * the counters cover the time since the last reset().
 */
@Injectable()
export class RequestTrace {
  readonly fired = signal(0)
  readonly cancelled = signal(0)
  readonly resolved = signal(0)

  readonly #log = inject(Log)

  public reset(): void {
    this.fired.set(0)
    this.cancelled.set(0)
    this.resolved.set(0)
  }

  /**
   * Fires `send()` on behalf of observer `observer`. The query calls its
   * queryFn on subscribe, so one call here is exactly one request.
   */
  public request<T>(
    observer: number,
    send: () => Observable<T>,
  ): Observable<T> {
    // take(1) inside the query unsubscribes right after the value arrives,
    // which tap reports as an unsubscribe too; only one before it is a cancel.
    let settled = false

    this.fired.update((count) => count + 1)
    this.#log.add(`observer #${observer} calls queryFn`, 'query')

    return send().pipe(
      tap({
        next: () => {
          settled = true
          this.resolved.update((count) => count + 1)
          this.#log.add(`✓ observer #${observer}'s request resolved`, 'query')
        },
        error: () => (settled = true),
        unsubscribe: () => {
          if (settled) return

          this.cancelled.update((count) => count + 1)
          this.#log.add(`✕ observer #${observer}'s request cancelled`, 'error')
        },
      }),
    )
  }
}
