import {
  ChangeDetectionStrategy,
  Component,
  InjectionToken,
  inject,
} from '@angular/core'
import { type QueryOptions, injectQuery } from 'ngx-signal-query'

/**
 * The options of a scenario's components, provided by the scenario. Not an
 * input: the card reads a component's result in the scenario's own template,
 * before the component's inputs would be set.
 */
export const VIEW_OPTIONS = new InjectionToken<QueryOptions<string>>(
  'VIEW_OPTIONS',
)

/**
 * A component showing a scenario's key, mounted on demand. It renders
 * nothing: the card's table says what it shows.
 */
@Component({
  selector: 'app-removal-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
export class RemovalView {
  // optionsFn runs after construction, once #options is set.
  readonly result = injectQuery(() => this.#options)

  readonly #options = inject(VIEW_OPTIONS)
}
