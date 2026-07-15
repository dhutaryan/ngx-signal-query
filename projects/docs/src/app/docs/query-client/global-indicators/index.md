A single query's `isFetching()` tells you about that query. Sometimes you want
the whole picture instead — "is *anything* loading?" for a top-bar spinner, or
"is *anything* saving?" for a global "unsaved changes" guard. Two helpers give
you exactly that, as signals.

## `injectIsFetching`

Returns a **signal of how many queries are currently fetching** across the whole
app:

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

It's a count, not a boolean — `0` when idle, higher while requests are in
flight — so `isFetching() > 0` (or just the truthiness of the number) is your
"something is loading" check. Background refetches count too, so the bar shows up
for a quiet stale-while-revalidate refresh, not only first loads.

### Scoping it with filters

Pass [filters](/query-client/filters) to count only part of the app — the same
`queryKey` / `exact` matching as everywhere else:

```ts
// Only todo-related requests, including ['todos', 5], ['todos', { … }]
protected readonly todosLoading = injectIsFetching({ queryKey: ['todos'] })
```

So one page can show a spinner for *its* data while the global bar tracks
everything.

## `injectIsMutating`

The write-side counterpart — a **signal of how many mutations are currently
pending**:

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

Handy for a global "saving…" indicator, or to warn before navigating away while
a write is still in flight.

Unlike `injectIsFetching`, it takes **no filters** — it always counts mutations
in the `'pending'` state, nothing else. Mutations have no key to scope by, and
"how many writes are in flight" is the one question a global indicator asks.

## They're just signals

Both return plain `Signal<number>`, so they compose like any other signal — no
subscriptions, no async pipe. Combine them, derive from them, read them in a
`computed`:

```ts
// "The app is busy" — either reading or writing
protected readonly busy = computed(
  () => this.isFetching() > 0 || this.isSaving() > 0,
)
```
