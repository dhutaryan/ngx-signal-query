import { DestroyRef, Injectable, inject, signal } from '@angular/core'
import { type Observable, map, tap, timer } from 'rxjs'

import { Log } from '../core/log/log'

/**
 * How long the fake server takes to send the list, in ms: long enough to
 * click a few times while the first load runs.
 */
export const LIST_LATENCY = 3000

/** How long the fake server takes to save a todo, in ms. */
export const WRITE_LATENCY = 300

/** How often the fake socket says a todo changed, in ms. */
export const SOCKET_INTERVAL = 1000

/**
 * What a line of the timeline is about: a request the server got, answered
 * or saw cancelled (`request`), something that asked for a refetch or changed
 * the server's data (`trigger`), the list showing data (`data`), or a
 * mutation or promise settling (`outcome`).
 */
export type TraceKind = 'request' | 'trigger' | 'data' | 'outcome'

export type TraceEntry = {
  /** Ms since Start. */
  at: number
  text: string
  kind: TraceKind
}

/** The list as the server sends it: the version it read as the request came. */
export type ServerList = { version: number }

/**
 * The demo's fake server, and the timeline since the last Start: what the
 * server got, answered and saw cancelled, what asked for a refetch, and when
 * the list first showed data. There's no network.
 */
@Injectable()
export class FirstLoadTrace {
  /** The timeline since the last Start, oldest first. */
  readonly entries = signal<readonly TraceEntry[]>([])

  /** Ms since Start; ticks until the list first shows data. */
  readonly elapsed = signal(0)

  /** When the list first showed data, in ms since Start; null until then. */
  readonly firstDataAt = signal<number | null>(null)

  /** Requests cancelled before the list first showed data. */
  readonly cancelledBeforeData = signal(0)

  readonly #log = inject(Log)

  // The version of the list on the server: each write and each socket
  // message changes it.
  #version = 1
  // Requests sent since Start, to number them.
  #sent = 0
  #startedAt = 0
  #ticker: ReturnType<typeof setInterval> | null = null

  constructor() {
    inject(DestroyRef).onDestroy(() => this.#stopTicker())
  }

  /** Starts a new timeline: the list is about to mount and load. */
  public start(): void {
    this.entries.set([])
    this.elapsed.set(0)
    this.firstDataAt.set(null)
    this.cancelledBeforeData.set(0)
    this.#sent = 0
    this.#startedAt = performance.now()
    this.#log.add('first-load demo · Start', 'ui')

    this.#stopTicker()
    this.#ticker = setInterval(() => this.elapsed.set(this.#now()), 100)
  }

  public note(text: string, kind: TraceKind): void {
    this.entries.update((entries) => [
      ...entries,
      { at: this.#now(), text, kind },
    ])
  }

  /**
   * One list request: the server reads the list as the request comes in and
   * answers LIST_LATENCY ms later. The query calls queryFn once per request.
   */
  public list(): Observable<ServerList> {
    const n = ++this.#sent
    const version = this.#version
    // take(1) inside the query unsubscribes right after the answer, which
    // tap reports as an unsubscribe too: only one before it is a cancel.
    let answered = false

    this.note(`request #${n} sent: reads v${version}`, 'request')
    this.#log.add(`first-load demo · GET /todos (#${n})`, 'query')

    return timer(LIST_LATENCY).pipe(
      map(() => {
        answered = true
        this.note(`request #${n} answered: v${version}`, 'request')

        return { version }
      }),
      tap({
        unsubscribe: () => {
          if (answered) return

          this.note(`request #${n} cancelled`, 'request')
          this.#log.add(`first-load demo · request #${n} cancelled`, 'error')

          if (this.firstDataAt() === null) {
            this.cancelledBeforeData.update((count) => count + 1)
          }
        },
      }),
    )
  }

  /** Saves a todo: the list changes on the server once the write lands. */
  public write(): Observable<number> {
    this.note('Save: write sent', 'trigger')

    return timer(WRITE_LATENCY).pipe(
      map(() => {
        this.#version++
        this.note(`write landed: the server has v${this.#version}`, 'trigger')

        return this.#version
      }),
    )
  }

  /** A socket message: a todo changed on the server. */
  public change(): void {
    this.#version++
    this.note(
      `socket: a todo changed, the server has v${this.#version}`,
      'trigger',
    )
  }

  /** The list shows `version`; the first time, that's the first data. */
  public shown(version: number): void {
    this.note(`list shows v${version}`, 'data')

    if (this.firstDataAt() !== null) return

    this.firstDataAt.set(this.#now())
    this.#stopTicker()
  }

  #now(): number {
    return Math.round(performance.now() - this.#startedAt)
  }

  #stopTicker(): void {
    if (this.#ticker === null) return

    clearInterval(this.#ticker)
    this.#ticker = null
  }
}
