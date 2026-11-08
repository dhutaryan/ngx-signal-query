With Angular's server-side rendering, a page arrives with its data already in
the HTML. Two things make that work with queries: the server waits for every
fetch before it sends the page, and `withHydration()` brings the data the
server fetched over to the browser, so the page doesn't show a loading state
and fetch it all again.

## The server waits for the data

There's nothing to set up: while a query fetches or a mutation runs, Angular
counts the app as busy, so the server sends the page once the data or the
error is in, with zone.js or without. Nothing else holds the page up: a
`queryFn` built on `fetch()` takes as long as its request. On the server a
query doesn't poll, doesn't retry unless you ask, and isn't removed from the
cache. See [Important Defaults](/important-defaults#on-the-server).

## Bringing the data over

Without more, the browser starts with an empty cache: the page from the server
shows the data, then a loading state as the app boots, then the same data
from a second request. Add `withHydration()` to the providers the server and
the browser share:

```ts
// app.config.ts
import { ApplicationConfig } from '@angular/core'
import { provideClientHydration } from '@angular/platform-browser'
import {
  provideQueryClient,
  withDefaultOptions,
  withHydration,
} from 'ngx-signal-query'

export const appConfig: ApplicationConfig = {
  providers: [
    provideClientHydration(),
    provideQueryClient(
      withDefaultOptions({ queries: { staleTime: 30_000 } }),
      withHydration(),
    ),
  ],
}
```

Once the page is rendered, the server writes every query that succeeded into
it, through Angular's `TransferState`. The browser puts them back into the
cache before anything can read it, so the first render shows the data, and so
does a `fetchQuery()` in a route resolver or an app initializer. It works with
Angular's `provideClientHydration()` or without it.

A query that failed or never fetched stays on the server, and so does a
mutation: the browser fetches the query as it would without a server render.

Only the page the browser loads first comes with data: navigating within the
app fetches as usual.

## Fresh or stale

The data counts as fetched when the server fetched it, and `staleTime`
decides as for any data in the cache. With the default of `0`, it's stale by
the time the browser has it: each component refetches its query in the
background as it appears, showing the server's data meanwhile. To skip that
request, set a `staleTime` longer than a page takes to reach the browser and
boot, as the 30 seconds above.

A page prerendered at build time, or served from a cache, carries data as old
as the page: once that's older than `staleTime`, the browser refetches it in
the background.

Data no component shows yet, such as what a `@defer (hydrate …)` block
needs, stays in the cache for `gcTime`, 5 minutes by default.

## Data JSON can't carry

The page carries the data as JSON. A query whose data holds a value JSON
brings back as something else, such as a `Date`, a `Map` or a class instance,
stays on the server, and the browser fetches it again. In development, the
server logs a warning naming it.

To bring such a query over, return plain data from its `queryFn`, a date as
the string the API sends, and turn it into what you need where you read it.
The `date` pipe takes the string as it is:

```ts
readonly event = injectQuery(() => ({
  queryKey: ['event', this.id()],
  queryFn: () => this.#http.get<EventDto>(`/api/events/${this.id()}`),
}))

readonly startsAt = computed(() => {
  const event = this.event.data()

  return event && new Date(event.startsAt)
})
```

## `HttpClient` and Angular's transfer cache

`provideClientHydration()` also turns on Angular's own transfer cache: it puts
the response of each `HttpClient` GET into the page, and answers the same
request with it while the app boots, until the app first counts as stable.
Refetches and polls after that get fresh responses. With `withHydration()`
too, the page carries those responses twice. If every `HttpClient` GET your
pages make goes through a query, turn Angular's off:

```ts
provideClientHydration(withNoHttpTransferCache())
```

Keep it on if some `HttpClient` queries stay on the server for their data:
Angular answers their request in the browser from the page, so they still show
at once.

## One client

Give `withHydration()` to one client per app, the one `provideQueryClient()`
in the app config provides. Clients provided by other environment injectors
would share one place in the page, and only one of them would get its data
over.
