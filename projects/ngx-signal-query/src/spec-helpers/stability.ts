import { ApplicationRef } from '@angular/core'
import { TestBed, tick } from '@angular/core/testing'
import { take } from 'rxjs'

// Whether Angular counts the app as stable, as a server render and
// whenStable() see it: nothing holds it up. Call it inside fakeAsync. Runs
// what is due first: zone.js and change detection let go of their own hold
// on the app a moment after the work they waited for.
export function appIsStable(): boolean {
  tick()

  let stable = false

  TestBed.inject(ApplicationRef)
    .isStable.pipe(take(1))
    .subscribe((value) => (stable = value))

  return stable
}
