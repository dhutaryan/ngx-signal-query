import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core'

import { Log } from '../../core/log/log'
import {
  QueriesFieldBelow,
  QueriesRequiredInput,
  QueryFieldBelow,
  QueryRequiredInput,
} from '../cases'

type CaseId = 'query-input' | 'query-field' | 'queries-input' | 'queries-field'

/**
 * Repro for issue #14: options must not be evaluated while the component is
 * being constructed. Cases are mounted on demand, so a failing one can't take
 * the rest of the playground down with it.
 */
@Component({
  selector: 'app-lazy-options-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    QueryRequiredInput,
    QueryFieldBelow,
    QueriesRequiredInput,
    QueriesFieldBelow,
  ],
  templateUrl: './lazy-options-demo.html',
  styleUrl: './lazy-options-demo.scss',
})
export class LazyOptionsDemo {
  readonly #log = inject(Log)

  protected readonly mounted = signal<ReadonlySet<CaseId>>(new Set())

  protected toggle(id: CaseId): void {
    const mounted = new Set(this.mounted())
    const wasMounted = mounted.has(id)

    if (wasMounted) mounted.delete(id)
    else mounted.add(id)

    this.mounted.set(mounted)
    this.#log.add(`${wasMounted ? 'unmount' : 'mount'} ${id}`, 'ui')
  }
}
