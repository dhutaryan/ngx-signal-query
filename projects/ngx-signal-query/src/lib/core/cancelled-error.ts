/**
 * The error a promise of a query's data rejects with when the fetch stops
 * with no data to give: it was cancelled before the query had any
 * (`cancelQueries()`, or the last component showing the query went away
 * during an `Observable` fetch), or the query was removed
 * (`removeQueries()`, e.g. on sign-out). The request didn't fail, so tell
 * the two apart with `instanceof CancelledError`.
 *
 * A mutation's `mutateAsync()` rejects with one too, when the mutation cache
 * is cleared while its run is in flight.
 */
export class CancelledError extends Error {
  constructor(message = 'The query fetch was cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}
