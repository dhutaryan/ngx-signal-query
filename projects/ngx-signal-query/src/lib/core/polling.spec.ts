import { fakeAsync, tick } from '@angular/core/testing'

import { startPolling } from './polling'

describe('startPolling', () => {
  it('polls again on time after a poll that throws', fakeAsync(() => {
    const poll = jasmine.createSpy('poll').and.throwError(new Error('boom'))
    const stop = startPolling(100, () => 0, poll)

    // What the poll throws comes out of its timer.
    expect(() => tick(100)).toThrowError('boom')

    poll.and.stub()
    tick(100)

    expect(poll).toHaveBeenCalledTimes(2)

    stop()
  }))

  // Polling stops even when a poll calls stop(), so no timer is left behind.
  it("doesn't poll again once a poll stops polling", fakeAsync(() => {
    let stop = (): void => undefined
    const poll = jasmine.createSpy('poll').and.callFake(() => stop())

    stop = startPolling(100, () => 0, poll)
    tick(500)

    expect(poll).toHaveBeenCalledTimes(1)
  }))
})
