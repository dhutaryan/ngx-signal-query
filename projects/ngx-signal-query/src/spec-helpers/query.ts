import { Query } from '../lib/core/query'
import type { QueryCache } from '../lib/core/query-cache'
import type { QueryState } from '../lib/core/types'

// A query outside any cache or app, for the specs of Query and of what its
// fetches run.
export function createQuery<TData, TError = Error, TQueryFnData = TData>(
  gcTime = 5 * 60_000,
) {
  // Query only calls cache.remove(this) on gc; a stub is enough.
  const cache = { remove: jasmine.createSpy('remove') }
  // The app's pending tasks: `held` counts those the query's fetches hold
  // now. As each is removed, `removals` records the query's state and how
  // many are still held.
  const tasks = {
    held: 0,
    removals: [] as Array<{ state: QueryState<TData, TError>; held: number }>,
  }
  const query: Query<TData, TError, TQueryFnData> = new Query<
    TData,
    TError,
    TQueryFnData
  >({
    key: ['key'],
    queryHash: '["key"]',
    cache: cache as unknown as QueryCache,
    gcTime,
    pendingTasks: {
      add: () => {
        tasks.held++

        return () => {
          tasks.held--
          tasks.removals.push({ state: query.state(), held: tasks.held })
        }
      },
    },
    // Angular's zone as an app without zone.js has it: both run what they're
    // given as is.
    zone: { run: (fn) => fn(), runOutsideAngular: (fn) => fn() },
  })

  return { query, cache, tasks }
}
