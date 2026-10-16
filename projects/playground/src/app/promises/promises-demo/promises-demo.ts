import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core'
import {
  type MutationResult,
  type QueryKey,
  injectMutation,
  injectQuery,
  injectQueryClient,
} from 'ngx-signal-query'

import {
  type DemoAction,
  LIST_LATENCY,
  PromisesTrace,
  type TraceEntry,
  WRITE_LATENCY,
} from '../promises-trace'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const KEY: QueryKey = ['promises-demo', 'todos']

const LABELS: Record<DemoAction, string> = {
  waits: 'Add · waits for the list',
  'doesnt-wait': "Add · doesn't wait",
  'mutate-async': 'Add · mutateAsync',
  refresh: 'Refresh',
}

/**
 * Whether the last action did what it should, worked out from its timeline;
 * `ok` is unset while it's still running, or when there's nothing to judge.
 */
type Verdict = { ok?: boolean; text: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function verdictOf(
  action: DemoAction | null,
  entries: readonly TraceEntry[],
): Verdict {
  const first = (kind: TraceEntry['kind']) =>
    entries.find((entry) => entry.kind === kind)
  const list = first('list')
  const settled = first('settled')
  const resumed = first('promise')

  switch (action) {
    case null:
      return { text: '' }
    case 'waits':
      if (!settled) return { text: 'running…' }
      if (settled.text === 'mutation error') {
        return { text: 'The write failed, so there was nothing to refetch.' }
      }

      return list && settled.at >= list.at
        ? { ok: true, text: '✓ The mutation finished once the list was fresh.' }
        : { ok: false, text: '✗ The mutation finished before the list.' }
    case 'doesnt-wait':
      if (!settled) return { text: 'running…' }
      if (settled.text === 'mutation error') {
        return { text: 'The write failed, so there was nothing to refetch.' }
      }

      if (!list) return { text: 'finished; waiting for the list…' }

      return settled.at < list.at
        ? {
            ok: true,
            text: '✓ The mutation finished as the write landed; the list came later.',
          }
        : { ok: false, text: '✗ The mutation waited for the list.' }
    case 'mutate-async':
      if (!resumed) return { text: 'running…' }
      if (resumed.text.startsWith('catch')) {
        return {
          ok: true,
          text: '✓ The failure came out of await, into catch.',
        }
      }

      return list && resumed.at >= list.at
        ? { ok: true, text: '✓ await resumed once the list was fresh.' }
        : { ok: false, text: '✗ await resumed before the list was fresh.' }
    case 'refresh':
      if (!resumed) return { text: 'running…' }

      return list && resumed.at >= list.at
        ? {
            ok: true,
            text: '✓ await resumed once the list request settled, without throwing.',
          }
        : {
            ok: false,
            text: '✗ await resumed before the list request settled.',
          }
  }
}

/**
 * Demo of issue #27: refetch(), invalidateQueries() and mutateAsync() return
 * promises, so code can wait for fresh data. A mutation whose onSuccess
 * returns the invalidation stays pending until the list on screen is fresh;
 * one that only starts it finishes as the write lands. The timeline under the
 * buttons shows what happened, and when, after the last click.
 */
@Component({
  selector: 'app-promises-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [PromisesTrace],
  templateUrl: './promises-demo.html',
  styleUrl: './promises-demo.scss',
})
export class PromisesDemo {
  readonly #client = injectQueryClient()

  protected readonly trace = inject(PromisesTrace)
  protected readonly labels = LABELS
  protected readonly listLatency = LIST_LATENCY
  protected readonly writeLatency = WRITE_LATENCY

  // Focus and reconnect refetches would add list requests no button asked for.
  protected readonly todos = injectQuery(() => ({
    queryKey: KEY,
    queryFn: () => this.trace.list(),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  }))

  // Returns the invalidation, so the mutation stays pending until the list
  // on screen is fresh.
  protected readonly waits = injectMutation(() => ({
    mutationFn: (title: string) => this.trace.add(title),
    onSuccess: () => this.#client.invalidateQueries({ queryKey: KEY }),
  }))

  // Starts the invalidation without returning it, so the mutation finishes
  // as soon as the write lands.
  protected readonly doesntWait = injectMutation(() => ({
    mutationFn: (title: string) => this.trace.add(title),
    onSuccess: () => {
      this.#client.invalidateQueries({ queryKey: KEY })
    },
  }))

  // Awaited through mutateAsync(); returns the invalidation as `waits` does.
  protected readonly awaited = injectMutation(() => ({
    mutationFn: (title: string) => this.trace.add(title),
    onSuccess: () => this.#client.invalidateQueries({ queryKey: KEY }),
  }))

  protected readonly verdict = computed(() =>
    verdictOf(this.trace.action(), this.trace.entries()),
  )

  #nextTodo = 1

  constructor() {
    this.#noteEnd(this.waits, 'waits')
    this.#noteEnd(this.doesntWait, 'doesnt-wait')
  }

  protected addWaiting(): void {
    this.trace.start('waits', LABELS.waits)
    this.waits.mutate(this.#title())
  }

  protected addNotWaiting(): void {
    this.trace.start('doesnt-wait', LABELS['doesnt-wait'])
    this.doesntWait.mutate(this.#title())
  }

  protected async addAwaited(): Promise<void> {
    this.trace.start('mutate-async', LABELS['mutate-async'])

    try {
      const title = await this.awaited.mutateAsync(this.#title())

      this.trace.note(
        `await resumed: added "${title}"`,
        'promise',
        'mutate-async',
      )
    } catch (error) {
      this.trace.note(`catch: ${messageOf(error)}`, 'promise', 'mutate-async')
    }
  }

  protected async refresh(): Promise<void> {
    this.trace.start('refresh', LABELS.refresh)

    const { data, error } = await this.todos.refetch()
    const todos = data ? `${data.length} todos` : 'undefined'
    const failure = error ? `'${error.message}'` : 'null'

    this.trace.note(
      `await resumed: { data: ${todos}, error: ${failure} }`,
      'promise',
      'refresh',
    )
  }

  // The timeline notes when a mutate() run ends, as its signals report it.
  // Untracked: the effect must only wake up when the status changes.
  #noteEnd(
    mutation: MutationResult<string, Error, string>,
    action: DemoAction,
  ): void {
    effect(() => {
      const status = mutation.status()

      if (status !== 'success' && status !== 'error') return

      untracked(() => this.trace.note(`mutation ${status}`, 'settled', action))
    })
  }

  #title(): string {
    return `New todo #${this.#nextTodo++}`
  }
}
