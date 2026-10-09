`refetchInterval` makes a query refetch on a timer. It's for data that changes
on the server while the user is looking at it: prices, a job's progress, an
unread count.

```ts
export class PricesComponent {
  readonly #http = inject(HttpClient)

  protected readonly prices = injectQuery(() => ({
    queryKey: ['prices'],
    queryFn: () => this.#http.get<Price[]>('/api/prices'),
    refetchInterval: 5_000,
  }))
}
```

Polling ignores `staleTime`: fresh data is polled all the same. It runs as long
as the query is observed and enabled. It stops when the component that injected
the query is destroyed, and a [disabled query](/queries/disabling-queries)
doesn't poll.

A poll that brings the same data as before doesn't change `data()`: the query
keeps what it holds, so nothing that reads it runs again. See
[Structural Sharing](/queries/structural-sharing).

## When the next poll comes

Each poll comes `refetchInterval` ms **after the query's last update**: its
last response, or a write with `setQueryData`. With a 5 s interval and requests
that take 300 ms, a request goes out every 5.3 s.

So anything else that updates the query pushes the next poll back. If a
`refetch()` or an invalidation brings new data 4 s into the interval, or
`setQueryData` writes some, the next poll comes 5 s after that, not a second
later.

The same goes for several components polling one key. A poll from one of them
is an update for all of them, so together they fetch the key once per
interval. If they ask for different intervals, the shortest sets the pace, and
when that component stops polling, the next shortest takes over.

And a poll that comes due while a request is still in flight joins that
request instead of sending another, so a slow request doesn't pile up
duplicates behind it.

## What restarts the timer

The options are re-evaluated whenever a signal they read changes. The timer
restarts only when one of these changes:

- the **query key**: polling moves on to the new key's query;
- **`enabled`**: disabling stops polling, enabling starts the timer afresh;
- the **interval** itself.

Everything else can change as often as it likes. Say the key takes one field
of a filter that a search box rewrites on every keystroke: polling keeps its
pace while the user types.

## Computing the interval

Pass a function instead of a number. It gets the query's current state and
returns the interval in ms, or `false` to stop polling:

```ts
export class JobComponent {
  readonly #http = inject(HttpClient)

  readonly jobId = input.required<string>()

  protected readonly job = injectQuery(() => ({
    queryKey: ['job', this.jobId()],
    queryFn: () => this.#http.get<Job>(`/api/jobs/${this.jobId()}`),
    // Poll until the job is done.
    refetchInterval: ({ state }) =>
      state.data?.status === 'done' ? false : 2_000,
  }))
}
```

The function runs again on every update of the query, so polling resumes by
itself once it returns a number again: say, after a refetch finds the job
running once more.

It also tracks the signals it reads, which makes pausing a one-liner:

```ts
export class PricesComponent {
  readonly #http = inject(HttpClient)

  readonly paused = signal(false)

  protected readonly prices = injectQuery(() => ({
    queryKey: ['prices'],
    queryFn: () => this.#http.get<Price[]>('/api/prices'),
    refetchInterval: () => (this.paused() ? false : 5_000),
  }))
}
```

## Values that turn polling off

`false`, `0` and no `refetchInterval` at all mean no polling. So does a value no
timer can hold: `Infinity`, a negative number, or more than 2³¹−1 ms (about
24.8 days). A browser would run such a timer at once, over and over, so the
query doesn't poll instead.

## A note if you're coming from TanStack Query

- **Its code, not its docs.** TanStack's
  [polling guide](https://tanstack.com/query/latest/docs/framework/react/guides/polling)
  says a query refetches "every N ms" and that each component's timer fires on
  its own. Its code restarts the timer on every update of the query, which is
  what this page describes, and this library does the same. One difference:
  here only new data pushes the next poll back, a failed request doesn't. So
  while requests fail, polling keeps its schedule, where TanStack waits a full
  interval after each failure.
- **Background tabs.** TanStack pauses polling while the tab is hidden, unless
  `refetchIntervalInBackground` is set. This library keeps polling
  ([#23](https://github.com/dhutaryan/ngx-signal-query/issues/23)).
- **The function form** receives `{ state }` rather than the `Query` object, so
  `query.state.data` reads the same in both.
- **Out-of-range values.** TanStack skips `Infinity` and negative intervals as
  well, but not values over 2³¹−1 ms.
