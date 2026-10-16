Out of the box, a query refetches often, keeps its data for a while after it
leaves the screen, and retries a failure before it shows an error. These
defaults suit most apps, but each of them surprises someone sooner or later,
so here they are in one place, with what each means in practice. To change one
for the whole app, see [Default Options](/query-client/default-options).

## Cached data is stale at once

`staleTime` is `0`, so data counts as stale as soon as it arrives. A stale
query refetches in the background whenever:

- a component starts showing its key, even if another one already does;
- a reactive key switches to a key that's already in the cache;
- `enabled` turns `true`;
- the user comes back to the tab, or the network comes back; see
  [Refetching on Focus and Reconnect](/queries/focus-and-reconnect).

The cached data stays on screen while it refetches: `isFetching()` is `true`,
`isLoading()` isn't.

Going stale doesn't refetch anything by itself: a query that stays on screen
refetches only when one of the above happens, `refetch()` is called or the
query is invalidated.

`initialData` counts as fetched just now, so a seeded query refetches at once
too; see [Initial Data](/queries/initial-data).

To fetch less, raise `staleTime`. See [Caching](/query-client/caching).

## Unused data is kept for 5 minutes

When the last component showing a query is gone, the query stays in the cache
for 5 minutes (`gcTime`). Coming back within that time shows its data at once,
then refetches it if it's stale. Once the 5 minutes are up, the query is
removed, and the next visit loads it from scratch. The clock only runs while no
component shows the query. See [Caching](/query-client/caching).

## Failed queries retry 3 times

A failed query retries 3 times (`retry`), so `queryFn` runs 4 times in all. It
waits 1 s, 2 s and 4 s before the retries (`retryDelay`): the wait doubles each
time, up to 30 s. The error shows only after the last attempt, at least 7 s
after the first failure. Until then, `failureCount()` and `failureReason()`
show how it's going. See [Query Retries](/queries/query-retries).

`fetchQuery` is the exception: it doesn't retry unless you ask, since whoever
waits for its promise should hear of a failure at once. See
[Manual Cache Updates](/query-client/manual-cache-updates#waiting-for-the-data).

In tests, turn retries off, or a test of an error state waits through all of
them; see [Testing](/testing).

## Mutations don't retry

A failed mutation goes to `'error'` at once, because a write isn't always safe
to send twice. Turn retries on only for writes that can be repeated: per
mutation, or for all of them in
[Default Options](/query-client/default-options). See
[Mutations](/mutations/overview).

## Unchanged data keeps its reference

`structuralSharing` is on. A refetch that brings the same data leaves `data()`
as it was, so nothing that reads it runs again, and when only part of the data
changed, the rest keeps its references. Only plain objects and arrays are
compared: a `Date`, a `Map` or a class instance counts as changed on every
response. For a large response refetched often, turn it off. See
[Structural Sharing](/queries/structural-sharing).

## No polling unless you ask

A query polls only when you set `refetchInterval`, and polling ignores
`staleTime`: fresh data is polled all the same. See
[Polling](/queries/polling).

## Not automatic

A few things don't happen on their own:

- **Pausing polling in a background tab.** Polling goes on while the tab is
  hidden. Tracked in
  [#23](https://github.com/dhutaryan/ngx-signal-query/issues/23).
- **Pausing while offline or in a background tab.** A query without a
  connection fails and goes through its retries, and a failing query goes on
  retrying while the tab is hidden; see
  [Disabling Queries](/queries/disabling-queries#there-is-no-pausing).

TanStack Query does both by default, so if you're coming from it, these are the
ones to watch for.
