import { ChangeDetectionStrategy, Component } from '@angular/core'

import { LATENCY, RUN_LIMIT } from '../effect-trace'
import { NoteSwitchScenario } from '../note-switch-scenario'
import { OptimisticSaveScenario } from '../optimistic-save-scenario'
import { PrefetchScenario } from '../prefetch-scenario'
import { PushScenario } from '../push-scenario'
import { ReconnectScenario } from '../reconnect-scenario'

/**
 * Repro for issue #31: an effect that calls the library should depend only on
 * what it reads itself, not on what the call reads on its behalf. Each card is
 * an effect from an app; its counters show how often it ran and what it sent.
 */
@Component({
  selector: 'app-effects-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PrefetchScenario,
    ReconnectScenario,
    PushScenario,
    OptimisticSaveScenario,
    NoteSwitchScenario,
  ],
  templateUrl: './effects-demo.html',
  styleUrl: './effects-demo.scss',
})
export class EffectsDemo {
  protected readonly latency = LATENCY
  protected readonly runLimit = RUN_LIMIT
}
