Three more client methods act on the cache by force: one stops fetches, one
deletes entries, and one empties the whole cache. The first two take the same
[filters](/query-client/filters) as everything else.

## `cancelQueries` — stop in-flight fetches

Cancels any fetch currently running for the matching queries. The **data stays**
— cancelling only aborts the request, it doesn't touch what's already cached:

```ts
// Stop any in-flight refetch of the todo list
this.#client.cancelQueries({ queryKey: ['todos'] })
```

Because a query's `queryFn` is usually an `HttpClient` `Observable`, cancelling
unsubscribes and the underlying HTTP request is genuinely aborted (see
[Query Functions](/queries/query-functions)). Afterwards `isFetching()` for
those queries drops back to `false` — nothing is running.

Each query goes back to how it was before the fetch started. That shows when a
query that failed was being tried again: it's back in `'error'` with the same
`error()`, `failureCount()` and `failureReason()`, rather than stuck in a
loading state with nothing in flight. What changed in the cache meanwhile
stays: data written with `setQueryData`, and a stale mark from
`invalidateQueries`, so the query still refetches the next time a component
shows it.

The main use is guarding an optimistic update: cancel before you write to the
cache, so a refetch already on its way can't land on top of your optimistic data
and clobber it. That's covered in
[Optimistic Updates](/mutations/optimistic-updates).

## `removeQueries` — delete entries

Removes matching queries from the cache **entirely** — data and all. Where
invalidation keeps the data and refetches, removal throws it away:

```ts
// Forget everything under ['todos']
this.#client.removeQueries({ queryKey: ['todos'] })

// Forget one exact key
this.#client.removeQueries({ queryKey: ['todos', 5], exact: true })

// Forget every query
this.#client.removeQueries()
```

A component that shows one of those keys afterwards finds nothing cached: a cold
fetch, with a loading state. A component already showing one keeps what it
shows — removal refetches nothing — until something puts the key back in the
cache: a refetch, `setQueryData`, another component, or its own polling. From
then on it shows what the cache holds again.

Reach for it when data should be **gone**, not merely refreshed, such as when
leaving a feature area for good, to free memory you won't need again. On
logout, empty the whole cache with
[`clear()`](/query-client/cancellation-and-removal#clear--empty-the-cache)
instead: it removes every query the same way, and forgets the mutations too.

For the everyday "this data changed, go get it again", you want
[invalidation](/query-client/query-invalidation), not removal — removal throws
the data away, invalidation refreshes it in place.

## `clear` — empty the cache

Removes every query, as `removeQueries()` with no filters does, and forgets
every mutation. Reach for it on logout, so the next user never sees the previous
one's cached data:

```ts
logout(): void {
  this.auth.clear()
  this.#client.clear()
}
```

Components on screen behave as after `removeQueries()`. One that stays on screen
through the logout, such as a header, keeps what it shows. Put the user's id in
the key of queries that belong to the user, and gate them with `enabled`:
logging out disables them, so they show nothing, and the next user's data is
fetched under its own key.

```ts
readonly profile = injectQuery(() => ({
  queryKey: ['profile', this.auth.userId()],
  queryFn: () => this.#api.profile(),
  enabled: this.auth.userId() !== null,
}))
```

A mutation still in flight isn't stopped. Its write has most likely reached the
server, so it lands and runs its hooks, as when its component goes away, and a
component showing it sees how it went; `injectIsMutating()` stops counting it at
once. That's what lets a logout mutation clear the cache from its own hook:

```ts
readonly logout = injectMutation(() => ({
  mutationFn: () => this.#api.logout(),
  onSuccess: () => {
    this.#client.clear()
    this.#router.navigate(['/login'])
  },
}))
```

A hook that runs after the clear and writes into the cache, such as a save's
`setQueryData()`, puts that key back. With the user's id in the key, the entry
belongs to the previous user: nothing shows it, and it's removed `gcTime` after
the write.

## What waiting code gets

A call that waits for a fetch you cancel or remove still settles:

- After **`cancelQueries`**, a `fetchQuery()` waiting for the fetch resolves
  with the data the cache holds or, if it holds none yet, rejects with a
  `CancelledError`.
- After **`removeQueries`** or **`clear`**, it rejects with a `CancelledError`,
  even if the query had data: the data is gone.
- `refetch()` and `invalidateQueries()` never reject: they resolve either way.
- A mutation's `mutateAsync()` settles as the mutation does: `clear()` doesn't
  stop it.

A `CancelledError` doesn't mean the request failed. Tell the two apart with
`instanceof`:

```ts
import { CancelledError } from 'ngx-signal-query'

try {
  await this.#client.fetchQuery(queryKey, queryFn)
} catch (error) {
  if (error instanceof CancelledError) return // e.g. signed out meanwhile

  throw error
}
```

## Which to reach for

| | keeps data? | refetches? | use when |
| --- | --- | --- | --- |
| `invalidateQueries` | yes | yes (if observed) | data changed, refresh it |
| `refetchQueries` | yes | yes (if observed) | refresh what's on screen now |
| `cancelQueries` | yes | no | stop a fetch you don't want |
| `removeQueries` | no | no | some data should be gone (cleanup) |
| `clear` | no | no | everything should be gone, mutations too (logout) |
