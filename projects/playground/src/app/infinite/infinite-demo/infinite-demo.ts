import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core'
import {
  type QueryKey,
  injectInfiniteQuery,
  injectMutation,
  injectQueryClient,
} from 'ngx-signal-query'
import { lastValueFrom } from 'rxjs'

import { Log } from '../../core/log/log'
import {
  type Filter,
  InfiniteServer,
  PAGE_LATENCY,
  PAGE_SIZE,
  WRITE_LATENCY,
} from '../infinite-server'

/** Under the demo's own prefix, so the other demos' invalidations can't touch it. */
const PREFIX: QueryKey = ['infinite-demo']

/**
 * Demo of issue #5: a list of todos fetched page by page with
 * injectInfiniteQuery. The buttons add pages, refetch, write, switch the
 * filter and fail a request; the checks show what the list must never hold:
 * a todo twice, a page of another filter, or pages read before and after a
 * change side by side.
 */
@Component({
  selector: 'app-infinite-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [InfiniteServer],
  templateUrl: './infinite-demo.html',
  styleUrl: './infinite-demo.scss',
})
export class InfiniteDemo {
  readonly #client = injectQueryClient()
  readonly #log = inject(Log)
  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel')

  protected readonly server = inject(InfiniteServer)
  protected readonly pageLatency = PAGE_LATENCY
  protected readonly pageSize = PAGE_SIZE
  protected readonly writeLatency = WRITE_LATENCY
  protected readonly filters: Filter[] = ['all', 'open', 'done']

  protected readonly filter = signal<Filter>('all')
  /** Whether the list keeps 3 pages at most. */
  protected readonly windowed = signal(false)
  /** Whether reaching the end of the list asks for the next page. */
  protected readonly loadOnScroll = signal(false)
  /** Whether the end of the list shows in its box. */
  protected readonly atEnd = signal(false)
  /** Whether queryFn returns a Promise that leaves the signal alone, which
   * nothing can stop, rather than an Observable. */
  protected readonly promises = signal(false)

  // The query function reads the filter as each page is asked for, as
  // `() => api(this.id())` does: a page asked for after a switch would be
  // the next filter's. Focus refetches would add requests no button asked
  // for, and a retry would hide the failed request.
  protected readonly todos = injectInfiniteQuery(() => ({
    queryKey: [...PREFIX, this.filter()],
    queryFn: ({ pageParam }) => {
      const page = this.server.page(this.filter(), pageParam)

      return this.promises() ? lastValueFrom(page) : page
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    getPreviousPageParam: (firstPage) => firstPage.previousCursor,
    maxPages: this.windowed() ? 3 : undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  }))

  // Returns the invalidation, as Invalidation from Mutations shows: the
  // mutation stays pending until the list is fresh.
  protected readonly save = injectMutation(() => ({
    mutationFn: () => this.server.save(),
    onSuccess: () => this.#client.invalidateQueries({ queryKey: PREFIX }),
  }))

  protected readonly remove = injectMutation(() => ({
    mutationFn: () => this.server.deleteFirst(),
    onSuccess: () => this.#client.invalidateQueries({ queryKey: PREFIX }),
  }))

  protected readonly pages = computed(() => this.todos.data()?.pages ?? [])

  /** Todos the list shows twice. */
  protected readonly duplicates = computed(() => {
    const ids = this.pages().flatMap((page) =>
      page.todos.map((todo) => todo.id),
    )

    return ids.length - new Set(ids).size
  })

  /** Pages read for another filter than the list's own. */
  protected readonly foreign = computed(
    () => this.pages().filter((page) => page.filter !== this.filter()).length,
  )

  /** The versions of the list its pages were read from. */
  protected readonly versions = computed(() => [
    ...new Set(this.pages().map((page) => page.version)),
  ])

  constructor() {
    // Infinite scroll as the docs show it: once the end of the list shows
    // and nothing is in flight, ask for the next page. A fetch in flight,
    // a refetch say, makes fetchNextPage() wait and add nothing, so this runs
    // again once isFetching() goes false. A next page that failed is left to
    // Load more: asked for here, it would be asked for over and over while
    // the end shows.
    effect(() => {
      if (
        this.loadOnScroll() &&
        this.atEnd() &&
        this.todos.hasNextPage() &&
        !this.todos.isFetching() &&
        !this.todos.isFetchNextPageError()
      ) {
        this.server.note('scrolled to the end: fetchNextPage()', 'trigger')
        this.todos.fetchNextPage()
      }
    })

    // Watches the end of the list in its scroll box.
    effect((onCleanup) => {
      const sentinel = this.sentinel()?.nativeElement

      if (!sentinel) return

      const observer = new IntersectionObserver(
        ([entry]) => this.atEnd.set(entry.isIntersecting),
        { root: sentinel.parentElement },
      )

      observer.observe(sentinel)
      onCleanup(() => observer.disconnect())
    })
  }

  protected async loadMore(): Promise<void> {
    this.server.note('Load more: fetchNextPage()', 'trigger')

    const { data } = await this.todos.fetchNextPage()

    this.server.note(
      `fetchNextPage() resolved: ${this.describe(data?.pages.length)}`,
      'trigger',
    )
  }

  protected loadPrevious(): void {
    this.server.note('Load previous: fetchPreviousPage()', 'trigger')
    this.todos.fetchPreviousPage()
  }

  protected refresh(): void {
    this.server.note('Refresh: refetch()', 'trigger')
    this.todos.refetch()
  }

  protected show(filter: Filter): void {
    this.server.note(`filter: ${filter}`, 'trigger')
    this.filter.set(filter)
  }

  protected toggle(
    setting: 'windowed' | 'loadOnScroll' | 'promises' | 'failNext',
  ): void {
    const flag = setting === 'failNext' ? this.server.failNext : this[setting]

    flag.update((on) => !on)
    this.#log.add(`infinite demo · ${setting} ${flag() ? 'on' : 'off'}`, 'ui')
  }

  protected seconds(ms: number): string {
    return `+${(ms / 1000).toFixed(1)} s`
  }

  protected describe(pages: number | undefined): string {
    return pages === undefined
      ? 'no pages'
      : `${pages} page${pages === 1 ? '' : 's'}`
  }
}
