Two more client methods act on the cache by force: one stops fetches, the other
deletes entries. Both take the same [filters](/query-client/filters) as
everything else.

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

// Wipe the whole cache
this.#client.removeQueries()
```

A component that shows one of those keys afterwards finds nothing cached: a cold
fetch, with a loading state. A component already showing one keeps what it
shows — removal refetches nothing — until something puts the key back in the
cache: a refetch, `setQueryData`, another component, or its own polling. From
then on it shows what the cache holds again.

Reach for it when data should be **gone**, not merely refreshed:

- **On logout** — drop everything so the next user never sees the previous
  one's cached data:

  ```ts
  logout(): void {
    this.auth.clear()
    this.#client.removeQueries()
  }
  ```

  A component that stays on screen through the logout, such as a header, keeps
  what it shows. Put the user's id in the key of queries that belong to the
  user, and gate them with `enabled`: logging out disables them, so they show
  nothing, and the next user's data is fetched under its own key.

  ```ts
  readonly profile = injectQuery(() => ({
    queryKey: ['profile', this.auth.userId()],
    queryFn: () => this.#api.profile(),
    enabled: this.auth.userId() !== null,
  }))
  ```

- **Leaving a feature area** for good, to free memory you won't need again.

For the everyday "this data changed, go get it again", you want
[invalidation](/query-client/query-invalidation), not removal — removal throws
the data away, invalidation refreshes it in place.

## What waiting code gets

A call that waits for a fetch you cancel or remove still settles:

- After **`cancelQueries`**, a `fetchQuery()` waiting for the fetch resolves
  with the data the cache holds or, if it holds none yet, rejects with a
  `CancelledError`.
- After **`removeQueries`**, it rejects with a `CancelledError`, even if the
  query had data: the data is gone.
- `refetch()` and `invalidateQueries()` never reject: they resolve either way.

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
| `removeQueries` | no | no | data should be gone (logout, cleanup) |
