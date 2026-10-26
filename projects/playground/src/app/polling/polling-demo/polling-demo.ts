import { DecimalPipe } from '@angular/common'
import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { injectQueryClient } from 'ngx-signal-query'
import { fromEvent } from 'rxjs'

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

/**
 * What the timeline shows between the requests: the tab hiding or coming
 * back, or the observers switching what they do in a hidden tab.
 */
type Mark =
  | { kind: 'visibility'; at: number; hidden: boolean }
  | { kind: 'background'; at: number; background: boolean }

/** A request as the timeline shows it. */
type RequestRow = {
  kind: 'request'
  key: string
  observer: number
  /** Seconds since the run started. */
  at: number
  /** Why it was sent, when it wasn't a poll. */
  cause?: string
  /** Ms since the last response before it; null if none had come yet. */
  sinceResponse: number | null
  /** What else the timeline says about its timing. */
  note?: string
  bad: boolean
  state: 'in flight' | 'resolved' | 'cancelled'
}

/** A mark as the timeline shows it. */
type MarkRow = {
  kind: 'mark'
  key: string
  /** Seconds since the run started. */
  at: number
  text: string
}

type TimelineRow = RequestRow | MarkRow

/** How far a poll may stray from INTERVAL after the last response, in ms. */
const TOLERANCE = 100

/** The span of the "requests in the last 5 s" counter, in ms. */
const WINDOW = 5000

/** How long the hide button keeps the tab hidden, in ms. */
const HIDE_FOR = 5000

/**
 * Repro for issues #16 and #23. A poll should fire INTERVAL ms after the
 * query's last response, whatever else the options read, and once per
 * interval however many components poll the key. While the tab is hidden, no
 * poll should go out, unless the observers ask to keep polling there. The
 * timeline shows when polls actually fire, and when the tab was hidden.
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
  readonly #document = inject(DOCUMENT)
  readonly #log = inject(Log)

  /** When the current run started. */
  readonly #startedAt = signal(0)
  /** Ticks while running, for the live counters. */
  readonly #now = signal(0)
  /** How many observers are mounted so far: they mount one after another. */
  readonly #mounted = signal(0)
  /** The marks since the run started, oldest first. */
  readonly #marks = signal<readonly Mark[]>([])
  /** What the observers did in a hidden tab when the run started. */
  readonly #backgroundAtStart = signal(false)
  /** When the hide button's hide ends; 0 while it isn't hiding the tab. */
  readonly #hideEndsAt = signal(0)

  /**
   * Whether the counters are judged: the tab is visible, and has been for a
   * whole window since it came back. While it's hidden, polling pauses, or
   * goes on at whatever pace the browser lets timers run there.
   */
  readonly #settled = computed(() => {
    const visibility = lastMark(this.#marks(), 'visibility', Infinity)

    return (
      visibility === undefined ||
      (!visibility.hidden && this.#now() - visibility.at >= WINDOW)
    )
  })

  #hideTimer: ReturnType<typeof setTimeout> | undefined

  protected readonly trace = inject(PollTrace)

  protected readonly interval = INTERVAL
  protected readonly latency = LATENCY
  protected readonly tolerance = TOLERANCE
  protected readonly hideFor = HIDE_FOR
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
  /** Whether the observers keep polling while the tab is hidden. */
  protected readonly background = signal(false)
  protected readonly running = signal(false)

  /** What the observers' options read, though polling doesn't depend on it. */
  protected readonly noise = signal(0)

  protected readonly hiding = computed(() => this.#hideEndsAt() !== 0)

  /** Whole seconds left until the hide button's hide ends. */
  protected readonly hidingLeft = computed(() =>
    Math.max(0, Math.ceil((this.#hideEndsAt() - this.#now()) / 1000)),
  )

  protected readonly observers = computed(() =>
    Array.from({ length: this.#mounted() }, (_, index) => index + 1),
  )

  /** The last 10 requests and marks, newest first. */
  protected readonly timeline = computed((): TimelineRow[] => {
    const requests = this.trace.requests()
    const marks = this.#marks()
    const rows: TimelineRow[] = [
      ...requests
        .slice(-10)
        .map((request) => this.#requestRow(request, requests, marks)),
      ...marks.map((mark, index) => this.#markRow(mark, index)).slice(-10),
    ]

    return rows
      .sort((a, b) => a.at - b.at)
      .slice(-10)
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

    return (
      this.#settled() &&
      seconds !== null &&
      seconds * 1000 > INTERVAL + LATENCY + 500
    )
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
      this.#settled() &&
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

    // The timeline's marks for the tab hiding and coming back, whether the
    // hide button or the browser did it.
    fromEvent(this.#document, 'visibilitychange')
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.#markVisibility())

    // A hide still going when the demo is destroyed gives the page its
    // visibility back.
    inject(DestroyRef).onDestroy(() => this.#endHide())
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

  protected setBackground(background: boolean): void {
    if (background === this.background()) return

    this.background.set(background)

    if (this.running()) {
      this.#marks.update((marks) => [
        ...marks,
        { kind: 'background', at: Date.now(), background },
      ])
    }

    this.#log.add(
      `polling demo: ${background ? 'keep polling' : 'pause'} in a hidden tab`,
      'ui',
    )
  }

  // Hides the tab for HIDE_FOR ms, as switching to another tab and back does:
  // visibilityState changes and visibilitychange fires each time. The real
  // visibilityState comes back afterwards.
  protected hideTab(): void {
    this.#setVisibility('hidden')
    this.#hideEndsAt.set(Date.now() + HIDE_FOR)
    this.#hideTimer = setTimeout(() => this.#endHide(), HIDE_FOR)
    this.#log.add(`polling demo: tab hidden for ${HIDE_FOR / 1000} s`, 'ui')
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

    const now = Date.now()

    this.#startedAt.set(now)
    this.#now.set(now)
    this.#backgroundAtStart.set(this.background())
    // A run started while the hide button hides the tab starts hidden.
    this.#marks.set(
      this.#document.visibilityState === 'hidden'
        ? [{ kind: 'visibility', at: now, hidden: true }]
        : [],
    )
    this.running.set(true)
    this.#log.add(
      `polling demo started · ${this.via()} · ${this.observerCount()} observer(s)`,
      'ui',
    )
  }

  // A request as the timeline shows it, judged by what the tab and the
  // observers' setting were when it went out. A poll sent while the tab was
  // hidden shouldn't exist unless the observers keep polling there, and isn't
  // timed then: browsers slow timers down in a background tab. The first poll
  // after the tab comes back is shown against the return. Any other poll
  // should come INTERVAL ms after the last response.
  #requestRow(
    request: PollRequest,
    requests: readonly PollRequest[],
    marks: readonly Mark[],
  ): RequestRow {
    const sinceResponse = since(
      lastResponse(requests, request.startedAt),
      request.startedAt,
    )
    const row: RequestRow = {
      kind: 'request',
      key: `request ${request.id}`,
      observer: request.observer,
      at: (request.startedAt - this.#startedAt()) / 1000,
      cause: request.cause,
      sinceResponse,
      bad: false,
      state: stateOf(request),
    }

    if (request.cause !== undefined || sinceResponse === null) return row

    if (request.hidden) {
      const background =
        lastMark(marks, 'background', request.startedAt)?.background ??
        this.#backgroundAtStart()

      return { ...row, note: 'tab hidden', bad: !background }
    }

    const visibility = lastMark(marks, 'visibility', request.startedAt)
    const firstSinceBack =
      visibility !== undefined &&
      !visibility.hidden &&
      !requests.some(
        ({ startedAt }) =>
          startedAt >= visibility.at && startedAt < request.startedAt,
      )

    if (firstSinceBack) {
      return {
        ...row,
        note: `${request.startedAt - visibility.at} ms after coming back`,
      }
    }

    return { ...row, bad: Math.abs(sinceResponse - INTERVAL) > TOLERANCE }
  }

  #markRow(mark: Mark, index: number): MarkRow {
    let text: string

    if (mark.kind === 'visibility') {
      text = mark.hidden ? 'tab hidden' : 'tab back'
    } else {
      text = `${mark.background ? 'keep polling' : 'pause'} in a hidden tab`
    }

    return {
      kind: 'mark',
      key: `mark ${index}`,
      at: (mark.at - this.#startedAt()) / 1000,
      text,
    }
  }

  // Records the tab hiding or coming back during a run.
  #markVisibility(): void {
    const hidden = this.#document.visibilityState === 'hidden'
    const last = lastMark(this.#marks(), 'visibility', Infinity)

    if (!this.running() || (last?.hidden ?? false) === hidden) return

    this.#marks.update((marks) => [
      ...marks,
      { kind: 'visibility', at: Date.now(), hidden },
    ])
  }

  #endHide(): void {
    if (this.#hideEndsAt() === 0) return

    clearTimeout(this.#hideTimer)
    this.#hideEndsAt.set(0)
    this.#setVisibility('visible')
    Reflect.deleteProperty(this.#document, 'visibilityState')
  }

  #setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(this.#document, 'visibilityState', {
      configurable: true,
      get: () => state,
    })
    this.#document.dispatchEvent(new Event('visibilitychange'))
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

// The last mark of this kind up to `at`; undefined if there's none.
function lastMark<K extends Mark['kind']>(
  marks: readonly Mark[],
  kind: K,
  at: number,
): Extract<Mark, { kind: K }> | undefined {
  for (let index = marks.length - 1; index >= 0; index--) {
    const mark = marks[index]

    if (mark.kind === kind && mark.at <= at) {
      return mark as Extract<Mark, { kind: K }>
    }
  }

  return undefined
}

function since(from: number | null, to: number): number | null {
  return from === null ? null : to - from
}

function stateOf(request: PollRequest): RequestRow['state'] {
  if (request.cancelled) return 'cancelled'

  return request.resolvedAt === undefined ? 'in flight' : 'resolved'
}
