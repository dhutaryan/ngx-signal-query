import { Injectable, inject, signal } from '@angular/core'
import { type Observable, map, tap, timer } from 'rxjs'

import { Log } from '../core/log/log'

/** How long the fake server takes to answer, in ms. */
export const LATENCY = 300

/** Older requests are dropped, so the record doesn't grow without bound. */
const KEPT = 200

/**
 * A request as the demo records it. Times are performance.now() values, the
 * clock an event's timeStamp uses.
 */
type FocusRequest = {
  id: number
  row: string
  sentAt: number
  /** When it was answered or cancelled; unset while it's in flight. */
  settledAt?: number
}

/**
 * The demo's fake server and the record of what it got. Every response of a
 * row is a new version, v1, v2, …, so the table shows which request a
 * component's data came from. There's no network.
 */
@Injectable()
export class FocusTrace {
  /** Requests so far, oldest first. */
  readonly requests = signal<readonly FocusRequest[]>([])

  readonly #log = inject(Log)
  readonly #versions = new Map<string, number>()
  #nextId = 1

  /**
   * Answers with the row's next version after LATENCY ms. The query calls
   * its queryFn on subscribe, so one call is one request.
   */
  public request(row: string): Observable<string> {
    const id = this.#nextId++
    // take(1) inside the query unsubscribes right after the value arrives,
    // which tap reports as an unsubscribe too; only one before it is a cancel.
    let settled = false

    this.requests.update((requests) => [
      ...requests.slice(1 - KEPT),
      { id, row, sentAt: performance.now() },
    ])
    this.#log.add(`focus demo · GET ${row}`, 'query')

    return timer(LATENCY).pipe(
      map(() => {
        const version = (this.#versions.get(row) ?? 0) + 1

        this.#versions.set(row, version)

        return `v${version}`
      }),
      tap({
        next: () => {
          settled = true
          this.#settle(id)
        },
        unsubscribe: () => {
          if (settled) return

          this.#settle(id)
          this.#log.add(`✕ focus demo · GET ${row} cancelled`, 'error')
        },
      }),
    )
  }

  /** How many requests of the row were sent at `at` or later. */
  public sentSince(row: string, at: number): number {
    return this.requests().filter(
      (request) => request.row === row && request.sentAt >= at,
    ).length
  }

  /** Whether a request of the row was in flight at `at`. */
  public inFlightAt(row: string, at: number): boolean {
    return this.requests().some(
      (request) =>
        request.row === row &&
        request.sentAt < at &&
        (request.settledAt === undefined || request.settledAt > at),
    )
  }

  #settle(id: number): void {
    this.requests.update((requests) =>
      requests.map((request) =>
        request.id === id
          ? { ...request, settledAt: performance.now() }
          : request,
      ),
    )
  }
}
