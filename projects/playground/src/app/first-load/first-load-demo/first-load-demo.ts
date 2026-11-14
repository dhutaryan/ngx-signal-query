import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core'
import {
  type QueryKey,
  injectMutation,
  injectQuery,
  injectQueryClient,
} from 'ngx-signal-query'

import { Log } from '../../core/log/log'
import {
  FirstLoadTrace,
  LIST_LATENCY,
  SOCKET_INTERVAL,
  WRITE_LATENCY,
} from '../first-load-trace'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const PREFIX: QueryKey = ['first-load-demo']

/** Timer and change detection jitter allowed on top of LIST_LATENCY. */
const SLACK = 300

/**
 * Demo of issue #33: a refetch asked for while a query's first load still
 * runs. Start mounts the list on a key of its own, so its first load begins
 * then. The buttons and the socket ask for a refetch the ways an app does,
 * and the table judges the first load: whether it showed as it landed, and
 * whether anything cancelled it.
 */
@Component({
  selector: 'app-first-load-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [FirstLoadTrace],
  templateUrl: './first-load-demo.html',
  styleUrl: './first-load-demo.scss',
})
export class FirstLoadDemo {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)

  protected readonly trace = inject(FirstLoadTrace)
  protected readonly listLatency = LIST_LATENCY
  protected readonly writeLatency = WRITE_LATENCY
  protected readonly socketInterval = SOCKET_INTERVAL

  /** How many times Start was pressed; 0 before the first. */
  protected readonly run = signal(0)
  protected readonly socket = signal(false)

  // Each Start gets a key of its own, so its first load starts from nothing.
  // Focus and reconnect refetches would add requests no button asked for.
  protected readonly list = injectQuery(() => ({
    queryKey: [...PREFIX, this.run()],
    queryFn: () => this.trace.list(),
    enabled: this.run() > 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  }))

  // Returns the invalidation, as Invalidation from Mutations shows: the
  // mutation stays pending until the list is fresh.
  protected readonly save = injectMutation(() => ({
    mutationFn: () => this.trace.write(),
    onSuccess: () => this.#client.invalidateQueries({ queryKey: PREFIX }),
  }))

  /** Whether the first load is late, judged while it still runs too. */
  protected readonly late = computed(() => {
    const at = this.trace.firstDataAt() ?? this.trace.elapsed()

    return this.run() > 0 && at > LIST_LATENCY + SLACK
  })

  constructor() {
    // The timeline notes each version the list shows.
    effect(() => {
      const data = this.list.data()

      if (data) untracked(() => this.trace.shown(data.version))
    })

    // ...and when the mutation finishes, as its signals report it.
    effect(() => {
      const status = this.save.status()

      if (status !== 'success' && status !== 'error') return

      untracked(() => this.trace.note(`mutation ${status}`, 'outcome'))
    })

    // While the socket is on, a todo changes every SOCKET_INTERVAL ms, and
    // each message invalidates the list, as on the Query Invalidation page.
    effect((onCleanup) => {
      if (!this.socket()) return

      const id = setInterval(() => {
        this.trace.change()
        this.#client.invalidateQueries({ queryKey: PREFIX })
      }, SOCKET_INTERVAL)

      onCleanup(() => clearInterval(id))
    })
  }

  protected start(): void {
    // The previous run's query goes first: a fetch of it still in flight is
    // cancelled before the new timeline starts.
    this.#client.removeQueries({ queryKey: PREFIX })
    this.trace.start()
    this.run.update((run) => run + 1)
  }

  protected saveTodo(): void {
    this.save.mutate()
  }

  protected async refresh(): Promise<void> {
    this.trace.note('Refresh: refetch()', 'trigger')

    const { data } = await this.list.refetch()

    this.trace.note(
      `refetch() resolved: ${data ? `v${data.version}` : 'no data'}`,
      'outcome',
    )
  }

  protected toggleSocket(): void {
    this.socket.update((on) => !on)
    this.#log.add(
      `first-load demo · socket ${this.socket() ? 'on' : 'off'}`,
      'ui',
    )
  }

  protected seconds(ms: number): string {
    return `+${(ms / 1000).toFixed(1)} s`
  }
}
