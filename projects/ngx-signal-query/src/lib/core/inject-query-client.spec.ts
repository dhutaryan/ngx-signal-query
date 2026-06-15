import { Injector } from '@angular/core'
import { TestBed } from '@angular/core/testing'

import { injectQueryClient } from './inject-query-client'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

describe('injectQueryClient', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
  })

  it('returns the same QueryClient instance as DI', () => {
    const fromDi = TestBed.inject(QueryClient)
    const injected = TestBed.runInInjectionContext(() => injectQueryClient())

    expect(injected).toBe(fromDi)
  })

  it('works outside an injection context when given an injector', () => {
    const injector = TestBed.inject(Injector)

    expect(injectQueryClient({ injector })).toBe(TestBed.inject(QueryClient))
  })

  it('throws when called outside an injection context', () => {
    expect(() => injectQueryClient()).toThrowError(/NG0203|injection context/)
  })
})
