import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core'
import {
  type QueryResult,
  type RefetchIntervalValue,
  injectQueries,
  injectQuery,
} from 'ngx-signal-query'
import { of } from 'rxjs'

import { PollTrace } from './poll-trace'

/** The polling interval every observer asks for, in ms. */
export const INTERVAL = 1000

/** Not under ['todos'], so the other demos' invalidations can't touch it. */
export const POLLING_DEMO_KEY = ['polling-demo'] as const

/** The query next to the polled one in injectQueries' list. */
const NEIGHBOUR_KEY = ['polling-demo', 'neighbour'] as const

export type IntervalChoice = 'number' | 'function' | 'infinity'

export function refetchIntervalFor(
  choice: IntervalChoice,
): RefetchIntervalValue<number, Error> {
  switch (choice) {
    case 'number':
      return INTERVAL

    case 'function':
      // The usual shape of the function form: poll until something breaks.
      return ({ state }) => (state.status === 'error' ? false : INTERVAL)

    case 'infinity':
      // Reads as "never", and TanStack treats it so.
      return Infinity
  }
}

const TEMPLATE = `
  <span class="n">#{{ n() }}</span>
  <code>{{ result().status() }}</code>
  <code [class.fetching]="result().isFetching()">
    {{ result().isFetching() ? 'fetching' : 'idle' }}
  </code>
  <span>
    @if (result().data(); as version) {
      response #{{ version }}
    }
  </span>
`

const STYLES = `
  :host {
    display: grid;
    grid-template-columns: 2rem 5rem 5rem 1fr;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.25rem 0;
    font-size: 0.9rem;
  }

  .n {
    color: #57606a;
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #f6f8fa;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    font-size: 0.85em;
  }

  .fetching {
    background: #fff1e5;
  }
`

/** One of the components polling the demo's key, through injectQuery. */
@Component({
  selector: 'app-polling-query-observer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
  styles: STYLES,
})
export class PollingQueryObserver {
  readonly n = input.required<number>()
  readonly interval = input.required<IntervalChoice>()
  readonly noise = input.required<number>()

  readonly #trace = inject(PollTrace)

  readonly #query = injectQuery(() => ({
    queryKey: POLLING_DEMO_KEY,
    queryFn: () => this.#trace.request(this.n()),
    refetchInterval: refetchIntervalFor(this.interval()),
    // Polling doesn't depend on retry, but the options read the noise here:
    // a changing input is all it takes.
    retry: this.noise() % 2,
  }))

  protected readonly result = (): QueryResult<number> => this.#query
}

/**
 * The same through injectQueries. Here the polled query's own options don't
 * read the noise: a neighbour in the same list does.
 */
@Component({
  selector: 'app-polling-queries-observer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
  styles: STYLES,
})
export class PollingQueriesObserver {
  readonly n = input.required<number>()
  readonly interval = input.required<IntervalChoice>()
  readonly noise = input.required<number>()

  readonly #trace = inject(PollTrace)

  readonly #queries = injectQueries(() => ({
    queries: [
      {
        queryKey: POLLING_DEMO_KEY,
        queryFn: () => this.#trace.request(this.n()),
        refetchInterval: refetchIntervalFor(this.interval()),
      },
      {
        queryKey: NEIGHBOUR_KEY,
        queryFn: () => of(0),
        staleTime: Infinity,
        retry: this.noise() % 2,
      },
    ],
  }))

  protected readonly result = (): QueryResult<number> => this.#queries()[0]
}
