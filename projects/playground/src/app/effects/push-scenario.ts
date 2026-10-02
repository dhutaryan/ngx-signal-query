import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core'
import { type QueryKey, injectQuery, injectQueryClient } from 'ngx-signal-query'

import { Log } from '../core/log/log'
import { EffectTrace } from './effect-trace'
import { type CounterRow, ScenarioCard } from './scenario-card'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const PUSH_KEY: QueryKey = ['effects-demo', 'push']
const todoKey = (id: number): QueryKey => [...PUSH_KEY, 'todo', id]

/** A message from the server, as a WebSocket service would expose it. */
type ServerEvent = { type: 'todos-changed' }

const CODE = `effect(() => {
  if (this.socket.lastEvent()?.type === 'todos-changed') {
    client.invalidateQueries({ queryKey: ['push'] })
  }
})`

/**
 * Refetches a list when the server says it changed: an effect invalidates the
 * list whenever a new message arrives. A message should refetch the list once,
 * and nothing else should.
 */
@Component({
  selector: 'app-push-scenario',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScenarioCard],
  providers: [EffectTrace],
  template: `
    <app-scenario-card
      heading="Refetch on a server push"
      api="invalidateQueries"
      [code]="code"
      [since]="since()"
      [rows]="rows()"
      [stopped]="trace.stopped()"
    >
      <button (click)="push()">server push</button>
      <button (click)="open()">open todo #{{ nextTodo() }}</button>
      <span class="state">open one after a push</span>
    </app-scenario-card>
  `,
  styleUrl: './scenario.scss',
})
export class PushScenario {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)

  /** The last message from the server; null until the first one. */
  readonly #lastEvent = signal<ServerEvent | null>(null)
  /** What the last action should cost. */
  readonly #expected = signal({ runs: 1, list: 1 })

  protected readonly trace = inject(EffectTrace)
  protected readonly code = CODE
  protected readonly since = signal('mount')
  protected readonly nextTodo = signal(1)

  protected readonly list = injectQuery(() => ({
    queryKey: [...PUSH_KEY, 'todos'],
    queryFn: () => this.trace.request('GET /todos', 'todos'),
  }))

  protected readonly rows = computed((): CounterRow[] => [
    {
      label: 'effect runs',
      actual: this.trace.runs(),
      expected: this.#expected().runs,
    },
    {
      label: 'list requests',
      actual: this.trace.count((label) => label === 'GET /todos'),
      expected: this.#expected().list,
    },
  ])

  constructor() {
    effect(() => {
      // The demo's run counter: false once the effect ran too often.
      const allowed = this.trace.run()

      if (this.#lastEvent()?.type === 'todos-changed' && allowed) {
        this.#client.invalidateQueries({ queryKey: PUSH_KEY })
      }
    })
  }

  protected push(): void {
    this.#act('server push', { runs: 1, list: 1 })
    // A new object per message, as a socket delivers them.
    this.#lastEvent.set({ type: 'todos-changed' })
  }

  /**
   * Prefetches a todo, as a hover handler would before opening it. It only
   * adds an entry to the cache: neither the effect nor the list cares.
   */
  protected open(): void {
    const id = this.nextTodo()

    this.#act(`open todo #${id}`, { runs: 0, list: 0 })
    this.nextTodo.set(id + 1)
    this.#client.fetchQuery(todoKey(id), () =>
      this.trace.request(`GET /todos/${id}`, id),
    )
  }

  #act(since: string, expected: { runs: number; list: number }): void {
    this.trace.reset()
    this.since.set(since)
    this.#expected.set(expected)
    this.#log.add(`effects demo · ${since}`, 'ui')
  }
}
