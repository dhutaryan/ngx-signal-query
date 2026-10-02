import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import { injectQuery } from 'ngx-signal-query'
import { fromEvent, scan } from 'rxjs'

import { Log } from '../core/log/log'
import { EffectTrace } from './effect-trace'
import { type CounterRow, ScenarioCard } from './scenario-card'

const CODE = `reconnects = toSignal(
  fromEvent(window, 'online').pipe(scan((count) => count + 1, 0)),
  { initialValue: 0 },
)

effect(() => {
  if (this.reconnects() > 0) this.todos.refetch()
})`

/**
 * Refetches a list when the browser comes back online, the way an app does it
 * by hand, since the library has no refetchOnReconnect yet (#28). Each
 * reconnect should cost one request.
 */
@Component({
  selector: 'app-reconnect-scenario',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScenarioCard],
  providers: [EffectTrace],
  template: `
    <app-scenario-card
      heading="Refetch when back online"
      api="refetch()"
      [code]="code"
      [since]="since()"
      [rows]="rows()"
      [stopped]="trace.stopped()"
    >
      <button (click)="reconnect()">fire an online event</button>
      <span class="state">
        or switch DevTools → Network to Offline and back
      </span>
    </app-scenario-card>
  `,
  styleUrl: './scenario.scss',
})
export class ReconnectScenario {
  readonly #window = inject(DOCUMENT).defaultView!
  readonly #log = inject(Log)

  /** How many times the browser came back online. */
  readonly #reconnects = toSignal(
    fromEvent(this.#window, 'online').pipe(scan((count) => count + 1, 0)),
    { initialValue: 0 },
  )

  protected readonly trace = inject(EffectTrace)
  protected readonly code = CODE
  protected readonly since = signal('mount')

  protected readonly todos = injectQuery(() => ({
    queryKey: ['effects-demo', 'reconnect'],
    queryFn: () => this.trace.request('GET /todos', 'todos'),
  }))

  protected readonly rows = computed((): CounterRow[] => [
    { label: 'effect runs', actual: this.trace.runs(), expected: 1 },
    { label: 'requests', actual: this.trace.requests().length, expected: 1 },
    { label: 'cancelled', actual: this.trace.cancelled(), expected: 0 },
  ])

  constructor() {
    // The demo's bookkeeping: every online event starts a new count, whether
    // the button fired it or the browser did. Listeners run before the effect,
    // which waits for change detection.
    fromEvent(this.#window, 'online')
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.trace.reset()
        this.since.set('online event')
        this.#log.add('effects demo · online event', 'ui')
      })

    effect(() => {
      // The demo's run counter: false once the effect ran too often.
      const allowed = this.trace.run()

      if (this.#reconnects() > 0 && allowed) this.todos.refetch()
    })
  }

  protected reconnect(): void {
    this.#window.dispatchEvent(new Event('online'))
  }
}
