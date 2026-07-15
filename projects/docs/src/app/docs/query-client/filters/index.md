Several client methods act on **a set** of queries or mutations rather than one.
A **filter** is the small object that picks which ones. The same filter shape
turns up everywhere, so it's worth learning once.

## Query filters

A query filter has two fields, both optional:

```ts
type QueryFilters = {
  queryKey?: QueryKey // which keys to match
  exact?: boolean // match this key exactly, instead of by prefix
}
```

**No filter** matches every query:

```ts
this.#client.invalidateQueries() // all of them
```

**`queryKey`** matches by **prefix** — the key itself and everything that
starts with it:

```ts
// Matches ['todos'], ['todos', 5], ['todos', { done: true }]
this.#client.invalidateQueries({ queryKey: ['todos'] })
```

**`exact: true`** turns off prefix matching:

```ts
// Matches only ['todos'] — not ['todos', 5]
this.#client.invalidateQueries({ queryKey: ['todos'], exact: true })
```

Prefix matching is the same rule keys are hashed by, so property order inside an
object doesn't matter but array order does — see [Query Keys](/queries/query-keys).

### Where query filters are used

| API | Effect on the matched queries |
| --- | --- |
| `invalidateQueries(filters?)` | mark stale, refetch if observed |
| `cancelQueries(filters?)` | cancel in-flight fetches |
| `removeQueries(filters?)` | drop from the cache |
| `injectIsFetching(filters?)` | count how many are fetching |

So the same `{ queryKey: ['todos'] }` can invalidate the todo family, or count
just the todo requests in flight — one filter, many uses.

## Mutations aren't filtered

Queries are the only thing you filter. Mutations have no key, so there's nothing
to match by prefix — and the one place you might expect a mutation filter,
[`injectIsMutating`](/query-client/global-indicators), doesn't take one. It
always counts mutations in the `'pending'` state, which is the only question a
global "saving…" indicator asks.

(There is a `MutationFilters` type with a `status` field, but no public API
accepts it — it's used internally.)

## A note if you're coming from TanStack Query

Query filters here are deliberately small. TanStack lets you match by
`predicate`, by active/inactive status, by staleness, by fetch status. None of
that exists — filters are `queryKey` + `exact`. If you need to select a subset
those can't express, structure your **keys** so a prefix covers it instead.
