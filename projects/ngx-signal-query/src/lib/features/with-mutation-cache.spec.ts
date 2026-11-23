import {
  type ApplicationRef,
  Component,
  DestroyRef,
  type EnvironmentProviders,
  ErrorHandler,
  InjectionToken,
  NgZone,
  PLATFORM_ID,
  type Provider,
  createComponent,
  createEnvironmentInjector,
  inject,
} from '@angular/core'
import {
  TestBed,
  fakeAsync,
  flush,
  flushMicrotasks,
} from '@angular/core/testing'
import { createApplication } from '@angular/platform-browser'
import { of, Subject, throwError } from 'rxjs'

import { settled } from '../../spec-helpers/promises'
import { appIsStable } from '../../spec-helpers/stability'
import { provideZonelessChangeDetection } from '../../spec-helpers/zoneless'
import { injectMutation } from '../core/inject-mutation'
import type {
  MutationOptions,
  MutationResult,
  MutationSnapshot,
} from '../core/mutation'
import { provideQueryClient } from '../core/provider'
import type { DefaultOptions } from '../core/types'
import { deferred } from '../core/utils'
import { withDefaultOptions } from './with-default-options'
import {
  type MutationCacheConfig,
  withMutationCache,
} from './with-mutation-cache'

// A call of one of the callbacks, with what it got.
type Call =
  | { callback: 'onMutate'; variables: unknown; mutation: MutationSnapshot }
  | {
      callback: 'onSuccess'
      data: unknown
      variables: unknown
      context: unknown
      mutation: MutationSnapshot
    }
  | {
      callback: 'onError'
      error: unknown
      variables: unknown
      context: unknown
      mutation: MutationSnapshot
    }
  | {
      callback: 'onSettled'
      data: unknown
      error: unknown
      variables: unknown
      context: unknown
      mutation: MutationSnapshot
    }

// Which callbacks were called, in order.
function names(calls: Call[]): string[] {
  return calls.map((call) => call.callback)
}

// An injection context is enough: injectMutation's one effect, which watches
// the key, doesn't matter here, where no key changes.
function setup<TData, TError = Error, TVariables = void, TContext = unknown>(
  optionsFn: () => MutationOptions<TData, TError, TVariables, TContext>,
): MutationResult<TData, TError, TVariables> {
  return TestBed.runInInjectionContext(() => injectMutation(optionsFn))
}

describe('withMutationCache', () => {
  let calls: Call[]
  // What ran, in order: the callbacks as `cache <name>`, and whatever a spec
  // adds itself, such as `own onSuccess` for the mutation's own hook.
  let log: string[]

  // Sets up the client with callbacks that record each call in `calls` and
  // in `log`, `config` replacing any of them, with `defaults` for the
  // mutations, and with `providers` on top.
  function provide({
    config = {},
    defaults,
    providers = [],
  }: {
    config?: MutationCacheConfig
    defaults?: DefaultOptions
    providers?: Array<Provider | EnvironmentProviders>
  } = {}): void {
    const recorded: Call[] = []
    const order: string[] = []

    calls = recorded
    log = order
    TestBed.configureTestingModule({
      providers: [
        provideQueryClient(
          withMutationCache({
            onMutate: (variables, mutation) => {
              order.push('cache onMutate')
              recorded.push({ callback: 'onMutate', variables, mutation })
            },
            onSuccess: (data, variables, context, mutation) => {
              order.push('cache onSuccess')
              recorded.push({
                callback: 'onSuccess',
                data,
                variables,
                context,
                mutation,
              })
            },
            onError: (error, variables, context, mutation) => {
              order.push('cache onError')
              recorded.push({
                callback: 'onError',
                error,
                variables,
                context,
                mutation,
              })
            },
            onSettled: (data, error, variables, context, mutation) => {
              order.push('cache onSettled')
              recorded.push({
                callback: 'onSettled',
                data,
                error,
                variables,
                context,
                mutation,
              })
            },
            ...config,
          }),
          ...(defaults ? [withDefaultOptions(defaults)] : []),
        ),
        ...providers,
      ],
    })
  }

  describe('order', () => {
    it("runs each callback before the mutation's own hook of the same name", fakeAsync(() => {
      provide()

      const m = setup<string, Error, string, string>(() => ({
        mutationFn: (todo) => {
          log.push('mutationFn')

          return of(`saved ${todo}`)
        },
        onMutate: () => {
          log.push('own onMutate')

          return 'context'
        },
        onSuccess: () => log.push('own onSuccess'),
        onSettled: () => log.push('own onSettled'),
      }))

      m.mutate('milk')
      flush()

      expect(log).toEqual([
        'cache onMutate',
        'own onMutate',
        'mutationFn',
        'cache onSuccess',
        'own onSuccess',
        'cache onSettled',
        'own onSettled',
      ])
    }))

    it('does the same when the write fails', fakeAsync(() => {
      provide()

      const m = setup<string, Error, string, string>(() => ({
        mutationFn: () => {
          log.push('mutationFn')

          return throwError(() => new Error('offline'))
        },
        onMutate: () => {
          log.push('own onMutate')

          return 'context'
        },
        onError: () => log.push('own onError'),
        onSettled: () => log.push('own onSettled'),
      }))

      m.mutate('milk')
      flush()

      expect(log).toEqual([
        'cache onMutate',
        'own onMutate',
        'mutationFn',
        'cache onError',
        'own onError',
        'cache onSettled',
        'own onSettled',
      ])
    }))

    it('runs each callback before the default hook, for a mutation without its own', fakeAsync(() => {
      provide({
        defaults: {
          mutations: {
            onSuccess: () => log.push('default onSuccess'),
            onSettled: () => log.push('default onSettled'),
          },
        },
      })

      const m = setup(() => ({ mutationFn: () => of('saved') }))

      m.mutate()
      flush()

      expect(log).toEqual([
        'cache onMutate',
        'cache onSuccess',
        'default onSuccess',
        'cache onSettled',
        'default onSettled',
      ])
    }))

    // A mutation that handles its error itself, to roll back an optimistic
    // update say, replaces the default onError, which reports every failed
    // write. The cache's onError still sees it.
    it('runs onError for a mutation whose own onError replaces the default one', fakeAsync(() => {
      const report = jasmine.createSpy('cache onError')
      const defaultOnError = jasmine.createSpy('default onError')
      const rollBack = jasmine.createSpy('own onError')

      provide({
        config: { onError: report },
        defaults: { mutations: { onError: defaultOnError } },
      })

      const error = new Error('offline')
      const m = setup<string>(() => ({
        mutationFn: () => throwError(() => error),
        onError: rollBack,
      }))

      m.mutate()
      flush()

      expect(report).toHaveBeenCalledOnceWith(
        error,
        undefined,
        undefined,
        jasmine.anything(),
      )
      expect(rollBack).toHaveBeenCalledTimes(1)
      expect(defaultOnError).not.toHaveBeenCalled()
    }))
  })

  describe('arguments', () => {
    it('hands each callback the variables, the context that the own onMutate made, and the run with its meta', fakeAsync(() => {
      provide()

      const m = setup<string, Error, string, { previous: string[] }>(() => ({
        mutationFn: (todo) => of(`saved ${todo}`),
        onMutate: () => ({ previous: ['bread'] }),
        meta: { invalidates: ['todos'] },
      }))

      m.mutate('milk')
      flush()

      const context = { previous: ['bread'] }
      const meta = { invalidates: ['todos'] }

      expect(calls).toEqual([
        {
          callback: 'onMutate',
          variables: 'milk',
          mutation: {
            state: jasmine.objectContaining({
              status: 'pending',
              variables: 'milk',
              context: undefined,
            }),
            meta,
          },
        },
        {
          callback: 'onSuccess',
          data: 'saved milk',
          variables: 'milk',
          context,
          mutation: {
            state: jasmine.objectContaining({ status: 'pending', context }),
            meta,
          },
        },
        {
          callback: 'onSettled',
          data: 'saved milk',
          error: null,
          variables: 'milk',
          context,
          mutation: {
            state: jasmine.objectContaining({ status: 'pending', context }),
            meta,
          },
        },
      ])
    }))

    // An optimistic update, say: onMutate keeps what it replaced, for a
    // rollback.
    it("hands onError and onSettled the write's error and the context", fakeAsync(() => {
      provide()

      const error = new Error('offline')
      const context = { previous: ['bread'] }
      const m = setup<string, Error, string, { previous: string[] }>(() => ({
        mutationFn: () => throwError(() => error),
        onMutate: () => context,
      }))

      m.mutate('milk')
      flush()

      expect(calls.slice(1)).toEqual([
        {
          callback: 'onError',
          error,
          variables: 'milk',
          context,
          mutation: { state: jasmine.anything(), meta: undefined },
        },
        {
          callback: 'onSettled',
          data: undefined,
          error,
          variables: 'milk',
          context,
          mutation: { state: jasmine.anything(), meta: undefined },
        },
      ])
    }))

    // A run without a key gets a snapshot without one: 'hands each callback
    // the variables, the context that the own onMutate made, and the run with
    // its meta' and 'hands onError and onSettled the write's error and the
    // context' compare it as a whole.
    it('hands each callback the key of the run', fakeAsync(() => {
      provide()

      const add = setup<string, Error, string>(() => ({
        mutationKey: ['todos', 'add'],
        mutationFn: (todo) => of(todo),
      }))
      const remove = setup<string, Error, string>(() => ({
        mutationKey: ['todos', 'remove'],
        mutationFn: () => throwError(() => new Error('offline')),
      }))

      add.mutate('milk')
      remove.mutate('bread')
      flush()

      expect(
        calls.map(
          ({ callback, mutation }) =>
            `${callback} ${JSON.stringify(mutation.mutationKey)}`,
        ),
      ).toEqual([
        'onMutate ["todos","add"]',
        'onSuccess ["todos","add"]',
        'onSettled ["todos","add"]',
        'onMutate ["todos","remove"]',
        'onError ["todos","remove"]',
        'onSettled ["todos","remove"]',
      ])
    }))

    it("doesn't make what onMutate returns the run's context", fakeAsync(() => {
      const onMutate = jasmine
        .createSpy('cache onMutate')
        .and.returnValue('from the cache')

      provide({ config: { onMutate } })

      const onSuccess = jasmine.createSpy('own onSuccess')
      const m = setup<string, Error, string, string>(() => ({
        mutationFn: (todo) => of(todo),
        onMutate: () => 'own',
        onSuccess,
      }))
      // A mutation without an onMutate of its own has no context.
      const withoutOnMutate = jasmine.createSpy('onSuccess, no own onMutate')
      const bare = setup<string, Error, string, string>(() => ({
        mutationFn: (todo) => of(todo),
        onSuccess: withoutOnMutate,
      }))

      m.mutate('milk')
      bare.mutate('bread')
      flush()

      expect(onMutate).toHaveBeenCalledTimes(2)
      expect(onSuccess).toHaveBeenCalledOnceWith('milk', 'milk', 'own')
      expect(withoutOnMutate).toHaveBeenCalledOnceWith(
        'bread',
        'bread',
        undefined,
      )
    }))
  })

  describe('a promise a callback returns', () => {
    it('holds the run until it settles: the mutation stays pending, and so does the app', fakeAsync(() => {
      const invalidated = deferred()

      provide({ config: { onSuccess: () => invalidated.promise } })

      const onSuccess = jasmine.createSpy('own onSuccess')
      const m = setup<string>(() => ({
        mutationFn: () => of('saved'),
        onSuccess,
      }))
      const run = settled(m.mutateAsync())

      flushMicrotasks()

      expect(m.isPending()).toBe(true)
      expect(onSuccess).not.toHaveBeenCalled()
      expect(run).toEqual({})
      expect(appIsStable()).toBe(false)

      invalidated.resolve()
      flush()

      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(m.isSuccess()).toBe(true)
      expect(run.value).toBe('saved')
      expect(appIsStable()).toBe(true)
    }))

    it("holds the mutation's own onMutate and the write until the one onMutate returns settles", fakeAsync(() => {
      const checked = deferred()

      provide({ config: { onMutate: () => checked.promise } })

      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))
      const onMutate = jasmine.createSpy('own onMutate')
      const m = setup<string>(() => ({ mutationFn, onMutate }))

      m.mutate()
      flushMicrotasks()

      expect(onMutate).not.toHaveBeenCalled()
      expect(mutationFn).not.toHaveBeenCalled()

      checked.resolve()
      flush()

      expect(onMutate).toHaveBeenCalledTimes(1)
      expect(mutationFn).toHaveBeenCalledTimes(1)
      expect(m.isSuccess()).toBe(true)
    }))
  })

  // A check the app makes before every write, that the user is online say,
  // can call the write off.
  describe('an onMutate that fails', () => {
    it("fails the run without sending the write or running the mutation's own onMutate", fakeAsync(() => {
      const offline = new Error('offline')

      provide({
        config: {
          onMutate: () => {
            throw offline
          },
        },
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))
      const onMutate = jasmine.createSpy('own onMutate')
      const onError = jasmine.createSpy('own onError')
      const m = setup<string>(() => ({ mutationFn, onMutate, onError }))
      const run = settled(m.mutateAsync())

      flush()

      expect(mutationFn).not.toHaveBeenCalled()
      expect(onMutate).not.toHaveBeenCalled()
      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(offline)
      expect(m.failureCount()).toBe(1)
      expect(run.error).toBe(offline)
      expect(names(calls)).toEqual(['onError', 'onSettled'])
      expect(onError).toHaveBeenCalledOnceWith(offline, undefined, undefined)
      expect(handleError).not.toHaveBeenCalled()
    }))

    // An async check, one that asks the server first say.
    it('does the same when the promise it returns rejects', fakeAsync(() => {
      const expired = new Error('Your session has expired')

      provide({
        config: {
          onMutate: async () => {
            throw expired
          },
        },
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))
      const onMutate = jasmine.createSpy('own onMutate')
      const m = setup<string>(() => ({ mutationFn, onMutate }))
      const run = settled(m.mutateAsync())

      flush()

      expect(mutationFn).not.toHaveBeenCalled()
      expect(onMutate).not.toHaveBeenCalled()
      expect(m.error()).toBe(expired)
      expect(run.error).toBe(expired)
      expect(names(calls)).toEqual(['onError', 'onSettled'])
      expect(handleError).not.toHaveBeenCalled()
    }))
  })

  describe('a callback that fails', () => {
    it('reports its error to the ErrorHandler, keeps the outcome and runs the hooks after it', fakeAsync(() => {
      const failure = new Error('the audit log is down')

      provide({
        config: {
          onSuccess: () => {
            throw failure
          },
        },
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const onSuccess = jasmine.createSpy('own onSuccess')
      const m = setup<string>(() => ({
        mutationFn: () => of('saved'),
        onSuccess,
      }))
      const run = settled(m.mutateAsync())

      flush()

      expect(handleError).toHaveBeenCalledOnceWith(failure)
      expect(m.isSuccess()).toBe(true)
      expect(run.value).toBe('saved')
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(names(calls)).toEqual(['onMutate', 'onSettled'])
    }))

    it('reports an onSettled that throws, keeps the outcome and runs the own onSettled', fakeAsync(() => {
      const failure = new Error('the cleanup failed')

      provide({
        config: {
          onSettled: () => {
            throw failure
          },
        },
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const onSettled = jasmine.createSpy('own onSettled')
      const m = setup<string>(() => ({
        mutationFn: () => of('saved'),
        onSettled,
      }))
      const run = settled(m.mutateAsync())

      flush()

      expect(handleError).toHaveBeenCalledOnceWith(failure)
      expect(run.value).toBe('saved')
      expect(onSettled).toHaveBeenCalledTimes(1)
    }))

    it("reports a promise that onError returns once it rejects, and keeps the write's error", fakeAsync(() => {
      const failure = new Error('the toast service is down')

      provide({ config: { onError: () => Promise.reject(failure) } })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('offline')
      const onError = jasmine.createSpy('own onError')
      const m = setup<string>(() => ({
        mutationFn: () => throwError(() => error),
        onError,
      }))
      const run = settled(m.mutateAsync())

      flush()

      expect(handleError).toHaveBeenCalledOnceWith(failure)
      expect(m.error()).toBe(error)
      expect(run.error).toBe(error)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(names(calls)).toEqual(['onMutate', 'onSettled'])
    }))

    // Without zone.js, nothing catches an error that escapes the render on
    // its own: Node ends the process before the page is written out.
    it('reports its error during a server render without zone.js, and lets the render finish', fakeAsync(() => {
      const failure = new ReferenceError('localStorage is not defined')

      provide({
        config: {
          onSuccess: () => {
            throw failure
          },
        },
        providers: [
          provideZonelessChangeDetection(),
          { provide: PLATFORM_ID, useValue: 'server' },
        ],
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')

      @Component({
        template: `
          {{ save.status() }}
        `,
      })
      class SaveDraft {
        readonly save = injectMutation(() => ({
          mutationFn: () => of('saved'),
        }))

        constructor() {
          this.save.mutate()
        }
      }

      const fixture = TestBed.createComponent(SaveDraft)

      expect(appIsStable()).toBe(true)
      expect(fixture.nativeElement.textContent.trim()).toBe('success')
      expect(handleError).toHaveBeenCalledOnceWith(failure)
    }))
  })

  describe('in the app', () => {
    const REPORTS = new InjectionToken<string[]>('REPORTS')

    it('runs each of them in the injection context of the injector that provides the client, not of the component', fakeAsync(() => {
      const reports: string[] = []
      const hostReports: string[] = []

      provide({
        config: {
          onMutate: () => inject(REPORTS).push('onMutate'),
          onSuccess: () => inject(REPORTS).push('onSuccess'),
          onError: () => inject(REPORTS).push('onError'),
          onSettled: () => inject(REPORTS).push('onSettled'),
        },
        providers: [{ provide: REPORTS, useValue: reports }],
      })

      @Component({
        template: '',
        providers: [{ provide: REPORTS, useValue: hostReports }],
      })
      class TodoActions {
        readonly save = injectMutation(() => ({
          mutationFn: () => of('saved'),
        }))

        readonly remove = injectMutation(() => ({
          mutationFn: () => throwError(() => new Error('offline')),
        }))
      }

      const actions = TestBed.createComponent(TodoActions).componentInstance

      actions.save.mutate()
      actions.remove.mutate()
      flush()

      expect(reports).toEqual([
        'onMutate',
        'onSuccess',
        'onSettled',
        'onMutate',
        'onError',
        'onSettled',
      ])
      expect(hostReports).toEqual([])
    }))

    it('runs them for a run that outlives its component', fakeAsync(() => {
      provide()

      const response = new Subject<string>()

      @Component({ template: '' })
      class SaveButton {
        readonly save = injectMutation(() => ({ mutationFn: () => response }))
      }

      const fixture = TestBed.createComponent(SaveButton)

      fixture.componentInstance.save.mutate()
      // The user leaves the page before the save lands.
      fixture.destroy()
      response.next('saved')
      response.complete()
      flush()

      expect(names(calls)).toEqual(['onMutate', 'onSuccess', 'onSettled'])
    }))

    it('skips them once that injector is destroyed', fakeAsync(() => {
      provide()

      const response = new Subject<string>()
      const m = setup(() => ({ mutationFn: () => response }))

      m.mutate()

      // While the app is there, the callbacks run.
      expect(names(calls)).toEqual(['onMutate'])

      // The test ends, or the app is destroyed, while the save is in flight.
      TestBed.resetTestingModule()
      response.next('saved')
      response.complete()

      expect(() => flush()).not.toThrow()
      expect(names(calls)).toEqual(['onMutate'])
      expect(m.isSuccess()).toBe(true)
    }))

    // Angular counts the app's injector destroyed as soon as it starts tearing
    // the app down, after each server render say, and destroys the
    // components after that. A save that one of them starts while it goes
    // away, with a write that answers at once, lands in between.
    it('skips them for a mutation its component starts as the whole app is torn down', fakeAsync(() => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))
      const onMutate = jasmine.createSpy('onMutate')
      const onSuccess = jasmine.createSpy('onSuccess')

      @Component({ selector: 'nsq-draft-editor', template: '' })
      class DraftEditor {
        readonly saveDraft = injectMutation<string, Error, string>(() => ({
          mutationFn,
        }))

        constructor() {
          // Saves the draft on leave.
          inject(DestroyRef).onDestroy(() => this.saveDraft.mutate('on leave'))
        }
      }

      const host = document.body.appendChild(
        document.createElement('nsq-draft-editor'),
      )
      let app!: ApplicationRef

      void createApplication({
        providers: [
          provideZonelessChangeDetection(),
          provideQueryClient(withMutationCache({ onMutate, onSuccess })),
        ],
      }).then((created) => (app = created))
      flushMicrotasks()

      const editor = app.bootstrap(DraftEditor, host)

      // While the app is there, the callbacks run.
      editor.instance.saveDraft.mutate('draft')
      flush()

      expect(onSuccess).toHaveBeenCalledTimes(1)

      app.destroy()

      expect(() => flush()).not.toThrow()
      expect(mutationFn).toHaveBeenCalledWith('on leave')
      expect(onMutate).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalledTimes(1)

      host.remove()
    }))

    // A client provided below the app's injector, by a route say, outlives
    // the app: the router never destroys that injector. Its callbacks belong
    // to the app all the same.
    it('skips them for a client provided below the app once the app is torn down', fakeAsync(() => {
      const response = new Subject<string>()
      const onSuccess = jasmine.createSpy('onSuccess')
      const onSettled = jasmine.createSpy('onSettled')

      @Component({ selector: 'nsq-draft-editor', template: '' })
      class DraftEditor {
        readonly saveDraft = injectMutation<string, Error, string>(() => ({
          mutationFn: (draft) => (draft === 'first' ? of('saved') : response),
        }))
      }

      const host = document.body.appendChild(
        document.createElement('nsq-draft-editor'),
      )
      let app!: ApplicationRef

      void createApplication({
        providers: [provideZonelessChangeDetection()],
      }).then((created) => (app = created))
      flushMicrotasks()

      // Made as the router makes a route's, with the client among its
      // providers.
      const route = createEnvironmentInjector(
        [provideQueryClient(withMutationCache({ onSuccess, onSettled }))],
        app.injector,
      )
      const editor = createComponent(DraftEditor, {
        environmentInjector: route,
        hostElement: host,
      })

      app.attachView(editor.hostView)

      // While the app is there, the callbacks run.
      editor.instance.saveDraft.mutate('first')
      flush()

      expect(onSuccess).toHaveBeenCalledTimes(1)

      editor.instance.saveDraft.mutate('second')
      // The app is torn down while the save is in flight.
      app.destroy()
      response.next('saved')
      response.complete()

      expect(() => flush()).not.toThrow()
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(onSettled).toHaveBeenCalledTimes(1)

      // The router never destroys it; the spec does, to leave nothing behind.
      route.destroy()
      host.remove()
    }))
  })

  // With zone.js, a run calls them where mutate() was called from, as it
  // calls the mutation's own hooks.
  describe('with zone.js', () => {
    // Sets up callbacks that record which of them ran, and whether in
    // Angular's zone. Returns the record.
    function recordZones(): string[] {
      const zones: string[] = []
      const record = (callback: string) => (): void => {
        zones.push(`${callback} ${NgZone.isInAngularZone() ? 'in' : 'out'}`)
      }

      provide({
        config: {
          onMutate: record('onMutate'),
          onSuccess: record('onSuccess'),
          onError: record('onError'),
          onSettled: record('onSettled'),
        },
      })

      return zones
    }

    it("runs them in Angular's zone for a mutate() called from there, as by a click handler, though the write lands outside it", fakeAsync(() => {
      const zones = recordZones()
      const zone = TestBed.inject(NgZone)
      const saved = new Subject<string>()
      const removed = new Subject<string>()
      const save = setup<string>(() => ({ mutationFn: () => saved }))
      const remove = setup<string>(() => ({ mutationFn: () => removed }))

      zone.run(() => save.mutate())
      // Answered from here, outside the zone, where a response may come.
      saved.next('saved')
      saved.complete()
      flush()
      zone.run(() => remove.mutate())
      removed.error(new Error('offline'))
      flush()

      expect(zones).toEqual([
        'onMutate in',
        'onSuccess in',
        'onSettled in',
        'onMutate in',
        'onError in',
        'onSettled in',
      ])
    }))

    it("runs them outside Angular's zone for a mutate() called from outside it", fakeAsync(() => {
      const zones = recordZones()
      const save = setup<string>(() => ({ mutationFn: () => of('saved') }))

      TestBed.inject(NgZone).runOutsideAngular(() => save.mutate())
      flush()

      expect(zones).toEqual(['onMutate out', 'onSuccess out', 'onSettled out'])
    }))
  })

  // An app may write its callbacks as a class, with state of its own in a
  // field, say.
  describe('a class as the config', () => {
    it('calls the callbacks as its methods, so they keep its this', fakeAsync(() => {
      class Audit implements MutationCacheConfig {
        readonly calls: string[] = []

        onMutate(): void {
          this.calls.push('onMutate')
        }

        onSuccess(): void {
          this.calls.push('onSuccess')
        }

        onError(): void {
          this.calls.push('onError')
        }

        onSettled(): void {
          this.calls.push('onSettled')
        }
      }

      const audit = new Audit()

      TestBed.configureTestingModule({
        providers: [provideQueryClient(withMutationCache(audit))],
      })
      setup<string>(() => ({ mutationFn: () => of('saved') })).mutate()
      flush()
      setup<string>(() => ({
        mutationFn: () => throwError(() => new Error('offline')),
      })).mutate()
      flush()

      expect(audit.calls).toEqual([
        'onMutate',
        'onSuccess',
        'onSettled',
        'onMutate',
        'onError',
        'onSettled',
      ])
    }))
  })
})
