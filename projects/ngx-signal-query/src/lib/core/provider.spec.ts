import { TestBed } from '@angular/core/testing'

import { withDefaultOptions } from '../features/with-default-options'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

describe('provideQueryClient', () => {
  it('provides a QueryClient', () => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })

    expect(TestBed.inject(QueryClient)).toBeInstanceOf(QueryClient)
  })

  it('accepts a feature without throwing', () => {
    expect(() =>
      provideQueryClient(withDefaultOptions({ queries: { staleTime: 1 } })),
    ).not.toThrow()
  })

  it('throws when the same feature kind is registered more than once', () => {
    expect(() =>
      provideQueryClient(withDefaultOptions({}), withDefaultOptions({})),
    ).toThrowError(/registered more than once/)
  })
})
