import { ChangeDetectionStrategy, Component } from '@angular/core'

import { PollingWidgetScenario } from '../polling-widget-scenario'
import { LATENCY } from '../removal-trace'
import { ResetScenario } from '../reset-scenario'

/**
 * Repro for issue #37: after removeQueries, a component showing the key may
 * keep what it shows, but once anything puts the key back in the cache, it
 * should show what the cache holds. Each card compares the two.
 */
@Component({
  selector: 'app-removal-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ResetScenario, PollingWidgetScenario],
  templateUrl: './removal-demo.html',
  styleUrl: './removal-demo.scss',
})
export class RemovalDemo {
  protected readonly latency = LATENCY
}
