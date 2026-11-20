import { TransferState, inject, makeStateKey } from '@angular/core'

import { inBrowser } from './platform'
import type { QueryCache } from './query-cache'
import type { QueryKey } from './types'
import { survivesJson } from './utils'

/**
 * A query as the page carries it from the server to the browser: its key and
 * the key's hash, its data and when the server got it, whether it was marked
 * stale, and whether the data is only a seed of initialData, which nothing
 * fetched.
 *
 * @internal
 */
interface TransferredQuery {
  key: QueryKey
  // Carried rather than worked out again: JSON brings a class instance in the
  // key back as a plain object, which hashes differently.
  hash: string
  data: unknown
  updatedAt: number
  isInvalidated?: boolean
  seed?: boolean
}

/**
 * Where in Angular's TransferState the page carries the cache.
 *
 * @internal
 */
export const TRANSFER_KEY = makeStateKey<TransferredQuery[]>('ngx-signal-query')

/**
 * Hands the cache from a server render over to the browser through Angular's
 * TransferState: on the server, the queries go into the page once the render
 * is done; in the browser, they go back into the cache as the server had
 * them, fetched or seeded, with the time it did. Must run in an injection
 * context.
 *
 * @internal
 */
export function transferCache(cache: QueryCache, gcTime: number): void {
  const transferState = inject(TransferState)

  if (!inBrowser()) {
    // Called as Angular writes the state into the page, once the app is
    // stable: every fetch of the render has landed by then.
    transferState.onSerialize(TRANSFER_KEY, () => dehydrate(cache))

    return
  }

  const queries = transferState.get(TRANSFER_KEY, null)

  if (!queries) return

  // Read once: from now on the cache holds the data.
  transferState.remove(TRANSFER_KEY)
  hydrate(cache, queries, gcTime)
}

// The queries the page carries: those that succeeded, with data JSON carries
// as is. Any other is left to the browser, which fetches it as it would
// without a server render. Data JSON can't carry would reach the browser as
// something else, a Date as a string, or not at all: a BigInt or a value that
// references itself fails the whole page's state, Angular's own included.
function dehydrate(cache: QueryCache): TransferredQuery[] {
  return cache.getAll().flatMap((query) => {
    const { status, data, updatedAt, isInvalidated, fetchedCount } =
      query.state()

    if (status !== 'success') return []

    if (!survivesJson(data)) {
      warnLeftOut(query.queryHash)

      return []
    }

    return [
      {
        key: query.key,
        hash: query.queryHash,
        data,
        updatedAt,
        ...(isInvalidated && { isInvalidated }),
        ...(fetchedCount === 0 && { seed: true }),
      },
    ]
  })
}

// Puts the queries the page carries into a cache nothing has read yet. One
// that nothing uses is kept for gcTime, as data written with setQueryData is.
// Data the server fetched counts as fetched; a seed of initialData stays one.
function hydrate(
  cache: QueryCache,
  queries: TransferredQuery[],
  gcTime: number,
): void {
  for (const { key, hash, data, updatedAt, isInvalidated, seed } of queries) {
    const query = cache.getOrCreate(key, gcTime, hash)

    query.setData(data, { updatedAt, seed })

    if (isInvalidated) query.invalidate()
  }
}

// Set by Angular in development; a production build replaces it with false.
// TODO: drop this declaration once the minimum supported Angular is 19.2.2,
// whose typings declare it.
declare const ngDevMode: unknown

// Tells the developer why a query loads again in the browser. Development
// builds only: a production build drops it with the rest of Angular's
// development checks.
function warnLeftOut(queryHash: string): void {
  if (typeof ngDevMode === 'undefined' || ngDevMode) {
    // eslint-disable-next-line no-console
    console.warn(
      `ngx-signal-query: query ${queryHash} stays on the server: JSON can't carry its data as is (a Date, a Map, a class instance or an infinite list's undefined page param, say), so the browser fetches it again. Return plain data from its queryFn, and start an infinite list from null rather than undefined, to bring it over.`,
    )
  }
}
