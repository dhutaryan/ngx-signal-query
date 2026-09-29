import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  signal,
} from '@angular/core'
import { injectQueries, injectQuery } from 'ngx-signal-query'

import { TodoQueries } from '../mutations/todos.queries'

// Each case reads, from its options, something that doesn't exist yet while
// the component is being constructed. If the options are evaluated lazily the
// case renders its todos; if eagerly, construction throws.

const QUERY_TEMPLATE = `
  <code>{{ todo.status() }}</code>
  {{ todo.data()?.title }}
`

const QUERIES_TEMPLATE = `
  @for (todo of todos(); track $index) {
    <div>
      <code>{{ todo.status() }}</code>
      {{ todo.data()?.title }}
    </div>
  }
`

/** The key reads an `input.required`, which the parent binds after construction. */
@Component({
  selector: 'app-query-required-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: QUERY_TEMPLATE,
})
export class QueryRequiredInput {
  readonly id = input.required<number>()

  readonly #queries = inject(TodoQueries)

  protected readonly todo = injectQuery(() => this.#queries.detail(this.id()))
}

/** `enabled` reads a field declared below the query. */
@Component({
  selector: 'app-query-field-below',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: QUERY_TEMPLATE,
})
export class QueryFieldBelow {
  readonly #queries = inject(TodoQueries)

  protected readonly todo = injectQuery(() => ({
    ...this.#queries.detail(1),
    enabled: this.enabled(),
  }))

  protected readonly enabled = signal(true)
}

/** The queries read an `input.required`, which the parent binds after construction. */
@Component({
  selector: 'app-queries-required-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: QUERIES_TEMPLATE,
})
export class QueriesRequiredInput {
  readonly ids = input.required<number[]>()

  readonly #queries = inject(TodoQueries)

  protected readonly todos = injectQueries(() => ({
    queries: this.ids().map((id) => this.#queries.detail(id)),
  }))
}

/** The queries read a field declared below them. */
@Component({
  selector: 'app-queries-field-below',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: QUERIES_TEMPLATE,
})
export class QueriesFieldBelow {
  readonly #queries = inject(TodoQueries)

  protected readonly todos = injectQueries(() => ({
    queries: this.ids().map((id) => this.#queries.detail(id)),
  }))

  protected readonly ids = signal([1, 2])
}
