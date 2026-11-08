import { NgZone } from '@angular/core'
import { fakeAsync, flushMicrotasks } from '@angular/core/testing'
import { Observable, of, Subject } from 'rxjs'

import { requestOutsideZone } from './zone'

describe('requestOutsideZone', () => {
  // A zone like the app's: code tells whether it runs in it with
  // NgZone.isInAngularZone(). The spec itself runs outside it.
  let zone: NgZone

  beforeEach(() => {
    zone = new NgZone({ enableLongStackTrace: false })
  })

  it('makes the request outside the zone, though asked for from inside it', () => {
    let inZone: boolean | undefined

    zone.run(() =>
      requestOutsideZone(zone, () => {
        inZone = NgZone.isInAngularZone()

        return of('v1')
      }).subscribe(),
    )

    expect(inZone).toBe(false)
  })

  // An Observable such as HttpClient's sends its request once subscribed.
  it('subscribes to an Observable request outside the zone too', () => {
    let inZone: boolean | undefined
    const request = new Observable<string>(() => {
      inZone = NgZone.isInAngularZone()
    })

    zone.run(() => requestOutsideZone(zone, () => request).subscribe())

    expect(inZone).toBe(false)
  })

  describe('asked for from inside the zone', () => {
    it('brings each value and the end of the stream back into the zone', () => {
      const response = new Subject<string>()
      const seen: string[] = []

      zone.run(() =>
        requestOutsideZone(zone, () => response).subscribe({
          next: (value) => seen.push(`${value}:${NgZone.isInAngularZone()}`),
          complete: () => seen.push(`complete:${NgZone.isInAngularZone()}`),
        }),
      )
      // Answered from outside the zone, as a socket opened there answers.
      response.next('v1')
      response.complete()

      expect(seen).toEqual(['v1:true', 'complete:true'])
    })

    it('brings a failure back into the zone', () => {
      const response = new Subject<string>()
      let inZone: boolean | undefined

      zone.run(() =>
        requestOutsideZone(zone, () => response).subscribe({
          error: () => (inZone = NgZone.isInAngularZone()),
        }),
      )
      response.error(new Error('down'))

      expect(inZone).toBe(true)
    })

    // Angular runs change detection as the zone empties out. An outcome that
    // lands while Angular ticks from outside the zone would empty it in the
    // middle of that tick (NG0101), so the zone empties out only once the
    // task the outcome lands in is done.
    it('lets the zone empty out only once the task the outcome lands in is done', fakeAsync(() => {
      const response = new Subject<string>()
      let emptied = 0

      zone.run(() => requestOutsideZone(zone, () => response).subscribe())
      zone.onMicrotaskEmpty.subscribe(() => emptied++)

      response.next('v1')
      expect(emptied).toBe(0)

      flushMicrotasks()
      expect(emptied).toBe(1)
    }))

    // As a cached response comes, Angular's HTTP transfer cache included.
    it('brings an answer that comes at once back into the zone too', () => {
      let inZone: boolean | undefined

      zone.run(() =>
        requestOutsideZone(zone, () => of('v1')).subscribe(
          () => (inZone = NgZone.isInAngularZone()),
        ),
      )

      expect(inZone).toBe(true)
    })
  })

  // As by a timer set outside the zone, or while Angular ticks from outside
  // it: entering the zone for an answer that comes at once would make Angular
  // start another tick in the middle of the one that asked (NG0101).
  it('leaves the outcome outside the zone for a request asked for from outside it, whether it comes at once or later', () => {
    const later = new Subject<string>()
    const seen: string[] = []

    requestOutsideZone(zone, () => of('now')).subscribe((value) =>
      seen.push(`${value}:${NgZone.isInAngularZone()}`),
    )
    requestOutsideZone(zone, () => later).subscribe((value) =>
      seen.push(`${value}:${NgZone.isInAngularZone()}`),
    )
    later.next('later')

    expect(seen).toEqual(['now:false', 'later:false'])
  })

  // A retry subscribes again, and a promise can only settle once.
  it('makes a fresh request for each subscription', () => {
    const request = jasmine.createSpy('request').and.callFake(() => of('v1'))
    const attempts = requestOutsideZone(zone, request)

    attempts.subscribe()
    attempts.subscribe()

    expect(request).toHaveBeenCalledTimes(2)
  })

  // Unsubscribing an HttpClient request aborts it.
  it('tears the request down when unsubscribed', () => {
    let tornDown = false
    const request = new Observable<string>(() => () => (tornDown = true))

    requestOutsideZone(zone, () => request)
      .subscribe()
      .unsubscribe()

    expect(tornDown).toBe(true)
  })
})
