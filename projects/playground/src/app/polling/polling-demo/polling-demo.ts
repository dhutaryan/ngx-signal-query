import { DecimalPipe } from '@angular/common'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core'
import { injectQueryClient } from 'ngx-signal-query'

import { Log } from '../../core/log/log'
import { LATENCY, type PollRequest, PollTrace } from '../poll-trace'
import {
  INTERVAL,
  type IntervalChoice,
  POLLING_DEMO_KEY,
  PollingQueriesObserver,
  PollingQueryObserver,
} from '../polling-observers'

type Via = 'injectQuery' | 'injectQueries'

/** A request as the timeline shows it. */
type TimelineRow = {
  id: number
  observer: number
  /** Seconds since the run started. */
  at: number
  /** Why it was sent, when it wasn't a poll. */
  cause?: string
  /** Ms since the last response before it; null if none had come yet. */
  sinceResponse: number | null
  state: 'in flight' | 'resolved' | 'cancelled'
}

/** How far a poll may stray from INTERVAL after the last response, in ms. */
const TOLERANCE = 100

/** The span of the "requests in the last 5 s" counter, in ms. */
const WINDOW = 5000

/**
 * Repro for issue #16. A poll should fire INTERVAL ms after the query's last
 * response, whatever else the options read, and once per interval however
 * many components poll the key. The timeline shows when polls actually fire.
 */
@Component({
  selector: 'app-polling-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, PollingQueryObserver, PollingQueriesObserver],
  providers: [PollTrace],
  templateUrl: './polling-demo.html',
  styleUrl: './polling-demo.scss',
})
export class PollingDemo {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)

  /** When the current run started. */
  readonly #startedAt = signal(0)
  /** Ticks while running, for the live counters. */
  readonly #now = signal(0)
  /** How many observers are mounted so far: they mount one after another. */
  readonly #mounted = signal(0)

  protected readonly trace = inject(PollTrace)

  protected readonly interval = INTERVAL
  protected readonly latency = LATENCY
  protected readonly tolerance = TOLERANCE
  /** A poll INTERVAL after each response: one per INTERVAL + LATENCY. */
  protected readonly expectedPerWindow = Math.round(
    WINDOW / (INTERVAL + LATENCY),
  )

  protected readonly viaChoices: Via[] = ['injectQuery', 'injectQueries']
  protected readonly observerChoices = [1, 3]
  protected readonly intervalChoices: IntervalChoice[] = [
    'number',
    'function',
    'infinity',
  ]

  protected readonly intervalLabels: Record<IntervalChoice, string> = {
    number: `${INTERVAL}`,
    function: `({ state }) => ${INTERVAL}`,
    infinity: 'Infinity',
  }

  /** How often the noise changes, in ms; 0 is off. */
  protected readonly noiseChoices = [0, 300, 1500]

  protected readonly via = signal<Via>('injectQuery')
  protected readonly observerCount = signal(1)
  protected readonly intervalChoice = signal<IntervalChoice>('number')
  protected readonly noisePeriod = signal(0)
  protected readonly running = signal(false)

  /** What the observers' options read, though polling doesn't depend on it. */
  protected readonly noise = signal(0)

  protected readonly observers = computed(() =>
    Array.from({ length: this.#mounted() }, (_, index) => index + 1),
  )

  /** The last 10 requests, newest first. */
  protected readonly timeline = computed(() => {
    const requests = this.trace.requests()

    return requests
      .slice(-10)
      .map(
        (request): TimelineRow => ({
          id: request.id,
          observer: request.observer,
          at: (request.startedAt - this.#startedAt()) / 1000,
          cause: request.cause,
          sinceResponse: since(
            lastResponse(requests, request.startedAt),
            request.startedAt,
          ),
          state: stateOf(request),
        }),
      )
      .reverse()
  })

  /** Seconds since the last response, live; null before the first one. */
  protected readonly sinceLastResponse = computed(() => {
    const now = this.#now()
    const ms = since(lastResponse(this.trace.requests(), now), now)

    return ms === null ? null : ms / 1000
  })

  /** Nothing came back for well over INTERVAL + LATENCY: polling stalled. */
  protected readonly stalled = computed(() => {
    const seconds = this.sinceLastResponse()

    return seconds !== null && seconds * 1000 > INTERVAL + LATENCY + 500
  })

  protected readonly perWindow = computed(() => {
    const now = this.#now()

    return this.trace
      .requests()
      .filter(({ startedAt }) => now - startedAt <= WINDOW).length
  })

  /** Judged only once a whole window has passed since the start. */
  protected readonly perWindowOff = computed(
    () =>
      this.#now() - this.#startedAt() >= WINDOW &&
      Math.abs(this.perWindow() - this.expectedPerWindow) > 1,
  )

  constructor() {
    // Observers mount a third of the interval apart, as components on a real
    // page mount at different times: their timers don't line up.
    effect((onCleanup) => {
      if (!this.running()) return

      const timers = Array.from({ length: this.observerCount() }, (_, index) =>
        setTimeout(() => this.#mounted.set(index + 1), (index * INTERVAL) / 3),
      )

      onCleanup(() => timers.forEach(clearTimeout))
    })

    // The noise: a value the options read, changed every noisePeriod ms.
    effect((onCleanup) => {
      const period = this.noisePeriod()

      if (!this.running() || period === 0) return

      const id = setInterval(() => this.noise.update((n) => n + 1), period)

      onCleanup(() => clearInterval(id))
    })

    // The clock behind the live counters.
    effect((onCleanup) => {
      if (!this.running()) return

      const id = setInterval(() => this.#now.set(Date.now()), 100)

      onCleanup(() => clearInterval(id))
    })
  }

  protected isOffBeat(row: TimelineRow): boolean {
    return (
      row.cause === undefined &&
      row.sinceResponse !== null &&
      Math.abs(row.sinceResponse - INTERVAL) > TOLERANCE
    )
  }

  protected setVia(via: Via): void {
    this.via.set(via)
    this.#log.add(`polling demo: ${via}`, 'ui')
  }

  protected setObserverCount(count: number): void {
    this.observerCount.set(count)
    this.#log.add(`polling demo: ${count} observer(s)`, 'ui')
  }

  protected chooseInterval(choice: IntervalChoice): void {
    this.intervalChoice.set(choice)
    this.#log.add(
      `polling demo: refetchInterval ${this.intervalLabels[choice]}`,
      'ui',
    )
  }

  protected setNoise(ms: number): void {
    this.noisePeriod.set(ms)
    this.#log.add(`polling demo: noise ${ms === 0 ? 'off' : `${ms} ms`}`, 'ui')
  }

  protected invalidate(): void {
    this.#log.add('polling demo: invalidateQueries', 'ui')
    this.trace.label('invalidateQueries', () =>
      this.#client.invalidateQueries({
        queryKey: POLLING_DEMO_KEY,
        exact: true,
      }),
    )
  }

  protected toggleRunning(): void {
    if (this.running()) {
      this.running.set(false)
      this.#mounted.set(0)
      this.#log.add('polling demo stopped', 'ui')

      return
    }

    // A fresh query each run, so every run starts with the fetch on mount.
    this.#client.removeQueries({ queryKey: POLLING_DEMO_KEY })
    this.trace.reset()
    this.#startedAt.set(Date.now())
    this.#now.set(Date.now())
    this.running.set(true)
    this.#log.add(
      `polling demo started · ${this.via()} · ${this.observerCount()} observer(s)`,
      'ui',
    )
  }
}

// When the latest response up to `at` arrived; null if none had by then.
function lastResponse(
  requests: readonly PollRequest[],
  at: number,
): number | null {
  const times = requests.flatMap(({ resolvedAt }) =>
    resolvedAt !== undefined && resolvedAt <= at ? [resolvedAt] : [],
  )

  return times.length === 0 ? null : Math.max(...times)
}

function since(from: number | null, to: number): number | null {
  return from === null ? null : to - from
}

function stateOf(request: PollRequest): TimelineRow['state'] {
  if (request.cancelled) return 'cancelled'

  return request.resolvedAt === undefined ? 'in flight' : 'resolved'
}
