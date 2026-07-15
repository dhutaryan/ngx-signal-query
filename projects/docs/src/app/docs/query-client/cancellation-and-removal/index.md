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

The next time a query needs one of those keys, there's nothing cached, so it's a
cold fetch — a loading state, no stale data to show in the meantime.

Reach for it when data should be **gone**, not merely refreshed:

- **On logout** — drop everything so the next user never sees the previous
  one's cached data:

  ```ts
  logout(): void {
    this.auth.clear()
    this.#client.removeQueries()
  }
  ```

- **Leaving a feature area** for good, to free memory you won't need again.

For the everyday "this data changed, go get it again", you want
[invalidation](/query-client/query-invalidation), not removal — removal blanks
the screen, invalidation refreshes in place.

## Which to reach for

| | keeps data? | refetches? | use when |
| --- | --- | --- | --- |
| `invalidateQueries` | yes | yes (if observed) | data changed, refresh it |
| `cancelQueries` | yes | no | stop a fetch you don't want |
| `removeQueries` | no | no | data should be gone (logout, cleanup) |
