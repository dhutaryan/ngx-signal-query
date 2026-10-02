import { Injectable, signal } from '@angular/core'
import { type Observable, map, tap, timer } from 'rxjs'

/** How long the fake server takes to answer, in ms. */
export const LATENCY = 300

/** Older requests are dropped, so a long run doesn't grow without bound. */
const KEPT = 200

export type PollRequest = {
  id: number
  /** The observer whose queryFn sent it. */
  observer: number
  /** Why it was sent, when it wasn't a poll: a mount, or the user asked. */
  cause?: string
  startedAt: number
  /** When the response arrived; unset while in flight or if cancelled. */
  resolvedAt?: number
  cancelled?: boolean
}

/**
 * The polling demo's fake server and the record of every request it got.
 * Provided by the demo, so all of its observers share one instance. It answers
 * after LATENCY ms with the next version number, without the network: a poll
 * gone wrong can fire requests back to back, and no real API should get those.
 */
@Injectable()
export class PollTrace {
  /** The requests since the last reset(), oldest first. */
  readonly requests = signal<readonly PollRequest[]>([])

  #nextId = 1
  #version = 0
  #cause: string | undefined
  // Observers that sent a request since the last reset(): the first one an
  // observer sends is its fetch on mount.
  readonly #seen = new Set<number>()

  public reset(): void {
    this.requests.set([])
    this.#seen.clear()
  }

  /**
   * Runs `send`, labelling the request it fires with `cause`. Meant for calls
   * that fetch synchronously, such as invalidateQueries().
   */
  public label(cause: string, send: () => void): void {
    this.#cause = cause

    try {
      send()
    } finally {
      this.#cause = undefined
    }
  }

  /**
   * Answers a request from observer `observer`. The query calls its queryFn on
   * subscribe, so one call here is exactly one request.
   */
  public request(observer: number): Observable<number> {
    const id = this.#nextId++
    // take(1) inside the query unsubscribes right after the value arrives,
    // which tap reports as an unsubscribe too; only one before it is a cancel.
    let settled = false

    const cause =
      this.#cause ?? (this.#seen.has(observer) ? undefined : 'mount')

    this.#seen.add(observer)
    this.requests.update((requests) => [
      ...requests.slice(1 - KEPT),
      { id, observer, cause, startedAt: Date.now() },
    ])

    return timer(LATENCY).pipe(
      map(() => ++this.#version),
      tap({
        next: () => {
          settled = true
          this.#patch(id, { resolvedAt: Date.now() })
        },
        unsubscribe: () => {
          if (!settled) this.#patch(id, { cancelled: true })
        },
      }),
    )
  }

  #patch(id: number, change: Partial<PollRequest>): void {
    this.requests.update((requests) =>
      requests.map((request) =>
        request.id === id ? { ...request, ...change } : request,
      ),
    )
  }
}
