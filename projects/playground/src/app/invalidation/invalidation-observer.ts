import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core'
import { injectQuery } from 'ngx-signal-query'

import { TodosApi } from '../mutations/todos-api'
import { RequestTrace } from './request-trace'

/** Slow enough (1.2 s) to click again while a request is in flight. */
const TODO_ID = 4

/** Not under ['todos'], so the other demos' invalidations can't touch it. */
export const INVALIDATION_DEMO_KEY = ['invalidation-demo', TODO_ID] as const

/** One of several components observing the same key, as on a real page. */
@Component({
  selector: 'app-invalidation-observer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="n">#{{ n() }}</span>
    <code>{{ todo.status() }}</code>
    <code [class.fetching]="todo.isFetching()">
      {{ todo.isFetching() ? 'fetching' : 'idle' }}
    </code>
    <span>{{ todo.data()?.title }}</span>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: 2rem 5rem 5rem 1fr;
      align-items: baseline;
      gap: 0.5rem;
      padding: 0.25rem 0;
      font-size: 0.9rem;
    }

    .n {
      color: #57606a;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #f6f8fa;
      padding: 0.05rem 0.3rem;
      border-radius: 4px;
      font-size: 0.85em;
    }

    .fetching {
      background: #fff1e5;
    }
  `,
})
export class InvalidationObserver {
  readonly n = input.required<number>()
  readonly staleTime = input.required<number>()

  readonly #api = inject(TodosApi)
  readonly #trace = inject(RequestTrace)

  protected readonly todo = injectQuery(() => ({
    queryKey: INVALIDATION_DEMO_KEY,
    queryFn: () => this.#trace.request(this.n(), () => this.#api.get(TODO_ID)),
    staleTime: this.staleTime(),
    // A failed request would be retried, which would muddy the counters.
    retry: 0,
  }))
}
