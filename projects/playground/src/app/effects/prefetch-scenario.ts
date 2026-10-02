import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core'
import {
  type QueryKey,
  injectQuery,
  injectQueryClient,
  keepPreviousData,
} from 'ngx-signal-query'

import { Log } from '../core/log/log'
import { EffectTrace } from './effect-trace'
import { type CounterRow, ScenarioCard } from './scenario-card'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const pageKey = (page: number): QueryKey => ['effects-demo', 'pages', page]

const CODE = `effect(() => {
  const next = this.page() + 1

  client.fetchQuery(['pages', next], () => api.page(next))
})`

/**
 * A paged list that prefetches the next page from an effect, as TanStack's
 * pagination guide does. Each page change should prefetch the next page once.
 */
@Component({
  selector: 'app-prefetch-scenario',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScenarioCard],
  providers: [EffectTrace],
  template: `
    <app-scenario-card
      heading="Prefetch the next page"
      api="fetchQuery"
      [code]="code"
      [since]="since()"
      [rows]="rows()"
      [stopped]="trace.stopped()"
    >
      <button (click)="go(-1)" [disabled]="page() === 1">‹ prev</button>
      <span>page {{ page() }}</span>
      <button (click)="go(1)">next ›</button>
      <span class="state">
        {{ list.isPlaceholderData() ? 'loading…' : 'loaded' }}
      </span>
    </app-scenario-card>
  `,
  styleUrl: './scenario.scss',
})
export class PrefetchScenario {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)

  protected readonly trace = inject(EffectTrace)
  protected readonly code = CODE
  protected readonly page = signal(1)
  protected readonly since = signal('mount')

  protected readonly list = injectQuery(() => ({
    queryKey: pageKey(this.page()),
    queryFn: () => this.trace.request(`GET /pages/${this.page()}`, this.page()),
    placeholderData: keepPreviousData,
  }))

  protected readonly rows = computed((): CounterRow[] => {
    const next = this.page() + 1

    return [
      { label: 'effect runs', actual: this.trace.runs(), expected: 1 },
      {
        label: `requests for page ${next}`,
        actual: this.trace.count((label) => label === `GET /pages/${next}`),
        expected: 1,
      },
    ]
  })

  constructor() {
    effect(() => {
      // The demo's run counter: false once the effect ran too often.
      const allowed = this.trace.run()
      const next = this.page() + 1

      if (!allowed) return

      this.#client.fetchQuery(pageKey(next), () =>
        this.trace.request(`GET /pages/${next}`, next),
      )
    })
  }

  protected go(delta: number): void {
    const page = this.page() + delta

    this.trace.reset()
    this.since.set(`page ${page}`)
    this.#log.add(`effects demo · page ${page}`, 'ui')
    this.page.set(page)
  }
}
