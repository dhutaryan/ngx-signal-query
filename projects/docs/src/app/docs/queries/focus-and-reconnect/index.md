When the user comes back to your app, or the network comes back, the data on
screen may be out of date. So at both moments, the queries on screen whose data
is stale refetch in the background. The data stays on screen while they do:
`isFetching()` is `true`, `isLoading()` isn't.

Both are on by default, each with its own option: `refetchOnWindowFocus` and
`refetchOnReconnect`.

## Coming back to the page

A query refetches when the page turns visible again: the user switches back
from another tab, or restores a minimized window. That's when they look at the
data again.

Other ways the page gets focus don't count, because the user hasn't been away:
closing an alert or a file picker, clicking back into the page from DevTools,
switching between two windows that are both on screen.

Only stale data refetches. At the default `staleTime` of `0` that's every query
on screen, every time. Raise `staleTime`, and a quick look at another tab costs
nothing:

```ts
injectQuery(() => ({
  queryKey: ['todos'],
  queryFn: () => this.#http.get<Todo[]>('/api/todos'),
  staleTime: 60_000, // refetches on return only once a minute has passed
}))
```

A query whose last fetch failed counts as stale, whatever its `staleTime`, so
coming back tries it again. If it has no data yet, it shows its loading state
while it does, not the old error.

## The network coming back

A query also refetches when the browser reports that the network is back (its
`online` event). That's what brings back a query that failed while the user was
offline. Nothing pauses here: a query without a connection fails and goes
through its retries, then refetches once the network returns. See
[Disabling Queries](/queries/disabling-queries#there-is-no-pausing).

Only stale data refetches here too, and the option takes the same values.

## One request per query

However many components show a key, coming back sends one request for it. A
query that's already fetching keeps its request rather than starting another:
coming back while the first load runs doesn't restart it, and a tab return and a
reconnect at once, as when a laptop wakes up, send one request, not two.

A query refetches only while a component shows it with fetching enabled. A
[disabled query](/queries/disabling-queries) doesn't refetch, and neither does
one no component shows: it refetches when a component shows it again, if it's
stale by then.

## Turning it off, or up

`false` turns the refetch off. Do it for a query whose refetch would get in the
user's way, such as the data a form is filled from while the user edits it:

```ts
injectQuery(() => ({
  queryKey: ['profile'],
  queryFn: () => this.#http.get<Profile>('/api/profile'),
  refetchOnWindowFocus: false,
}))
```

Or for the whole app, in [Default Options](/query-client/default-options):

```ts
provideQueryClient(
  withDefaultOptions({
    queries: { refetchOnWindowFocus: false, refetchOnReconnect: false },
  }),
)
```

`'always'` goes the other way: the query refetches whether its data is stale or
not.

## Server rendering

On the server there's no page to come back to and no network to lose, so
nothing listens for either. In the browser, everything above applies.

## When switching tabs doesn't refetch

Check whether **Emulate a focused page** is on in Chrome DevTools, in the
**Rendering** panel. It keeps the page visible while you're on another tab, so
coming back doesn't count.

## A note if you're coming from TanStack Query

The options behave the same, but there's no `focusManager` or `onlineManager`
to plug in events of your own, and nothing pauses while offline.
