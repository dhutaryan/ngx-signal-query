import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core'
import {
  type QueryKey,
  type QueryOptions,
  injectQueryClient,
} from 'ngx-signal-query'

import { Log } from '../core/log/log'
import { type CardRow, RemovalCard, viewRow } from './removal-card'
import { LATENCY, RemovalTrace, describe, held, shown } from './removal-trace'
import { RemovalView, VIEW_OPTIONS } from './removal-view'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const KEY: QueryKey = ['removal-demo', 'feed']

/** The polling interval, in ms. */
const INTERVAL = 1000

/** The span of the request count, in ms. */
const WINDOW = 5000

const CODE = `injectQuery(() => ({
  queryKey: ['feed'],
  queryFn: () => api.feed(),
  refetchInterval: ${INTERVAL},
}))`

/**
 * Widgets polling one key. After removeQueries, the next poll should put the
 * key back in the cache, and the widgets on the key should poll it together:
 * one request per interval, however many there are.
 */
@Component({
  selector: 'app-polling-widget-scenario',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RemovalCard, RemovalView],
  providers: [
    RemovalTrace,
    {
      provide: VIEW_OPTIONS,
      useFactory: (): QueryOptions<string> => {
        const trace = inject(RemovalTrace)

        return {
          queryKey: KEY,
          queryFn: () => trace.request(),
          refetchInterval: INTERVAL,
        }
      },
    },
  ],
  template: `
    <app-removal-card
      heading="Polling widget"
      [code]="code"
      [since]="since()"
      [rows]="rows()"
    >
      <button (click)="toggleRunning()" [class.on]="running()">
        {{ running() ? 'stop' : 'start' }}
      </button>
      <button (click)="remove()" [disabled]="!running()">removeQueries</button>
      <button
        (click)="toggleB()"
        [class.on]="mountedB()"
        [disabled]="!running()"
      >
        {{ mountedB() ? 'unmount' : 'mount' }} widget B
      </button>
    </app-removal-card>

    @if (running()) {
      <app-removal-view #a />

      @if (mountedB()) {
        <app-removal-view #b />
      }
    }
  `,
  styleUrl: './scenario.scss',
})
export class PollingWidgetScenario {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)
  readonly #trace = inject(RemovalTrace)

  protected readonly widgetA = viewChild<RemovalView>('a')
  protected readonly widgetB = viewChild<RemovalView>('b')

  /** What each widget showed right after the last removal. */
  readonly #kept = signal<Record<string, string>>({})
  /** When the current run started. */
  readonly #startedAt = signal(0)
  /** Ticks while running, for the request count. */
  readonly #now = signal(0)

  /** The key's entry, live: undefined while the cache has none. */
  readonly #entry = computed(() =>
    this.#client
      .getQueryCache()
      .findAll({ queryKey: KEY, exact: true })[0]
      ?.state(),
  )

  protected readonly code = CODE
  protected readonly since = signal('—')
  protected readonly running = signal(false)
  protected readonly mountedB = signal(false)

  /** A poll INTERVAL after each response: one per INTERVAL + LATENCY. */
  protected readonly expectedPerWindow = Math.round(
    WINDOW / (INTERVAL + LATENCY),
  )

  protected readonly rows = computed((): CardRow[] => {
    // The widgets before the entry: the first read of a widget's result puts
    // the key in the cache, and #entry read earlier in this computed would
    // keep the value from before that.
    const widgets = [
      ['widget A', this.widgetA()] as const,
      ['widget B', this.widgetB()] as const,
    ].flatMap(([label, widget]) =>
      widget ? [[label, shown(widget.result)] as const] : [],
    )
    const entry = this.#entry()
    const cache = entry ? held(entry) : undefined
    const now = this.#now()
    const startedAt = this.#startedAt()
    const perWindow = this.#trace
      .sentAt()
      .filter((at) => at >= startedAt && now - at <= WINDOW).length
    // Judged once a whole window has passed since the start.
    const judged = this.running() && now - startedAt >= WINDOW

    return [
      ...widgets.map(([label, actual]) =>
        viewRow(`${label} shows`, actual, cache, this.#kept()[label]),
      ),
      {
        label: 'the cache holds',
        actual: entry ? describe(entry) : '— (no entry)',
        bad: false,
      },
      {
        label: `requests in the last ${WINDOW / 1000} s`,
        actual: String(perWindow),
        expected: `≈ ${this.expectedPerWindow}`,
        bad: judged && Math.abs(perWindow - this.expectedPerWindow) > 1,
      },
    ]
  })

  constructor() {
    // The clock behind the request count.
    effect((onCleanup) => {
      if (!this.running()) return

      const id = setInterval(() => this.#now.set(Date.now()), 250)

      onCleanup(() => clearInterval(id))
    })
  }

  protected toggleRunning(): void {
    if (this.running()) {
      this.#act('stop')
      this.running.set(false)
      this.mountedB.set(false)

      return
    }

    // A fresh query each run, so every run starts with the fetch on mount.
    // No widget is mounted yet, so nothing shows the key.
    this.#client.removeQueries({ queryKey: KEY })
    this.#kept.set({})
    this.#startedAt.set(Date.now())
    this.#now.set(Date.now())
    this.#act('start')
    this.running.set(true)
  }

  protected remove(): void {
    this.#act('removeQueries')
    this.#client.removeQueries({ queryKey: KEY })

    // Read after the removal: it cancels a fetch in flight.
    const widgets = { 'widget A': this.widgetA(), 'widget B': this.widgetB() }

    this.#kept.set(
      Object.fromEntries(
        Object.entries(widgets).flatMap(([label, widget]) =>
          widget ? [[label, shown(widget.result)]] : [],
        ),
      ),
    )
  }

  protected toggleB(): void {
    this.#act(this.mountedB() ? 'unmount widget B' : 'mount widget B')
    this.mountedB.update((mounted) => !mounted)
  }

  #act(since: string): void {
    this.since.set(since)
    this.#log.add(`removal demo · polling widget · ${since}`, 'ui')
  }
}
