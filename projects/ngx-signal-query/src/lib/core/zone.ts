import { NgZone } from '@angular/core'
import { defer, Observable } from 'rxjs'

/**
 * Makes a request outside Angular's zone and brings its outcome back to
 * where it was asked for from, as Angular's HttpClient does with fetch().
 * With zone.js, what the request waits on, a socket or a timer of the
 * library it's made with, doesn't keep the app from counting as stable or
 * hold up a server render; the pending task its caller holds keeps the app
 * busy until the outcome is in instead.
 *
 * A request asked for from inside the zone, by a click handler or a
 * component's effect, gets its outcome there: a value, a failure, and the
 * end of the stream. The code that handles it runs there as it would without
 * this. A request asked for from outside the zone, by a timer set there or
 * while Angular ticks from outside it, gets its outcome outside, as it would
 * without this.
 *
 * Angular runs change detection as the zone empties out, and mustn't start it
 * in the middle of a tick it runs from outside the zone (NG0101), as a test's
 * TestBed.tick() or an app's ApplicationRef.tick() there runs one. So an
 * outcome stays out of the zone for a request asked for from outside it, and
 * one that enters the zone leaves a microtask pending there: the zone empties
 * out once the task the outcome lands in is done.
 *
 * Without zone.js, both calls run what they're given as is. Makes a fresh
 * request for each subscription, as defer() does.
 *
 * @internal
 */
export function requestOutsideZone<T>(
  zone: Pick<NgZone, 'run' | 'runOutsideAngular'>,
  request: () => Observable<T> | Promise<T>,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    const land = NgZone.isInAngularZone()
      ? (notify: () => void) =>
          zone.run(() => {
            // The zone empties out once this task is done (see above).
            queueMicrotask(() => undefined)
            notify()
          })
      : (notify: () => void) => notify()

    return zone.runOutsideAngular(() =>
      defer(request).subscribe({
        next: (value) => land(() => subscriber.next(value)),
        error: (error: unknown) => land(() => subscriber.error(error)),
        complete: () => land(() => subscriber.complete()),
      }),
    )
  })
}
