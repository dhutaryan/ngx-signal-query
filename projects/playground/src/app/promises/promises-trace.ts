import { Injectable, inject, signal } from '@angular/core'
import { type Observable, map, timer } from 'rxjs'

import { Log } from '../core/log/log'

/** How long the fake server takes to send the list, in ms. */
export const LIST_LATENCY = 800

/** How long the fake server takes to save a todo, in ms. */
export const WRITE_LATENCY = 300

/** One of the demo's buttons. */
export type DemoAction = 'waits' | 'doesnt-wait' | 'mutate-async' | 'refresh'

/**
 * What a line of the timeline is about: a request the server got or answered
 * (`request`), the list the server sent or failed to (`list`), a mutation
 * finishing as its signals report it (`settled`), or an awaited promise
 * resuming the code after it (`promise`).
 */
export type TraceKind = 'request' | 'list' | 'settled' | 'promise'

export type TraceEntry = {
  /** Ms since the action started. */
  at: number
  text: string
  kind: TraceKind
}

/**
 * The demo's fake server, and the timeline of the last action: what the
 * server got and answered, when the mutation finished, and when the awaited
 * promise resumed. There's no network.
 */
@Injectable()
export class PromisesTrace {
  /** The button pressed last; null before the first. */
  readonly action = signal<DemoAction | null>(null)

  /** The last action's timeline, oldest first. */
  readonly entries = signal<readonly TraceEntry[]>([])

  readonly failNextWrite = signal(false)
  readonly failNextList = signal(false)

  readonly #log = inject(Log)
  readonly #todos = ['Read the docs', 'Try a mutation']
  #startedAt = 0

  /** Starts a new timeline for `action`. */
  public start(action: DemoAction, label: string): void {
    this.action.set(action)
    this.entries.set([])
    this.#startedAt = performance.now()
    this.#log.add(`promises demo · ${label}`, 'ui')
  }

  /**
   * Adds a line to the timeline of `action`, the last one by default. A line
   * for an action that's no longer the last is dropped: it belongs to a
   * timeline nobody shows.
   */
  public note(
    text: string,
    kind: TraceKind,
    action: DemoAction | null = this.action(),
  ): void {
    if (action === null || action !== this.action()) return

    const at = Math.round(performance.now() - this.#startedAt)

    this.entries.update((entries) => [...entries, { at, text, kind }])
  }

  /** Sends the list after LIST_LATENCY ms, or fails if the next load should. */
  public list(): Observable<string[]> {
    this.note('list request sent', 'request')
    this.#log.add('promises demo · GET /todos', 'query')

    return timer(LIST_LATENCY).pipe(
      map(() => {
        if (this.failNextList()) {
          this.failNextList.set(false)
          this.note('list request failed', 'list')

          throw new Error('List down')
        }

        this.note(`list sent: ${this.#todos.length} todos`, 'list')

        return [...this.#todos]
      }),
    )
  }

  /** Saves a todo after WRITE_LATENCY ms, or refuses it if the next write should fail. */
  public add(title: string): Observable<string> {
    this.note(`write sent: "${title}"`, 'request')
    this.#log.add(`promises demo · POST /todos "${title}"`, 'query')

    return timer(WRITE_LATENCY).pipe(
      map(() => {
        if (this.failNextWrite()) {
          this.failNextWrite.set(false)
          this.note('write refused', 'request')

          throw new Error(`Server refused "${title}"`)
        }

        this.#todos.push(title)
        this.note('write landed', 'request')

        return title
      }),
    )
  }
}
