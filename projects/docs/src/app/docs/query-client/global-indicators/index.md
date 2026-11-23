A single query's `isFetching()` tells you about that query. Sometimes you want the whole picture instead — "is _anything_ loading?" for a top-bar spinner, or "is _anything_ saving?" for a global "unsaved changes" guard. Two helpers give you exactly that, as signals.

## `injectIsFetching`

Returns a **signal of how many queries are currently fetching** across the whole app:

```ts
export class AppComponent {
  protected readonly isFetching = injectIsFetching()
}
```

{% raw %}

```html
@if (isFetching()) {
  <div class="top-progress-bar"></div>
}
```

{% endraw %}

It's a count, not a boolean — `0` when idle, higher while requests are in flight — so `isFetching() > 0` (or just the truthiness of the number) is your "something is loading" check. Background refetches count too, so the bar shows up for a quiet stale-while-revalidate refresh, not only first loads.

### Scoping it with filters

Pass [filters](/query-client/filters) to count only part of the app — the same `queryKey` / `exact` matching as everywhere else:

```ts
// Only todo-related requests, including ['todos', 5], ['todos', { … }]
protected readonly todosLoading = injectIsFetching({ queryKey: ['todos'] })
```

So one page can show a spinner for _its_ data while the global bar tracks everything.

Pass a function instead when the filters read a signal or an input. It's read the way a query's options are, so the count follows them:

```ts
// The fetches of the todo this page shows
readonly id = input.required<number>()
protected readonly todoLoading = injectIsFetching(() => ({
  queryKey: ['todo', this.id()],
}))
```

## `injectIsMutating`

The write-side counterpart — a **signal of how many mutations are currently pending**:

```ts
export class AppComponent {
  protected readonly isSaving = injectIsMutating()
}
```

{% raw %}

```html
@if (isSaving()) {
  <span class="badge">Saving…</span>
}
```

{% endraw %}

Handy for a global "saving…" indicator, or to warn before navigating away while a write is still in flight.

A mutation counts until its hooks are done, so an async `onSuccess` in its options keeps the indicator on.

### Scoping it with a key

Give the mutations a [`mutationKey`](/mutations/mutation-options#naming-a-mutation-mutationkey), and pass a function that returns [filters](/query-client/filters#mutation-filters) to count only some of them. A todo's row can show "Saving…" for its own todo, wherever the write starts: in the row, a dialog or a service:

```ts
export class TodoRow {
  readonly todo = input.required<Todo>()

  protected readonly saving = injectIsMutating(() => ({
    mutationKey: ['todos', 'update', this.todo().id],
  }))
}
```

The function is read the way a query's options are, so it can read the input, and the count follows it. A write counts under the key it was started with. Only pending writes count, so the filters take no `status`. Outside an injection context, pass an injector after them: `injectIsMutating(() => filters, { injector })`.

## They're just signals

Both return plain `Signal<number>`, so they compose like any other signal — no subscriptions, no async pipe. Combine them, derive from them, read them in a `computed`:

```ts
// "The app is busy" — either reading or writing
protected readonly busy = computed(
  () => this.isFetching() > 0 || this.isSaving() > 0,
)
```
