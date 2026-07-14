import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core'

import { Log } from './core/log/log'
import { MutationDemo } from './mutations/mutation-demo/mutation-demo'
import { TodosApi } from './mutations/todos-api'

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MutationDemo],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly api = inject(TodosApi)
  protected readonly log = inject(Log)

  /** Unmounting the demo is how we test what happens to in-flight mutations. */
  protected readonly mounted = signal(true)

  protected toggleBackend(): void {
    this.api.backend.update((backend) => (backend === 'real' ? 'fake' : 'real'))
    this.log.add(`backend → ${this.api.backend()}`, 'ui')
  }

  protected toggleFail(): void {
    this.api.shouldFail.update((fail) => !fail)
    this.log.add(`shouldFail → ${this.api.shouldFail()}`, 'ui')
  }

  protected toggleMount(): void {
    this.mounted.update((mounted) => !mounted)
    this.log.add(this.mounted() ? 'demo mounted' : 'demo DESTROYED', 'ui')
  }
}
