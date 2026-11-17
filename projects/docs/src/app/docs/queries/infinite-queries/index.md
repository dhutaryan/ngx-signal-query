`injectInfiniteQuery` runs a list that loads page by page, behind a "Load more" button or as the user scrolls, and keeps all its pages in **one** cache entry: one key, one stale mark, one refetch, one removal. Putting the page in the key, `['todos', page]`, gives each page an entry of its own instead: that's pagination, where one page shows at a time (see [keepPreviousData](/queries/placeholder-data#keeppreviousdata)), but nothing ties those pages together into one list.

## The basics

```ts
type TodoPage = { todos: Todo[]; nextCursor: number | null }

export class TodoListComponent {
  readonly #http = inject(HttpClient)

  protected readonly todos = injectInfiniteQuery(() => ({
    queryKey: ['todos', 'infinite'],
    queryFn: ({ pageParam }) =>
      this.#http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  }))
}
```

Three options make a query infinite:

- `queryFn` fetches **one page**. Along with the key and the signal, it gets the param of that page as `pageParam`.
- `initialPageParam` is the param of the first page.
- `getNextPageParam(lastPage, allPages, lastPageParam, allPageParams)` gives the param of the page after the last one, or `null` or `undefined` when there is none.

`data()` holds the pages, in order, and the param each one was fetched with:

```ts
{
  pages: TodoPage[]     // what queryFn gave for each page
  pageParams: number[]  // pageParams[i] fetched pages[i]
}
```

The first page loads as any query's data does. The pages after it come from `fetchNextPage()`:

{% raw %}

```ts
@Component({
  template: `
    @for (page of todos.data()?.pages ?? []; track $index) {
      @for (todo of page.todos; track todo.id) {
        <p>{{ todo.title }}</p>
      }
    }

    <button
      (click)="todos.fetchNextPage()"
      [disabled]="!todos.hasNextPage() || todos.isFetching()"
    >
      {{ todos.isFetchingNextPage() ? 'Loading more…' : 'Load more' }}
    </button>
  `,
})
```

{% endraw %}

- `hasNextPage()` is `true` while `getNextPageParam` gives a param for the page after the last one. It's read from the pages the query holds, so it's `false` while [placeholder data](/queries/placeholder-data) shows.
- `isFetchingNextPage()` is `true` while the next page loads. It tells that apart from a refetch of the whole list, during which only `isFetching()` is `true`.
- `fetchNextPage()` resolves with `data` and `error` as the signals hold them once it's done, as `refetch()` does. It never rejects: a failure shows in `error()`.

Everything else is a query's: `status()`, `isPending()`, `error()`, `refetch()`, and options such as `staleTime`, `enabled` and `retry`.

## One fetch at a time

A list is one cache entry, and it runs one fetch at a time. While a fetch of it is in flight, `fetchNextPage()` waits for that fetch and adds no page:

- during the first load, it resolves with the first page;
- during another `fetchNextPage()`, the next page is asked for once;
- during a refetch, it adds nothing: added to pages read before a change, the next page would show next to pages read after it.

So ask again once `isFetching()` is `false`; that's why the button above is disabled while anything loads, not only the next page. It goes the other way too: an invalidation or a `refetch()` while the next page loads replaces that fetch, as a refetch replaces any fetch of a query with data. The list fetches the pages it held, and the page that was loading isn't added.

With no next page, `fetchNextPage()` does nothing and resolves at once. With no pages yet, or an empty list, it fetches the first one, even while the query is disabled, as `refetch()` would.

## Infinite scroll

For a list that loads as the user scrolls, let an effect ask for the next page whenever the end of the list shows and nothing loads:

{% raw %}

```ts
@Component({
  template: `
    @for (page of todos.data()?.pages ?? []; track $index) {
      @for (todo of page.todos; track todo.id) {
        <p>{{ todo.title }}</p>
      }
    }
    <div #end></div>
  `,
})
export class TodoFeedComponent {
  readonly #http = inject(HttpClient)
  private readonly end = viewChild.required<ElementRef<HTMLElement>>('end')
  // Whether the element after the last todo shows.
  protected readonly atEnd = signal(false)

  protected readonly todos = injectInfiniteQuery(() => ({
    queryKey: ['todos', 'feed'],
    queryFn: ({ pageParam }) =>
      this.#http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  }))

  constructor() {
    const destroyRef = inject(DestroyRef)

    afterNextRender(() => {
      const observer = new IntersectionObserver(([entry]) =>
        this.atEnd.set(entry.isIntersecting),
      )

      observer.observe(this.end().nativeElement)
      destroyRef.onDestroy(() => observer.disconnect())
    })

    effect(() => {
      if (
        this.atEnd() &&
        this.todos.hasNextPage() &&
        !this.todos.isFetching() &&
        !this.todos.isFetchNextPageError()
      ) {
        this.todos.fetchNextPage()
      }
    })
  }
}
```

{% endraw %}

The effect reads `isFetching()`, so it runs again whenever a fetch ends. If the end of the list came into view during a refetch, the next page comes as soon as the refetch is in, and pages keep coming while the end still shows. A handler that runs once, on a scroll event say, would lose a call made during a fetch.

`isFetchNextPageError()` keeps it from asking again for a next page that failed: running again as that fetch ends, the effect would ask for the page over and over while the end of the list shows. A button asks for it instead, as in [When a page fails](#when-a-page-fails), and once the page is in, the effect goes on.

## How a refetch works

When the list refetches, whatever asks for it (it's stale as a component shows it, it's invalidated, `refetch()` is called, it polls, the window regains focus or the network comes back), it fetches its pages again, in order: the first with its own param, then each next one with the param `getNextPageParam` gives for the page just fetched, as many pages as it held. So the list stays as long as it was, and its cursors stay right when the data changed in between:

| a list two items a page, item 1 deleted since it loaded | params asked for | pages |
| --- | --- | --- |
| asking again for the params the pages were fetched with | `0, 2, 4` | `[0, 2] [2, 3] [4, 5]`: item 2 twice |
| what the list does | `0, 3, 5` | `[0, 2] [3, 4] [5, 6]` |

It fetches fewer pages when `getNextPageParam` says there's no next one sooner. A retry goes on from the page that failed rather than starting over: with page 3 failing once above, the params asked for are `0, 3, 3, 5`.

The first page's own param is used whatever it is, `null` included. `initialPageParam` only counts while the list holds no pages: on its first load, or once [`removeQueries()`](/query-client/cancellation-and-removal) has removed them.

A page added to pages read before an invalidation doesn't make them fresh: the list keeps the stale mark from [`invalidateQueries()`](/query-client/query-invalidation) and refetches the next time stale data would.

The pages of a refetch come one after the other, so a refetch takes as long as all of them, and so does each poll. `maxPages` below keeps that short.

## Both directions, and maxPages

A list can grow at the top too, as a chat that loads older messages does:

```ts
protected readonly messages = injectInfiniteQuery(() => ({
  queryKey: ['messages', this.chatId()],
  queryFn: ({ pageParam }) =>
    this.#http.get<MessagePage>(
      `/api/chats/${this.chatId()}/messages?cursor=${pageParam}`,
    ),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  getPreviousPageParam: (firstPage) => firstPage.previousCursor,
  maxPages: 5,
}))
```

`fetchPreviousPage()`, `hasPreviousPage()`, `isFetchingPreviousPage()` and `isFetchPreviousPageError()` work as their next-page twins do, with `getPreviousPageParam(firstPage, allPages, firstPageParam, allPageParams)`. Without `getPreviousPageParam` there's no previous page.

`maxPages` caps the pages the list keeps: a page added at one end drops pages at the other, down to `maxPages`, and a refetch fetches only the pages kept. Lowered while the list holds more, it takes effect as the next page comes, or with a refetch, which fetches the pages held and keeps the last of them. Give `getPreviousPageParam` along with it: pages dropped from the start can only come back with `fetchPreviousPage()`.

## When a page fails

A next page that fails puts the list in `'error'`: `isError()` is `true` and `error()` holds the failure, while `data()` keeps the pages it had. `isFetchNextPageError()` tells this apart from a refetch that failed, so the list can stay on screen with a way to try again at its end:

{% raw %}

```html
@if (todos.isFetchingNextPage()) {
  <p>Loading more…</p>
} @else if (todos.isFetchNextPageError()) {
  <button (click)="todos.fetchNextPage()">Couldn't load more. Try again</button>
}
```

{% endraw %}

`isFetchNextPageError()` is also `true` while the next page loads again with the list still in `'error'`, until that fetch lands, as `isError()` is: so the template checks `isFetchingNextPage()` first.

`retry` and `retryDelay` count the failures of the whole fetch, whichever pages they come from: with `retry: 1`, a refetch whose second and third pages fail once each fails at the third. A retry asks for the page that failed again. As for any query, each page has to come back as something: return `null` for a page with no data, as `undefined` fails the fetch, with no retry.

## When the component goes

As for any query, once no component shows the list, a fetch that leaving can stop is stopped, an `Observable` one or a `Promise` one whose function reads the `signal`, and the list keeps the pages it had. Any other `Promise` fetch runs on to its end, every page of it, and the pages it brings are kept for whoever comes back (see [Cancellation](/queries/query-functions#cancellation-observable-or-promise)). A page that fails then isn't tried again.

A component that moves to another key is different: its `queryFn`, if it reads the key's value when it runs, now fetches the next key's data. So no page of the list it left is asked for with that function after the switch, and that list lands with the pages that came before it, all of them its own. If an enabled component still shows that list, the rest of its pages come with that component's `queryFn` instead.

## Updating the pages by hand

`setQueryData()` writes the whole list. Keep `pages` and `pageParams` in step, one param for each page:

```ts
// Rename a todo wherever it shows.
this.#client.setQueryData<InfiniteData<TodoPage, number>>(
  ['todos', 'infinite'],
  (data) =>
    data && {
      pages: data.pages.map((page) => ({
        ...page,
        todos: page.todos.map((todo) =>
          todo.id === renamed.id ? renamed : todo,
        ),
      })),
      pageParams: data.pageParams,
    },
)

// Keep only the first page.
this.#client.setQueryData<InfiniteData<TodoPage, number>>(
  ['todos', 'infinite'],
  (data) =>
    data && {
      pages: data.pages.slice(0, 1),
      pageParams: data.pageParams.slice(0, 1),
    },
)
```

As for any query, a fetch of the list in flight lands over a write: a page that was loading goes onto the pages as they were when it started. So cancel it first, as [Optimistic Updates](/mutations/optimistic-updates#why-cancelqueries-first) does: the page isn't added, and it can be asked for again.

`initialData` and `placeholderData` have the same shape: an `InfiniteData` with `pages` and `pageParams`. A refetch of seeded data fetches as many pages as it holds.

## Typing the params

The page type comes from `queryFn`, the param type from `initialPageParam`, and every param `getNextPageParam` and `getPreviousPageParam` give must have that type. When the first page is asked for with no cursor, write the type out, as `null` alone would be the param's whole type:

```ts
initialPageParam: null as string | null,
getNextPageParam: (lastPage) => lastPage.next, // string | null
```

The query function gets the key, the signal and `pageParam`, and nothing about the direction: when the API needs to know it, let the params say it, such as `{ after: lastId }` and `{ before: firstId }`.

To share a definition, use `infiniteQueryOptions`, as [`queryOptions`](/queries/query-options) is used for a query:

```ts
@Injectable({ providedIn: 'root' })
export class TodoQueries {
  readonly #http = inject(HttpClient)

  todos() {
    return infiniteQueryOptions({
      queryKey: ['todos', 'infinite'],
      queryFn: ({ pageParam }) =>
        this.#http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
      initialPageParam: 0,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    })
  }
}

// In a component:
// protected readonly todos = injectInfiniteQuery(() => this.#queries.todos())
```

## Not here yet

The client can't prefetch an infinite list yet: `fetchQuery()` fetches a plain query, and called with an infinite list's key it stores one page as the list's data, which the list then fails to read. And `injectQueries` runs plain queries only.

## A note if you're coming from TanStack Query

- **`fetchNextPage()` waits for a fetch in flight.** It takes no options, and acts as TanStack's does with `cancelRefetch: false`. TanStack's default cancels the fetch in flight instead: during a refetch, it adds the next page to the pages read before the change, so pages from before and after it show side by side, and the refetch is lost.
- **At the end of the list nothing is fetched.** TanStack runs a fetch that brings nothing new, yet moves `dataUpdatedAt` and clears the stale mark.
- **The first page that `fetchNextPage()` loads, while the list holds none, is a first load.** `isFetchingNextPage()` and `isFetchNextPageError()` stay `false` for it; TanStack counts it as a next page.
- **A page added to stale pages keeps the stale mark.** In TanStack it clears it.
- **A page that comes back `undefined` fails the fetch.** TanStack keeps it as a page.
- **A refetch starts from the first page's own param, `null` included.** TanStack takes `initialPageParam` in place of a `null` or `undefined` one.
- **A lowered `maxPages` takes effect as the next page comes.** In TanStack, a page added to a list already longer than `maxPages` drops one page only, so the list stays as long until a refetch, although its docs say only `maxPages` pages are kept.
- **A `maxPages` below `0` keeps every page, as an unset one does.** In TanStack the list stays empty.
- **No `direction` in the query function's context.** TanStack still passes it, deprecated, and suggests the param instead.
- **A component that moved to another key doesn't fetch the rest of the list it left.** In TanStack a refetch in flight goes on with that component's query function, so one that reads the key's value when it runs adds the next key's pages to the old list.
- **Generics.** `injectInfiniteQuery<TPage, TError, TQueryKey, TPageParam>` puts the page type first, as `injectQuery` does; TanStack has the data type of `select`, which isn't here, in third place.
