import {
  ApplicationRef,
  Component,
  ErrorHandler,
  Injectable,
  PendingTasks,
  inject,
  provideZonelessChangeDetection,
} from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { of } from 'rxjs'

import { withDefaultOptions } from '../features/with-default-options'
import { injectMutation } from './inject-mutation'
import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import { deferred } from './utils'

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

  // On Angular 19, Angular creates the app's ErrorHandler while it sets up
  // change detection, so whatever the ErrorHandler injects is created then
  // too. Anything that needs change detection to be created, PendingTasks
  // say, keeps the app from starting (NG0200). A TestBed that doesn't rethrow
  // the app's errors creates the ErrorHandler the same way, so it stands in
  // for Angular 19 here; the first spec checks that it still does.
  describe('with an ErrorHandler created while change detection is set up, as on Angular 19', () => {
    it('stands in for Angular 19, where an ErrorHandler that injects PendingTasks keeps the app from starting', () => {
      @Injectable()
      class AppErrorHandler implements ErrorHandler {
        readonly tasks = inject(PendingTasks)

        handleError(): void {}
      }

      TestBed.configureTestingModule({
        rethrowApplicationErrors: false,
        providers: [{ provide: ErrorHandler, useClass: AppErrorHandler }],
      })

      expect(() => TestBed.inject(ApplicationRef)).toThrowError(/NG0200/)
    })

    for (const zoneless of [false, true]) {
      it(`starts an app whose ErrorHandler injects the client, and waits for its fetches, ${zoneless ? 'without' : 'with'} zone.js`, async () => {
        @Injectable()
        class AppErrorHandler implements ErrorHandler {
          readonly client = inject(QueryClient)

          handleError(): void {}
        }

        const response = deferred<string>()

        @Component({
          template: `
            {{ todos.data() ?? 'Loading…' }}
          `,
        })
        class TodoList {
          readonly todos = injectQuery(() => ({
            queryKey: ['todos'],
            queryFn: () => response.promise,
          }))
        }

        TestBed.configureTestingModule({
          rethrowApplicationErrors: false,
          providers: [
            provideQueryClient(),
            { provide: ErrorHandler, useClass: AppErrorHandler },
            ...(zoneless ? [provideZonelessChangeDetection()] : []),
          ],
        })

        const fixture = TestBed.createComponent(TodoList)

        fixture.autoDetectChanges()
        setTimeout(() => response.resolve('Buy milk'), 20)
        await fixture.whenStable()

        expect(fixture.nativeElement.textContent.trim()).toBe('Buy milk')
      })
    }

    // A fetch or a mutation that a service of the ErrorHandler starts as it's
    // created can't have a pending task: Angular is still setting change
    // detection up. It fails as an effect created there does, rather than
    // leave the app unable to wait for any fetch after it.
    for (const work of ['fetch', 'mutation'] as const) {
      it(`fails a ${work} started while the ErrorHandler is being created, rather than leave the app unable to wait`, () => {
        @Injectable({ providedIn: 'root' })
        class Session {
          readonly client = inject(QueryClient)
          readonly signIn = injectMutation(() => ({
            mutationFn: () => of('Ann'),
          }))

          constructor() {
            if (work === 'fetch') {
              this.client.fetchQuery(['me'], () => of('Ann'))
            } else {
              this.signIn.mutate()
            }
          }
        }

        @Injectable()
        class AppErrorHandler implements ErrorHandler {
          readonly session = inject(Session)

          handleError(): void {}
        }

        TestBed.configureTestingModule({
          rethrowApplicationErrors: false,
          providers: [
            provideQueryClient(),
            { provide: ErrorHandler, useClass: AppErrorHandler },
          ],
        })

        expect(() => TestBed.inject(ApplicationRef)).toThrowError(/NG0200/)
      })
    }
  })
})
