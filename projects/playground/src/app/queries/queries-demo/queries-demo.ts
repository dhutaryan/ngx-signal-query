import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core'
import { injectQueries } from 'ngx-signal-query'

import { Log } from '../../core/log/log'
import { TodoQueries } from '../../mutations/todos.queries'

/** An id neither backend has, so this one item errors while the rest load. */
const MISSING_ID = 9999

@Component({
  selector: 'app-queries-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './queries-demo.html',
  styleUrl: './queries-demo.scss',
})
export class QueriesDemo {
  readonly #queries = inject(TodoQueries)
  readonly #log = inject(Log)

  protected readonly ids = signal([1, 2, 3])

  // One query per id, matched by key. Adding, removing or shuffling ids only
  // touches the queries whose keys actually came or went — and since the
  // details use staleTime 0 (stale at once), the fact that the others are NOT
  // refetched on every change is down to the fetch reacting to key changes,
  // not to the options object being rebuilt.
  protected readonly todos = injectQueries(() => ({
    queries: this.ids().map((id) => this.#queries.detail(id)),
  }))

  protected readonly pending = computed(
    () => this.todos().filter((todo) => todo.isPending()).length,
  )

  protected readonly fetching = computed(
    () => this.todos().filter((todo) => todo.isFetching()).length,
  )

  protected readonly errors = computed(
    () => this.todos().filter((todo) => todo.isError()).length,
  )

  protected add(): void {
    const known = this.ids().filter((id) => id !== MISSING_ID)
    const next = Math.max(0, ...known) + 1

    this.#setIds([...this.ids(), next])
  }

  protected addMissing(): void {
    if (this.ids().includes(MISSING_ID)) return

    this.#setIds([...this.ids(), MISSING_ID])
  }

  protected remove(id: number): void {
    this.#setIds(this.ids().filter((other) => other !== id))
  }

  protected shuffle(): void {
    this.#setIds([...this.ids()].sort(() => Math.random() - 0.5))
  }

  protected refetchAll(): void {
    this.#log.add('refetch() on every result', 'ui')
    this.todos().forEach((todo) => todo.refetch())
  }

  #setIds(ids: number[]): void {
    this.ids.set(ids)
    this.#log.add(`ids → [${ids.join(', ')}]`, 'ui')
  }
}
