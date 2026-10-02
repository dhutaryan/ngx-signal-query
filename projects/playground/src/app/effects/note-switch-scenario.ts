import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core'
import { type QueryKey, injectMutation, injectQuery } from 'ngx-signal-query'

import { Log } from '../core/log/log'
import { EffectTrace } from './effect-trace'
import { type CounterRow, ScenarioCard } from './scenario-card'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const noteKey = (id: number): QueryKey => ['effects-demo', 'notes', id]

const CODE = `effect(() => {
  const title = this.draft()

  if (title !== null) this.save.mutate(title)
})

// save's mutationFn, saving to the note that's open:
// (title) => api.saveNote(this.noteId(), title)`

/**
 * Saves a draft as it's typed, from an effect, into the note that's open.
 * Each change should be saved once; opening another note isn't a change, so
 * it should save nothing.
 */
@Component({
  selector: 'app-note-switch-scenario',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScenarioCard],
  providers: [EffectTrace],
  template: `
    <app-scenario-card
      heading="Auto-save, then open another note"
      api="mutate()"
      [code]="code"
      [since]="since()"
      [rows]="rows()"
      [stopped]="trace.stopped()"
    >
      @for (id of noteIds; track id) {
        <button (click)="open(id)" [class.on]="noteId() === id">
          note {{ id }}
        </button>
      }
      <input
        placeholder="type, then open the other note"
        (input)="type($event)"
      />
      <span class="state">
        open:
        <code>{{ note.data()?.title }}</code>
      </span>
    </app-scenario-card>
  `,
  styleUrl: './scenario.scss',
})
export class NoteSwitchScenario {
  readonly #log = inject(Log)

  /** What's typed in the field; null until the first keystroke. */
  readonly #draft = signal<string | null>(null)
  /** What the last action should cost. */
  readonly #expected = signal({ runs: 1, saves: 0 })

  protected readonly trace = inject(EffectTrace)
  protected readonly code = CODE
  protected readonly since = signal('mount')
  protected readonly noteIds = [1, 2]
  protected readonly noteId = signal(1)

  protected readonly note = injectQuery(() => ({
    queryKey: noteKey(this.noteId()),
    queryFn: () =>
      this.trace.request(`GET /notes/${this.noteId()}`, {
        title: `Note ${this.noteId()}`,
      }),
  }))

  protected readonly save = injectMutation(() => ({
    mutationFn: (title: string) =>
      this.trace.request(`PUT /notes/${this.noteId()} "${title}"`, { title }),
  }))

  protected readonly rows = computed((): CounterRow[] => [
    {
      label: 'effect runs',
      actual: this.trace.runs(),
      expected: this.#expected().runs,
    },
    {
      label: 'saves',
      actual: this.trace.count((label) => label.startsWith('PUT')),
      expected: this.#expected().saves,
    },
  ])

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

    this.#act(`typed "${title}"`, { runs: 1, saves: 1 })
    this.#draft.set(title)
  }

  protected open(id: number): void {
    if (id === this.noteId()) return

    this.#act(`open note ${id}`, { runs: 0, saves: 0 })
    this.noteId.set(id)
  }

  #act(since: string, expected: { runs: number; saves: number }): void {
    this.trace.reset()
    this.since.set(since)
    this.#expected.set(expected)
    this.#log.add(`effects demo · ${since}`, 'ui')
  }
}
