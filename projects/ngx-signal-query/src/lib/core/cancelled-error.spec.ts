import { CancelledError } from './cancelled-error'

describe('CancelledError', () => {
  // Where the class isn't at hand, in a log or an app-wide error handler, the
  // name is what tells a cancelled fetch from a failed one.
  it('is an Error named CancelledError', () => {
    const error = new CancelledError()

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('CancelledError')
  })
})
