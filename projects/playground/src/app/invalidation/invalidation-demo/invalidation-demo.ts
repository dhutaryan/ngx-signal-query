import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core'
import { injectQueryClient } from 'ngx-signal-query'

import { Log } from '../../core/log/log'
import {
  INVALIDATION_DEMO_KEY,
  InvalidationObserver,
} from '../invalidation-observer'
import { RequestTrace } from '../request-trace'

/**
 * Repro for issue #15: one invalidateQueries() call should cost one request,
 * however many components observe the key. The counters show what it costs
 * now.
 */
@Component({
  selector: 'app-invalidation-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InvalidationObserver],
  providers: [RequestTrace],
  templateUrl: './invalidation-demo.html',
  styleUrl: './invalidation-demo.scss',
})
export class InvalidationDemo {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)

  protected readonly trace = inject(RequestTrace)

  protected readonly observerChoices = [1, 3]
  protected readonly staleTimeChoices = [0, 60_000]

  protected readonly observerCount = signal(3)
  protected readonly staleTime = signal(0)

  protected readonly observers = computed(() =>
    Array.from({ length: this.observerCount() }, (_, index) => index + 1),
  )

  protected setObserverCount(count: number): void {
    this.observerCount.set(count)
    this.#log.add(`invalidation demo: ${count} observer(s)`, 'ui')
  }

  protected setStaleTime(ms: number): void {
    this.staleTime.set(ms)
    this.#log.add(`invalidation demo: staleTime ${ms}`, 'ui')
  }

  protected invalidate(): void {
    this.trace.reset()
    this.#log.add(
      `invalidateQueries · ${this.observerCount()} observer(s), staleTime ${this.staleTime()}`,
      'ui',
    )
    this.#client.invalidateQueries({ queryKey: INVALIDATION_DEMO_KEY })
  }
}
