import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  computed,
  inject,
  signal,
} from '@angular/core'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import {
  type QueryKey,
  type QueryResult,
  injectQuery,
  injectQueryClient,
} from 'ngx-signal-query'
import { fromEvent, interval, map } from 'rxjs'

import { Log } from '../../core/log/log'
import { FocusTrace, LATENCY } from '../focus-trace'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const KEY: QueryKey = ['focus-demo']

/** The staleTime of the rows whose data stays fresh for a while, in ms. */
const FRESH_FOR = 60_000

type EventKind = 'tab return' | 'online' | 'tab return + online'

/** One row: a component on screen, and the options its query runs with. */
type RowSpec = {
  id: string
  label: string
  /** Its query's results: one per component showing the key. */
  results: Array<QueryResult<string>>
  staleTime: number
  /** Whether an event should refetch it, given whether its data is stale. */
  refetches: (stale: boolean) => boolean
}

/** A row as the table shows it. */
type Row = {
  label: string
  shows: string
  actual: number
  /** What actual should be; unset until the first event. */
  expected?: number
  bad: boolean
}

/** What a component shows: its data, else whether it's loading. */
function shown(result: QueryResult<string>): string {
  const data = result.data()

  if (data === undefined) return result.isFetching() ? 'loading…' : '—'

  return result.isFetching() ? `${data} · fetching` : data
}

/**
 * Repro for issue #28. Coming back to the tab, or getting the network back,
 * should refetch the queries on screen whose data is stale: once per query,
 * however many components show it, keeping a request already in flight. Each
 * row is a component, and the table counts its requests since the last event
 * next to what the event should have sent.
 */
@Component({
  selector: 'app-focus-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [FocusTrace],
  templateUrl: './focus-demo.html',
  styleUrl: './focus-demo.scss',
})
export class FocusDemo {
  readonly #client = injectQueryClient()
  readonly #document = inject(DOCUMENT)
  readonly #window = this.#document.defaultView!
  readonly #log = inject(Log)
  readonly #trace = inject(FocusTrace)

  // Where a row sets refetchOnWindowFocus and refetchOnReconnect, it sets
  // both to the same value, so both events expect the same of it.
  readonly #defaults = injectQuery(() => ({
    queryKey: [...KEY, 'defaults'],
    queryFn: () => this.#trace.request('defaults'),
  }))

  readonly #fresh = injectQuery(() => ({
    queryKey: [...KEY, 'fresh'],
    queryFn: () => this.#trace.request('fresh'),
    staleTime: FRESH_FOR,
  }))

  readonly #always = injectQuery(() => ({
    queryKey: [...KEY, 'always'],
    queryFn: () => this.#trace.request('always'),
    staleTime: FRESH_FOR,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  }))

  readonly #off = injectQuery(() => ({
    queryKey: [...KEY, 'off'],
    queryFn: () => this.#trace.request('off'),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  }))

  // Three components showing one key, as three injectQuery calls do.
  readonly #shared = [1, 2, 3].map(() =>
    injectQuery(() => ({
      queryKey: [...KEY, 'shared'],
      queryFn: () => this.#trace.request('shared'),
    })),
  )

  readonly #disabled = injectQuery(() => ({
    queryKey: [...KEY, 'disabled'],
    queryFn: () => this.#trace.request('disabled'),
    enabled: false,
  }))

  readonly #specs: RowSpec[] = [
    {
      id: 'defaults',
      label: 'defaults',
      results: [this.#defaults],
      staleTime: 0,
      refetches: (stale) => stale,
    },
    {
      id: 'fresh',
      label: 'staleTime: 60_000',
      results: [this.#fresh],
      staleTime: FRESH_FOR,
      refetches: (stale) => stale,
    },
    {
      id: 'always',
      label: "staleTime: 60_000, refetchOn…: 'always'",
      results: [this.#always],
      staleTime: FRESH_FOR,
      refetches: () => true,
    },
    {
      id: 'off',
      label: 'refetchOn…: false',
      results: [this.#off],
      staleTime: 0,
      refetches: () => false,
    },
    {
      id: 'shared',
      label: '3 components, defaults',
      results: this.#shared,
      staleTime: 0,
      refetches: (stale) => stale,
    },
    {
      id: 'disabled',
      label: 'enabled: false',
      results: [this.#disabled],
      staleTime: 0,
      refetches: () => false,
    },
  ]

  /**
   * The last event, with what each row should have sent for it, worked out
   * when it happened.
   */
  readonly #event = signal<{
    kind: EventKind
    at: number
    expected: Record<string, number>
  } | null>(null)

  /** Ticks every second, for how long the data the table shows stays fresh. */
  readonly #now = toSignal(interval(1000).pipe(map(() => Date.now())), {
    initialValue: Date.now(),
  })

  // Set while wakeUp() fires its two events, which count as one.
  #waking = false

  protected readonly latency = LATENCY
  protected readonly since = computed(() => this.#event()?.kind ?? 'mount')

  protected readonly rows = computed((): Row[] => {
    const event = this.#event()

    return this.#specs.map((spec) => {
      const actual = this.#trace.sentSince(spec.id, event?.at ?? 0)
      const expected = event?.expected[spec.id]
      const shows = [spec.results.map(shown).join(' · '), this.#freshness(spec)]

      return {
        label: spec.label,
        shows: shows.filter(Boolean).join(' · '),
        actual,
        expected,
        bad: expected !== undefined && actual !== expected,
      }
    })
  })

  constructor() {
    // The demo's bookkeeping: each event starts a new count, whether a
    // button fired it or the browser did. The library's listener was added
    // first, so it runs first; the count goes by the event's time, not by
    // the order the listeners run in.
    fromEvent(this.#document, 'visibilitychange')
      .pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (this.#document.visibilityState === 'hidden') return

        this.#mark(
          this.#waking ? 'tab return + online' : 'tab return',
          event.timeStamp,
        )
      })

    fromEvent(this.#window, 'online')
      .pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (!this.#waking) this.#mark('online', event.timeStamp)
      })

    // What the disabled row shows: it never fetches.
    this.#client.setQueryData([...KEY, 'disabled'], 'seeded')
  }

  protected leaveAndComeBack(): void {
    this.#hideAndShow()
  }

  protected goOfflineAndBack(): void {
    this.#window.dispatchEvent(new Event('offline'))
    this.#window.dispatchEvent(new Event('online'))
  }

  // Both events, as when a laptop wakes up.
  protected wakeUp(): void {
    this.#waking = true

    try {
      this.#hideAndShow()
      this.goOfflineAndBack()
    } finally {
      this.#waking = false
    }
  }

  // Hides the page, then shows it again, as switching to another tab and
  // back does: visibilityState changes and visibilitychange fires each time.
  // The real visibilityState comes back afterwards.
  #hideAndShow(): void {
    for (const state of ['hidden', 'visible'] as const) {
      Object.defineProperty(this.#document, 'visibilityState', {
        configurable: true,
        get: () => state,
      })
      this.#document.dispatchEvent(new Event('visibilitychange'))
    }

    Reflect.deleteProperty(this.#document, 'visibilityState')
  }

  // Works out what each row should send for the event: one request if the
  // event should refetch it, none if a request was already in flight, as
  // that one is kept. Stale is the library's rule: no data yet, invalidated,
  // or older than its staleTime.
  #mark(kind: EventKind, at: number): void {
    const expected: Record<string, number> = {}

    for (const spec of this.#specs) {
      const state = this.#client
        .getQueryCache()
        .find([...KEY, spec.id])
        ?.state()
      const stale =
        state?.status !== 'success' ||
        state.isInvalidated ||
        Date.now() - state.updatedAt >= spec.staleTime

      expected[spec.id] =
        !this.#trace.inFlightAt(spec.id, at) && spec.refetches(stale) ? 1 : 0
    }

    this.#event.set({ kind, at, expected })
    this.#log.add(`focus demo · ${kind}`, 'ui')
  }

  // How long the row's data stays fresh, for the rows with a staleTime.
  #freshness(spec: RowSpec): string {
    if (!spec.staleTime) return ''

    const state = this.#client
      .getQueryCache()
      .find([...KEY, spec.id])
      ?.state()

    if (state?.status !== 'success') return ''

    // The clock ticks once a second, so the data can be newer than its tick.
    const age = Math.max(0, this.#now() - state.updatedAt)
    const left = spec.staleTime - age

    return left > 0 ? `fresh ${Math.ceil(left / 1000)} s` : 'stale'
  }
}
