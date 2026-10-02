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
  injectMutation,
  injectQuery,
  injectQueryClient,
} from 'ngx-signal-query'

import { Log } from '../core/log/log'
import { EffectTrace } from './effect-trace'
import { type CounterRow, ScenarioCard } from './scenario-card'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const NOTE_KEY: QueryKey = ['effects-demo', 'note']

type Note = { title: string }

const CODE = `effect(() => {
  const title = this.draft()

  if (title !== null) this.save.mutate(title)
})

// save's onMutate, the optimistic update from the docs:
// (title) => {
//   const previous = client.getQueryData(['note'])
//
//   client.setQueryData(['note'], { ...previous, title })
//
//   return { previous }
// }`

/**
 * Saves a note as it's typed, from an effect, with the optimistic update from
 * the docs: the cache shows the new title before the server confirms it. Each
 * change should be saved once.
 */
@Component({
  selector: 'app-optimistic-save-scenario',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScenarioCard],
  providers: [EffectTrace],
  template: `
    <app-scenario-card
      heading="Auto-save with an optimistic update"
      api="getQueryData + setQueryData"
      [code]="code"
      [since]="since()"
      [rows]="rows()"
      [stopped]="trace.stopped()"
    >
      <input placeholder="type a title" (input)="type($event)" />
      <span class="state">
        cache:
        <code>{{ note.data()?.title }}</code>
      </span>
    </app-scenario-card>
  `,
  styleUrl: './scenario.scss',
})
export class OptimisticSaveScenario {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)

  /** What's typed in the field; null until the first keystroke. */
  readonly #draft = signal<string | null>(null)

  protected readonly trace = inject(EffectTrace)
  protected readonly code = CODE
  protected readonly since = signal('mount')

  protected readonly note = injectQuery(() => ({
    queryKey: NOTE_KEY,
    queryFn: () => this.trace.request('GET /note', { title: 'Groceries' }),
  }))

  protected readonly save = injectMutation(() => ({
    mutationFn: (title: string) =>
      this.trace.request(`PUT /note "${title}"`, { title }),
    onMutate: (title: string) => {
      const previous = this.#client.getQueryData<Note>(NOTE_KEY)

      this.#client.setQueryData<Note>(NOTE_KEY, { ...previous, title })

      return { previous }
    },
  }))

  protected readonly rows = computed((): CounterRow[] => {
    const typed = this.since() !== 'mount'

    return [
      { label: 'effect runs', actual: this.trace.runs(), expected: 1 },
      {
        label: 'saves',
        actual: this.trace.count((label) => label.startsWith('PUT')),
        expected: typed ? 1 : 0,
      },
    ]
  })

  constructor() {
    effect(() => {
      // The demo's run counter: false once the effect ran too often.
      const allowed = this.trace.run()
      const title = this.#draft()

      if (title !== null && allowed) this.save.mutate(title)
    })
  }

  protected type(event: Event): void {
    const title = (event.target as HTMLInputElement).value

    this.trace.reset()
    this.since.set(`typed "${title}"`)
    this.#log.add(`effects demo · typed "${title}"`, 'ui')
    this.#draft.set(title)
  }
}
