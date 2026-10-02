import { Injectable, computed, inject, signal, untracked } from '@angular/core'
import { type Observable, map, tap, timer } from 'rxjs'

import { Log } from '../core/log/log'

/** How long the fake server takes to answer, in ms. */
export const LATENCY = 300

/** How many runs of an effect the demo allows per action before it stops it. */
export const RUN_LIMIT = 20

export type TraceRequest = {
  id: number
  label: string
  cancelled: boolean
}

/**
 * One scenario's fake server, and the record of what happened since the
 * user's last action: every run of the scenario's effect and every request
 * the server got. Each scenario provides its own, so their numbers stay
 * apart. There's no network: a looping effect fires requests back to back,
 * and no real API should get those.
 */
@Injectable()
export class EffectTrace {
  /** Runs of the scenario's effect since the last reset(). */
  readonly runs = signal(0)
  /** Requests since the last reset(), oldest first. */
  readonly requests = signal<readonly TraceRequest[]>([])
  /** Whether the demo stopped the effect: it ran more than RUN_LIMIT times. */
  readonly stopped = computed(() => this.runs() > RUN_LIMIT)
  /** Requests since the last reset() that were cancelled before an answer. */
  readonly cancelled = computed(
    () => this.requests().filter((request) => request.cancelled).length,
  )

  readonly #log = inject(Log)
  #nextId = 1

  /** Starts a new count. Call it on every action, before the action itself. */
  public reset(): void {
    this.runs.set(0)
    this.requests.set([])
  }

  /**
   * Counts a run of the scenario's effect. Past RUN_LIMIT it returns false,
   * and the effect skips its call, so a loop stops. Untracked: the count
   * mustn't become a dependency of the effect it counts.
   */
  public run(): boolean {
    return untracked(() => {
      this.runs.update((runs) => runs + 1)

      return this.runs() <= RUN_LIMIT
    })
  }

  /** How many requests since the last reset() have a label that matches. */
  public count(matches: (label: string) => boolean): number {
    return this.requests().filter((request) => matches(request.label)).length
  }

  /**
   * Answers with `value` after LATENCY ms. The query calls its queryFn, and a
   * mutation its mutationFn, on subscribe, so one call is one request.
   */
  public request<T>(label: string, value: T): Observable<T> {
    const id = this.#nextId++
    // take(1) inside the query unsubscribes right after the value arrives,
    // which tap reports as an unsubscribe too; only one before it is a cancel.
    let settled = false

    this.requests.update((requests) => [
      ...requests,
      { id, label, cancelled: false },
    ])
    this.#log.add(label, 'query')

    return timer(LATENCY).pipe(
      map(() => value),
      tap({
        next: () => (settled = true),
        unsubscribe: () => {
          if (settled) return

          this.requests.update((requests) =>
            requests.map((request) =>
              request.id === id ? { ...request, cancelled: true } : request,
            ),
          )
          this.#log.add(`✕ ${label} cancelled`, 'error')
        },
      }),
    )
  }
}
