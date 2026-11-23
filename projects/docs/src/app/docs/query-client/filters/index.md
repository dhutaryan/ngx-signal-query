Several client methods act on **a set** of queries or mutations rather than one. A **filter** is the small object that picks which ones. The same filter shape turns up everywhere, so it's worth learning once.

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

**`queryKey`** matches by **prefix** — the key itself and everything that starts with it:

```ts
// Matches ['todos'], ['todos', 5], ['todos', { done: true }]
this.#client.invalidateQueries({ queryKey: ['todos'] })
```

**`exact: true`** turns off prefix matching:

```ts
// Matches only ['todos'] — not ['todos', 5]
this.#client.invalidateQueries({ queryKey: ['todos'], exact: true })
```

Prefix matching is the same rule keys are hashed by, so property order inside an object doesn't matter but array order does — see [Query Keys](/queries/query-keys).

### Where query filters are used

| API                           | Effect on the matched queries   |
| ----------------------------- | ------------------------------- |
| `invalidateQueries(filters?)` | mark stale, refetch if observed |
| `cancelQueries(filters?)`     | cancel in-flight fetches        |
| `removeQueries(filters?)`     | drop from the cache             |
| `injectIsFetching(filters?)`  | count how many are fetching     |

So the same `{ queryKey: ['todos'] }` can invalidate the todo family, or count just the todo requests in flight — one filter, many uses.

## Mutation filters

Mutations are filtered by their [`mutationKey`](/mutations/mutation-options#naming-a-mutation-mutationkey), the same way:

```ts
type MutationFilters = {
  mutationKey?: MutationKey // which keys to match
  exact?: boolean // match this key exactly, instead of by prefix
  status?: MutationStatus // not where only pending ones count
}
```

`mutationKey` matches by prefix, and `exact: true` turns that off, as for queries. A mutation without a key never matches a filter that has one, not even `mutationKey: []`. A write is matched by the key its options gave when `mutate()` was called.

### Where mutation filters are used

| API                               | Effect on the matched mutations |
| --------------------------------- | ------------------------------- |
| `injectIsMutating(() => filters)` | count how many are pending      |
| `isMutating(filters?)`            | the same, once                  |

Both count pending mutations only, so they take no `status`. `injectIsMutating` takes the filters as a function, which can read an input (see [Global Indicators](/query-client/global-indicators#scoping-it-with-a-key)); `isMutating()` takes them as a value.

## A note if you're coming from TanStack Query

Query filters here are deliberately small. TanStack lets you match by `predicate`, by active/inactive status, by staleness, by fetch status. None of that exists — query filters are `queryKey` + `exact`, and mutation filters `mutationKey` + `exact`. If you need to select a subset those can't express, structure your **keys** so a prefix covers it instead.
