import { Injectable, signal } from '@angular/core'
import type { QueryResult, QueryState } from 'ngx-signal-query'
import { type Observable, map, timer } from 'rxjs'

/** How long the fake server takes to answer, in ms. */
export const LATENCY = 300

/** Older send times are dropped, so a long polling run doesn't grow without bound. */
const KEPT = 200

/**
 * One card's fake server and the record of what it got. Every response is a
 * new version, v1, v2, …, so the card can tell which request a component's
 * data came from. Each card provides its own. There's no network: a component
 * cut off from the cache can keep polling a query nobody else sees, and no
 * real API should get those.
 */
@Injectable()
export class RemovalTrace {
  /** Requests so far. */
  readonly total = signal(0)
  /** When the latest requests were sent, oldest first. */
  readonly sentAt = signal<readonly number[]>([])

  #version = 0

  /** Answers with the next version after LATENCY ms. One call is one request. */
  public request(): Observable<string> {
    this.total.update((total) => total + 1)
    this.sentAt.update((sentAt) => [...sentAt.slice(1 - KEPT), Date.now()])

    return timer(LATENCY).pipe(map(() => `v${++this.#version}`))
  }
}

/** What a component shows: its data, else whether it's loading. */
export function shown(result: QueryResult<string>): string {
  return result.data() ?? (result.isFetching() ? 'loading…' : '—')
}

/** What a cache entry holds, the way shown() puts it. */
export function held(state: QueryState<unknown, unknown>): string {
  return (
    (state.data as string | undefined) ?? (state.isFetching ? 'loading…' : '—')
  )
}

/** held(), plus what the entry is doing: fetching, or marked invalidated. */
export function describe(state: QueryState<unknown, unknown>): string {
  const busy = state.isFetching && state.data !== undefined ? 'fetching' : null
  const marked = state.isInvalidated ? 'invalidated' : null

  return [held(state), busy, marked].filter(Boolean).join(' · ')
}
