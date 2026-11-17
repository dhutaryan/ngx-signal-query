import { Injectable, inject, signal } from '@angular/core'
import { type Observable, map, tap, timer } from 'rxjs'

import { Log } from '../core/log/log'

/** How long the fake server takes to send a page, in ms: long enough to
 * click again while one loads. */
export const PAGE_LATENCY = 800

/** How long the fake server takes to save or delete a todo, in ms. */
export const WRITE_LATENCY = 300

/** How many todos a page holds. */
export const PAGE_SIZE = 5

/** Which todos a list shows. */
export type Filter = 'all' | 'open' | 'done'

export type Todo = { id: number; title: string; done: boolean }

/**
 * A page as the server sends it: up to PAGE_SIZE todos of a filter, from a
 * cursor on, and the cursors of the pages around it. It also says which
 * filter and which version of the list it was read from.
 */
export type TodoPage = {
  filter: Filter
  version: number
  todos: Todo[]
  nextCursor: number | null
  previousCursor: number | null
}

/**
 * What a line of the timeline is about: a request the server got, answered,
 * failed or saw cancelled (`request`), or a write or a button that changes
 * the list (`trigger`).
 */
export type TraceKind = 'request' | 'trigger'

export type TraceEntry = {
  /** Ms since the demo was mounted. */
  at: number
  text: string
  kind: TraceKind
}

/**
 * The infinite demo's fake server, and the timeline of what it got. A page
 * is asked for by a cursor: the id of the first todo it may hold. The next
 * page starts after the last todo of a page, so deleting a todo moves every
 * page boundary after it. There's no network.
 */
@Injectable()
export class InfiniteServer {
  /** The timeline, oldest first. */
  readonly entries = signal<readonly TraceEntry[]>([])

  /** Whether the next request fails, once. */
  readonly failNext = signal(false)

  readonly #log = inject(Log)
  readonly #startedAt = performance.now()

  // The todos on the server; every third one is done.
  #todos = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    done: (i + 1) % 3 === 0,
  }))

  // The version of the list on the server: each write changes it.
  #version = 1
  // Requests sent so far, to number them.
  #sent = 0

  public note(text: string, kind: TraceKind): void {
    this.entries.update((entries) => [
      ...entries,
      { at: this.#now(), text, kind },
    ])
  }

  /**
   * The page of `filter`'s todos from `cursor` on, read as the request comes
   * in and answered PAGE_LATENCY ms later. The query calls queryFn once per
   * page.
   */
  public page(filter: Filter, cursor: number): Observable<TodoPage> {
    const n = ++this.#sent
    const version = this.#version
    const fails = this.failNext()
    const shown = this.#todos.filter(
      (todo) => filter === 'all' || (filter === 'done') === todo.done,
    )
    const start = shown.findIndex((todo) => todo.id >= cursor)
    const found = start < 0 ? [] : shown.slice(start, start + PAGE_SIZE)
    const before =
      start > 0 ? shown.slice(Math.max(0, start - PAGE_SIZE), start) : []
    // take(1) inside the query unsubscribes right after the answer, which
    // tap reports as an unsubscribe too: only one before it is a cancel.
    let answered = false

    if (fails) this.failNext.set(false)

    this.note(
      `#${n} ${filter} from id ${cursor}: sent, reads v${version}`,
      'request',
    )
    this.#log.add(
      `infinite demo · GET /todos?filter=${filter}&cursor=${cursor} (#${n})`,
      'query',
    )

    return timer(PAGE_LATENCY).pipe(
      map(() => {
        answered = true

        if (fails) {
          this.note(`#${n} failed`, 'request')

          throw new Error(`the page from id ${cursor} failed`)
        }

        const last = found.at(-1)

        this.note(
          `#${n} answered: ${found.map((todo) => todo.id).join(', ') || 'nothing'}`,
          'request',
        )

        return {
          filter,
          version,
          todos: found.map((todo) => ({
            id: todo.id,
            title: `Todo ${todo.id}`,
            done: todo.done,
          })),
          nextCursor: last && last !== shown.at(-1) ? last.id + 1 : null,
          previousCursor: before.length > 0 ? before[0].id : null,
        }
      }),
      tap({
        unsubscribe: () => {
          if (answered) return

          this.note(`#${n} cancelled`, 'request')
        },
      }),
    )
  }

  /** Saves a todo: the first open one gets done, and the list's version goes up. */
  public save(): Observable<void> {
    this.note('Save: write sent', 'trigger')

    return timer(WRITE_LATENCY).pipe(
      map(() => {
        const open = this.#todos.find((todo) => !todo.done)

        if (open) open.done = true

        this.#version++
        this.note(
          `write landed: todo ${open?.id} done, the server has v${this.#version}`,
          'trigger',
        )
      }),
    )
  }

  /** Deletes the first todo: every page boundary after it moves by one. */
  public deleteFirst(): Observable<void> {
    this.note('Delete: write sent', 'trigger')

    return timer(WRITE_LATENCY).pipe(
      map(() => {
        const [first] = this.#todos

        this.#todos = this.#todos.slice(1)
        this.#version++
        this.note(
          `write landed: todo ${first?.id} deleted, the server has v${this.#version}`,
          'trigger',
        )
      }),
    )
  }

  #now(): number {
    return Math.round(performance.now() - this.#startedAt)
  }
}
