import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { RemovalTrace, describe, held, shown } from './removal-trace'
import { RemovalView, VIEW_OPTIONS } from './removal-view'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const KEY: QueryKey = ['removal-demo', 'todos']

const CODE = `injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => api.todos(),
  staleTime: Infinity,
}))`

/**
 * Two lists on one key that never goes stale, as in the issue. After
 * removeQueries, whatever puts the key back in the cache should reach both:
 * a refetch, a write, an invalidation, a list mounted later.
 */
@Component({
  selector: 'app-reset-scenario',
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
          staleTime: Infinity,
        }
      },
    },
  ],
  template: `
    <app-removal-card
      heading="Reset, then edit"
      [code]="code"
      [since]="since()"
      [rows]="rows()"
    >
      <button (click)="remove()">removeQueries</button>
      <button (click)="refetch()">list A: refetch()</button>
      <button (click)="write()">setQueryData</button>
      <button (click)="invalidate()">invalidateQueries</button>
      <button (click)="toggleB()" [class.on]="mountedB()">
        {{ mountedB() ? 'unmount' : 'mount' }} list B
      </button>
    </app-removal-card>

    <app-removal-view #a />

    @if (mountedB()) {
      <app-removal-view #b />
    }
  `,
  styleUrl: './scenario.scss',
})
export class ResetScenario {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)
  readonly #trace = inject(RemovalTrace)

  protected readonly listA = viewChild<RemovalView>('a')
  protected readonly listB = viewChild<RemovalView>('b')

  /** What each list showed right after the last removal. */
  readonly #kept = signal<Record<string, string>>({})
  /** Requests before the last action. */
  readonly #before = signal(0)
  #edits = 0

  /**
   * The key's entry, live: undefined while the cache has none. The cache
   * itself is reactive, unlike the client's reads.
   */
  readonly #entry = computed(() =>
    this.#client
      .getQueryCache()
      .findAll({ queryKey: KEY, exact: true })[0]
      ?.state(),
  )

  protected readonly code = CODE
  protected readonly since = signal('mount')
  protected readonly mountedB = signal(false)

  protected readonly rows = computed((): CardRow[] => {
    // The lists before the entry: the first read of a list's result puts the
    // key in the cache, and #entry read earlier in this computed would keep
    // the value from before that.
    const lists = [
      ['list A', this.listA()] as const,
      ['list B', this.listB()] as const,
    ].flatMap(([label, list]) =>
      list ? [[label, shown(list.result)] as const] : [],
    )
    const entry = this.#entry()
    const cache = entry ? held(entry) : undefined

    return [
      ...lists.map(([label, actual]) =>
        viewRow(`${label} shows`, actual, cache, this.#kept()[label]),
      ),
      {
        label: 'the cache holds',
        actual: entry ? describe(entry) : '— (no entry)',
        bad: false,
      },
      {
        label: 'requests',
        actual: String(this.#trace.total() - this.#before()),
        bad: false,
      },
    ]
  })

  protected remove(): void {
    this.#act('removeQueries')
    this.#client.removeQueries({ queryKey: KEY })

    // Read after the removal: it cancels a fetch in flight.
    const lists = { 'list A': this.listA(), 'list B': this.listB() }

    this.#kept.set(
      Object.fromEntries(
        Object.entries(lists).flatMap(([label, list]) =>
          list ? [[label, shown(list.result)]] : [],
        ),
      ),
    )
  }

  protected refetch(): void {
    this.#act('list A: refetch()')
    this.listA()?.result.refetch()
  }

  protected write(): void {
    const value = `edit ${++this.#edits}`

    this.#act(`setQueryData('${value}')`)
    this.#client.setQueryData(KEY, value)
  }

  protected invalidate(): void {
    this.#act('invalidateQueries')
    this.#client.invalidateQueries({ queryKey: KEY })
  }

  protected toggleB(): void {
    this.#act(this.mountedB() ? 'unmount list B' : 'mount list B')
    this.mountedB.update((mounted) => !mounted)
  }

  #act(since: string): void {
    this.since.set(since)
    this.#before.set(this.#trace.total())
    this.#log.add(`removal demo · ${since}`, 'ui')
  }
}
