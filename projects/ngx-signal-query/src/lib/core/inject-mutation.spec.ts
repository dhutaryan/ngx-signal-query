import { HttpErrorResponse } from '@angular/common/http'
import {
  ApplicationRef,
  Component,
  DestroyRef,
  type DoCheck,
  type OnDestroy,
  EnvironmentInjector,
  ErrorHandler,
  Injectable,
  InjectionToken,
  Injector,
  NgZone,
  PLATFORM_ID,
  type Signal,
  createComponent,
  createEnvironmentInjector,
  effect,
  inject,
  input,
  signal,
} from '@angular/core'
import {
  type ComponentFixture,
  TestBed,
  fakeAsync,
  flush,
  flushMicrotasks,
  tick,
} from '@angular/core/testing'
import { createApplication } from '@angular/platform-browser'
import {
  type Observable,
  EMPTY,
  firstValueFrom,
  of,
  Subject,
  throwError,
} from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import { settled } from '../../spec-helpers/promises'
import { appIsStable } from '../../spec-helpers/stability'
import { provideZonelessChangeDetection } from '../../spec-helpers/zoneless'
import { withDefaultOptions } from '../features/with-default-options'
import { withMutationCache } from '../features/with-mutation-cache'
import { injectMutation } from './inject-mutation'
import { injectQuery } from './inject-query'
import type { MutationOptions, MutationResult } from './mutation'
import { mutationOptions } from './mutation-options'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { DefaultOptions } from './types'
import { deferred } from './utils'

describe('injectMutation', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
  })

  // An injection context is enough, without a real view: injectMutation's one
  // effect, which watches the key, only matters once a key changes (see 'a
  // key that changes').
  function setup<TData, TError = Error, TVariables = void, TContext = unknown>(
    optionsFn: () => MutationOptions<TData, TError, TVariables, TContext>,
  ): MutationResult<TData, TError, TVariables, TContext> {
    return TestBed.runInInjectionContext(() => injectMutation(optionsFn))
  }

  describe('status', () => {
    it('is idle initially', () => {
      const m = setup(() => ({ mutationFn: () => of(1) }))

      expect(m.isIdle()).toBe(true)
      expect(m.status()).toBe('idle')
      expect(m.isPending()).toBe(false)
      expect(m.data()).toBeUndefined()
      expect(m.variables()).toBeUndefined()
    })

    it('goes pending while the mutation is in flight', fakeAsync(() => {
      const subject = new Subject<number>()
      const m = setup<number, Error, number>(() => ({
        mutationFn: () => subject,
      }))

      m.mutate(5)

      expect(m.isPending()).toBe(true)
      expect(m.isIdle()).toBe(false)
      expect(m.variables()).toBe(5) // variables are set immediately

      subject.next(10)
      subject.complete()
      tick()

      expect(m.isSuccess()).toBe(true)
      expect(m.isPending()).toBe(false)
      expect(m.data()).toBe(10)
    }))

    it('resolves to success with data and variables', () => {
      const m = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v * 2),
      }))

      m.mutate(3)

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe(6)
      expect(m.variables()).toBe(3)
      expect(m.error()).toBeNull()
    })

    it('transitions to error when the mutation fails', () => {
      const err = new Error('boom')
      const m = setup(() => ({ mutationFn: () => throwError(() => err) }))

      m.mutate()

      expect(m.isError()).toBe(true)
      expect(m.isPending()).toBe(false)
      expect(m.error()).toBe(err)
    })

    it('errors when the mutationFn completes without emitting', () => {
      const m = setup<number>(() => ({ mutationFn: () => EMPTY }))

      m.mutate()

      expect(m.isError()).toBe(true)
      expect(m.error()?.message).toContain('without emitting')
    })

    // Today's rule, which #91 may change on purpose: an upload that reports
    // its progress, say, ends at the first event.
    it('uses the first value of a stream and lets go of it', () => {
      const stream = new Subject<string>()
      const onSuccess = jasmine.createSpy('onSuccess')
      const m = setup<string>(() => ({ mutationFn: () => stream, onSuccess }))

      m.mutate()
      stream.next('first')
      stream.next('second')

      expect(m.data()).toBe('first')
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(stream.observed).toBe(false)
    })

    it('re-runs and overwrites state on a second mutate', () => {
      const m = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v),
      }))

      m.mutate(1)
      expect(m.data()).toBe(1)

      m.mutate(2)
      expect(m.data()).toBe(2)
      expect(m.variables()).toBe(2)
    })
  })

  describe('reset', () => {
    it('returns the mutation to idle', () => {
      const m = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v),
      }))

      m.mutate(7)
      expect(m.isSuccess()).toBe(true)

      m.reset()

      expect(m.isIdle()).toBe(true)
      expect(m.data()).toBeUndefined()
      expect(m.variables()).toBeUndefined()
      expect(m.error()).toBeNull()
    })

    it('forgets an in-flight mutation without cancelling it', fakeAsync(() => {
      const subject = new Subject<number>()
      const onSuccess = jasmine.createSpy('onSuccess')
      const m = setup<number, Error, number>(() => ({
        mutationFn: () => subject,
        onSuccess,
      }))

      m.mutate(1)
      expect(m.isPending()).toBe(true)

      m.reset()
      expect(m.isIdle()).toBe(true)

      subject.next(1)
      subject.complete()
      tick()

      // The write can't be un-sent, so it runs to completion and its hooks fire
      // — otherwise the cache would never learn about a write that succeeded.
      expect(onSuccess).toHaveBeenCalledWith(1, 1, undefined)

      // The result is still forgotten: the signals stay idle.
      expect(m.isIdle()).toBe(true)
      expect(m.data()).toBeUndefined()

      // …and the abandoned run cleans itself out of the cache.
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))
  })

  // The key says which mutation a component shows, so once the options give
  // another key, the component no longer shows the run it started under the
  // old one: it goes back to idle, the way reset() does.
  describe('a key that changes', () => {
    // A todo's page, which the router keeps when it moves on to another todo.
    // It shows how saving its todo went, and records what it showed.
    @Component({
      selector: 'app-todo-page',
      template: '{{ show(save.status()) }}',
    })
    class TodoPage {
      readonly id = input.required<number>()
      readonly shown: string[] = []
      readonly writes: Array<Subject<string>> = []
      readonly onSuccess = jasmine.createSpy('own onSuccess')
      readonly save = injectMutation<string, Error, string>(() => ({
        mutationKey: ['todos', 'update', this.id()],
        mutationFn: () => {
          const write = new Subject<string>()

          this.writes.push(write)

          return write
        },
        onSuccess: this.onSuccess,
      }))

      show(status: string): string {
        this.shown.push(`${this.id()}: ${status}`)

        return status
      }

      // Answers the latest write.
      land(data: string): void {
        const write = this.writes[this.writes.length - 1]

        write.next(data)
        write.complete()
      }
    }

    function open(id: number): ComponentFixture<TodoPage> {
      const fixture = TestBed.createComponent(TodoPage)

      fixture.componentRef.setInput('id', id)
      fixture.detectChanges()

      return fixture
    }

    it('goes back to idle once the key changes, before the page shows the new todo', fakeAsync(() => {
      const fixture = open(1)
      const page = fixture.componentInstance

      page.save.mutate('Buy milk')
      page.land('saved')
      flushMicrotasks()
      fixture.detectChanges()

      expect(page.save.status()).toBe('success')

      page.shown.length = 0
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()

      // Todo 2's page never showed how saving todo 1 went. Deduped: dev
      // mode checks the template a second time.
      expect([...new Set(page.shown)]).toEqual(['2: idle'])
      expect(page.save.data()).toBeUndefined()
      expect(page.save.variables()).toBeUndefined()
      // A run that's done and shown by no one leaves the cache.
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))

    it("shows the page's own effects the new todo as idle too, not the old outcome", fakeAsync(() => {
      @Component({
        selector: 'app-saved-toast-page',
        template: '',
      })
      class Page {
        readonly id = input.required<number>()
        readonly seen: string[] = []
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', this.id()],
          mutationFn: (title) => of(title),
        }))

        constructor() {
          // Such as a toast for a saved todo.
          effect(() => this.seen.push(`${this.id()}: ${this.save.status()}`))
        }
      }

      const fixture = TestBed.createComponent(Page)
      const page = fixture.componentInstance

      fixture.componentRef.setInput('id', 1)
      fixture.detectChanges()
      page.save.mutate('Buy milk')
      fixture.detectChanges()

      expect(page.seen).toContain('1: success')

      page.seen.length = 0
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()

      expect(page.seen).toEqual(['2: idle'])
    }))

    it('shows an effect the page declares before the mutation the new todo as idle', () => {
      @Component({ selector: 'app-early-effect-page', template: '' })
      class Page {
        readonly id = input.required<number>()
        readonly seen: string[] = []
        // Declared before the mutation, so it's made first.
        readonly log = effect(() =>
          this.seen.push(`${this.id()}: ${this.save.status()}`),
        )

        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', this.id()],
          mutationFn: (title) => of(title),
        }))
      }

      const fixture = TestBed.createComponent(Page)
      const page = fixture.componentInstance

      fixture.componentRef.setInput('id', 1)
      fixture.detectChanges()
      page.save.mutate('Buy milk')
      fixture.detectChanges()

      expect(page.seen).toContain('1: success')

      page.seen.length = 0
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()

      expect(page.seen).toEqual(['2: idle'])
    })

    // A store that follows the page's input, written while the page is
    // checked.
    it("doesn't show the old outcome when a store's key is set during change detection", () => {
      @Injectable({ providedIn: 'root' })
      class TodoStore {
        readonly id = signal(0)
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', this.id()],
          mutationFn: (title) => of(title),
        }))
      }

      @Component({
        selector: 'app-store-todo-page',
        template: '{{ show(store.save.status()) }}',
      })
      class Page {
        readonly id = input.required<number>()
        readonly store = inject(TodoStore)
        readonly shown: string[] = []
        readonly toasts: string[] = []

        constructor() {
          effect(() => this.store.id.set(this.id()))
          // Such as a toast once the todo is saved.
          effect(() => {
            if (this.store.save.isSuccess()) {
              this.toasts.push(`saved todo ${this.id()}`)
            }
          })
        }

        show(status: string): string {
          this.shown.push(`${this.id()}: ${status}`)

          return status
        }
      }

      const fixture = TestBed.createComponent(Page)
      const page = fixture.componentInstance

      fixture.componentRef.setInput('id', 1)
      fixture.detectChanges()
      page.store.save.mutate('Buy milk')
      fixture.detectChanges()

      expect(page.toasts).toEqual(['saved todo 1'])

      page.shown.length = 0
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()

      // Deduped: dev mode checks the template a second time.
      expect([...new Set(page.shown)]).toEqual(['2: idle'])
      expect(page.toasts).toEqual(['saved todo 1'])
    })

    // Angular 19 runs a service's effects in the order they were marked, not
    // made.
    it("shows a service's own effect the new key as idle", () => {
      @Injectable({ providedIn: 'root' })
      class TodoStore {
        readonly id = signal(1)
        readonly seen: string[] = []
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', this.id()],
          mutationFn: (title) => of(title),
        }))

        constructor() {
          // Such as a toast for a saved todo.
          effect(() => this.seen.push(`${this.id()}: ${this.save.status()}`))
        }
      }

      const store = TestBed.inject(TodoStore)
      const app = TestBed.inject(ApplicationRef)

      app.tick()
      store.save.mutate('Buy milk')
      app.tick()

      expect(store.seen).toContain('1: success')

      store.seen.length = 0
      store.id.set(2)
      app.tick()

      expect(store.seen).toEqual(['2: idle'])
    })

    it('lets a write in flight go on, while the page shows the new todo as idle', fakeAsync(() => {
      const fixture = open(1)
      const page = fixture.componentInstance

      page.save.mutate('Buy milk')
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()

      expect(page.save.isPending()).toBe(false)
      expect(page.save.status()).toBe('idle')
      // It still counts, under the key it was started with.
      expect(client.isMutating({ mutationKey: ['todos', 'update', 1] })).toBe(1)

      page.land('saved')
      flushMicrotasks()
      fixture.detectChanges()

      // Its hooks run: the write went through.
      expect(page.onSuccess).toHaveBeenCalledOnceWith(
        'saved',
        'Buy milk',
        undefined,
      )
      expect(page.save.status()).toBe('idle')
      expect(client.isMutating()).toBe(0)
      // Done, and shown by no one: it leaves the cache.
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))

    // A call's callbacks are the page's reaction to that write, such as
    // marking its form saved: once the page shows another todo, they'd act on
    // that todo's form.
    it('skips the callbacks of a call whose write is done once the page shows another todo', fakeAsync(() => {
      const fixture = open(1)
      const page = fixture.componentInstance
      const kept = jasmine.createSpy('onSuccess of a write done on todo 1')
      const onSuccess = jasmine.createSpy('call onSuccess')
      const onSettled = jasmine.createSpy('call onSettled')

      page.save.mutate('Buy milk', { onSuccess: kept })
      page.land('saved')
      flushMicrotasks()

      expect(kept).toHaveBeenCalledTimes(1)

      page.save.mutate('Buy bread', { onSuccess, onSettled })
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()
      page.land('saved')
      flushMicrotasks()

      // The mutation's own hooks keep the cache in step, so they ran.
      expect(page.onSuccess).toHaveBeenCalledTimes(2)
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onSettled).not.toHaveBeenCalled()
    }))

    it('skips the callbacks of a call whose write is done after the key changed, before the page updated', fakeAsync(() => {
      const fixture = open(1)
      const page = fixture.componentInstance
      const onSuccess = jasmine.createSpy('call onSuccess')

      page.save.mutate('Buy milk', { onSuccess })
      fixture.componentRef.setInput('id', 2)
      page.land('saved')
      flushMicrotasks()

      expect(page.onSuccess).toHaveBeenCalledTimes(1)
      expect(onSuccess).not.toHaveBeenCalled()
    }))

    it('shows the next run, started under the new key', fakeAsync(() => {
      const fixture = open(1)
      const page = fixture.componentInstance

      page.save.mutate('Buy milk')
      page.land('saved 1')
      flushMicrotasks()
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()

      page.save.mutate('Buy bread')
      page.land('saved 2')
      flushMicrotasks()
      fixture.detectChanges()

      expect(page.save.status()).toBe('success')
      expect(page.save.data()).toBe('saved 2')
    }))

    it('goes back to idle again after moving on twice with nothing saved in between', fakeAsync(() => {
      const fixture = open(1)
      const page = fixture.componentInstance

      page.save.mutate('Buy milk')
      page.land('saved 1')
      flushMicrotasks()
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()
      // On to todo 3, before anything is saved on todo 2.
      fixture.componentRef.setInput('id', 3)
      fixture.detectChanges()

      page.save.mutate('Buy bread')
      page.land('saved 3')
      flushMicrotasks()
      fixture.detectChanges()

      expect(page.save.status()).toBe('success')

      fixture.componentRef.setInput('id', 4)
      fixture.detectChanges()

      expect(page.save.status()).toBe('idle')
    }))

    it('resets a mutation that a service keeps, once a signal in its key changes', fakeAsync(() => {
      @Injectable({ providedIn: 'root' })
      class Editor {
        readonly id = signal(1)
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', this.id()],
          mutationFn: (title) => of(title),
        }))
      }

      const editor = TestBed.inject(Editor)
      const app = TestBed.inject(ApplicationRef)

      editor.save.mutate('Buy milk')
      app.tick()

      expect(editor.save.status()).toBe('success')

      editor.id.set(2)
      app.tick()

      expect(editor.save.status()).toBe('idle')
    }))

    it('keeps showing the run of a mutation without a key', () => {
      @Component({ template: '' })
      class Page {
        readonly id = input.required<number>()
        // The options read the input, so its change reaches them.
        readonly save = injectMutation<string, Error, string>(() => ({
          meta: { todo: this.id() },
          mutationFn: (title) => of(title),
        }))
      }

      const fixture = TestBed.createComponent(Page)

      fixture.componentRef.setInput('id', 1)
      fixture.detectChanges()
      fixture.componentInstance.save.mutate('Buy milk')
      fixture.componentRef.setInput('id', 2)
      fixture.detectChanges()

      expect(fixture.componentInstance.save.status()).toBe('success')
    })

    it('keeps showing the run when the key is equal, though made anew', () => {
      @Component({ template: '' })
      class Page {
        readonly todo = input.required<{ id: number; title: string }>()
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', this.todo().id],
          mutationFn: (title) => of(title),
        }))
      }

      const fixture = TestBed.createComponent(Page)

      fixture.componentRef.setInput('todo', { id: 1, title: 'Milk' })
      fixture.detectChanges()
      fixture.componentInstance.save.mutate('Buy milk')
      fixture.detectChanges()
      // The list refetched: the same todo, in a new object.
      fixture.componentRef.setInput('todo', { id: 1, title: 'Buy milk' })
      fixture.detectChanges()

      expect(fixture.componentInstance.save.status()).toBe('success')
    })

    it('reads the options of a mutation without a key only on mutate()', () => {
      const id = signal(1)
      const optionsFn = jasmine.createSpy('options').and.callFake(() => ({
        meta: { todo: id() },
        mutationFn: (title: string) => of(title),
      }))

      @Component({ template: '' })
      class Page {
        readonly save = injectMutation<string, Error, string>(optionsFn)
      }

      const fixture = TestBed.createComponent(Page)
      const onSuccess = jasmine.createSpy('call onSuccess')

      fixture.detectChanges()
      // With callbacks for the call too: they don't read the options either.
      fixture.componentInstance.save.mutate('Buy milk', { onSuccess })
      id.set(2)
      fixture.detectChanges()
      id.set(3)
      fixture.detectChanges()

      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(optionsFn).toHaveBeenCalledTimes(1)
    })

    it("doesn't reset the run while the options give no key, until they give another one", () => {
      @Component({ template: '' })
      class Page {
        readonly todo = input.required<{ id: number } | undefined>()
        readonly save = injectMutation<string, Error, string>(() => {
          const todo = this.todo()

          return {
            mutationKey: todo ? ['todos', 'update', todo.id] : undefined,
            mutationFn: (title) => of(title),
          }
        })
      }

      const fixture = TestBed.createComponent(Page)
      const page = fixture.componentInstance

      fixture.componentRef.setInput('todo', { id: 1 })
      fixture.detectChanges()
      page.save.mutate('Buy milk')
      // The next todo is still loading.
      fixture.componentRef.setInput('todo', undefined)
      fixture.detectChanges()

      expect(page.save.status()).toBe('success')

      fixture.componentRef.setInput('todo', { id: 2 })
      fixture.detectChanges()

      expect(page.save.status()).toBe('idle')
    })

    it("doesn't reset the run, or report an error, while the options can't give a key", () => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')

      @Component({ template: '' })
      class Page {
        readonly todo = input.required<{ id: number } | undefined>()
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', this.todo()!.id],
          mutationFn: (title) => of(title),
        }))
      }

      const fixture = TestBed.createComponent(Page)
      const page = fixture.componentInstance

      fixture.componentRef.setInput('todo', { id: 1 })
      fixture.detectChanges()
      page.save.mutate('Buy milk')
      // The next todo is still loading.
      fixture.componentRef.setInput('todo', undefined)
      fixture.detectChanges()

      expect(page.save.status()).toBe('success')
      expect(handleError).not.toHaveBeenCalled()

      fixture.componentRef.setInput('todo', { id: 2 })
      fixture.detectChanges()

      expect(page.save.status()).toBe('idle')
    })
  })

  describe('retry', () => {
    it('does not retry by default', () => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(throwError(() => new Error('fail')))
      const m = setup<unknown, Error, void>(() => ({ mutationFn }))

      m.mutate()

      expect(mutationFn).toHaveBeenCalledTimes(1)
      expect(m.isError()).toBe(true)
    })

    it('retries when configured and eventually succeeds', fakeAsync(() => {
      let attempts = 0
      const m = setup(() => ({
        mutationFn: () => {
          attempts++

          return attempts < 3 ? throwError(() => new Error('fail')) : of('ok')
        },
        retry: 3,
        retryDelay: () => 10,
      }))

      m.mutate()
      tick(100)

      expect(attempts).toBe(3)
      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('ok')
      // The failed attempts led to a success, so there's no failure to show.
      expect(m.failureCount()).toBe(0)
      expect(m.failureReason()).toBeNull()
    }))

    it('tracks failureCount and failureReason when retries are exhausted', fakeAsync(() => {
      const err = new Error('nope')
      const m = setup(() => ({
        mutationFn: () => throwError(() => err),
        retry: 2,
        retryDelay: () => 10,
      }))

      m.mutate()
      tick(100)

      expect(m.isError()).toBe(true)
      expect(m.failureCount()).toBe(3) // retry: 2 -> 3 attempts
      expect(m.failureReason()).toBe(err)
    }))

    it('passes the attempt index and its error to retry and retryDelay', fakeAsync(() => {
      const errors = [new Error('first'), new Error('second')]
      const mutationFn = jasmine.createSpy('mutationFn').and.returnValues(
        throwError(() => errors[0]),
        throwError(() => errors[1]),
        of('ok'),
      )
      const retry = jasmine.createSpy('retry').and.returnValue(true)
      const retryDelay = jasmine.createSpy('retryDelay').and.returnValue(10)
      const m = setup<string>(() => ({ mutationFn, retry, retryDelay }))

      m.mutate()
      tick(100)

      // The index counts the retries made before this one: 0 for the first.
      expect(retry.calls.allArgs()).toEqual([
        [0, errors[0]],
        [1, errors[1]],
      ])
      expect(retryDelay.calls.allArgs()).toEqual([
        [0, errors[0]],
        [1, errors[1]],
      ])
      expect(m.data()).toBe('ok')
    }))

    it('backs off 1 s, then 2 s, when retries are on without a retryDelay', fakeAsync(() => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(throwError(() => new Error('fail')))
      const m = setup<unknown, Error, void>(() => ({ mutationFn, retry: 2 }))

      m.mutate()
      tick(999)

      expect(mutationFn).toHaveBeenCalledTimes(1)

      tick(1)

      expect(mutationFn).toHaveBeenCalledTimes(2)

      tick(1999)

      expect(mutationFn).toHaveBeenCalledTimes(2)

      tick(1)

      expect(mutationFn).toHaveBeenCalledTimes(3)
      expect(m.isError()).toBe(true)
    }))

    it('shows the last failed attempt in failureCount and failureReason while the next one runs', fakeAsync(() => {
      const errors = [new Error('first'), new Error('second')]
      const responses: Array<Subject<string>> = []
      const m = setup<string>(() => ({
        mutationFn: () => {
          const response = new Subject<string>()

          responses.push(response)

          return response
        },
        retry: 2,
        retryDelay: 10,
      }))

      m.mutate()
      responses[0].error(errors[0])
      tick(10)

      // The retry is in flight: the failure before it still shows.
      expect(m.isPending()).toBe(true)
      expect(m.failureCount()).toBe(1)
      expect(m.failureReason()).toBe(errors[0])

      responses[1].error(errors[1])
      tick(10)

      expect(m.failureCount()).toBe(2)
      expect(m.failureReason()).toBe(errors[1])

      responses[2].next('ok')
      responses[2].complete()

      expect(m.isSuccess()).toBe(true)
    }))

    it('counts a mutationFn that completes without emitting as one failure', fakeAsync(() => {
      const m = setup<string>(() => ({
        mutationFn: () => EMPTY,
        retry: 1,
        retryDelay: 10,
      }))

      m.mutate()
      tick(10)

      expect(m.error()?.message).toBe(
        'Mutation function completed without emitting a value',
      )
      expect(m.failureCount()).toBe(1)
      expect(m.failureReason()).toBe(m.error())
    }))

    it('counts a retry that completes without emitting as one more failure', fakeAsync(() => {
      const mutationFn = jasmine.createSpy('mutationFn').and.returnValues(
        throwError(() => new Error('down')),
        EMPTY,
      )
      const m = setup<string>(() => ({ mutationFn, retry: 2, retryDelay: 10 }))

      m.mutate()
      tick(20)

      expect(mutationFn).toHaveBeenCalledTimes(2)
      expect(m.error()?.message).toBe(
        'Mutation function completed without emitting a value',
      )
      expect(m.failureCount()).toBe(2)
      expect(m.failureReason()).toBe(m.error())
    }))

    // The response failed the query fetched for the write: the mutationFn
    // just passes that failure on, and is retried as any failure is.
    it("retries a failure its mutationFn passes on from a query's fetch", fakeAsync(() => {
      const user = jasmine
        .createSpy<() => Observable<string>>('user')
        .and.returnValues(EMPTY, of('ann'))
      const m = setup<string, Error, string>(() => ({
        mutationFn: (title) =>
          client.fetchQuery(['me'], user).then((me) => `${title} by ${me}`),
        retry: 1,
        retryDelay: 10,
      }))

      m.mutate('Buy milk')
      tick(10)
      flushMicrotasks()

      expect(user).toHaveBeenCalledTimes(2)
      expect(m.data()).toBe('Buy milk by ann')
    }))
  })

  describe('side-effect callbacks', () => {
    it('fires onMutate -> onSuccess -> onSettled with the context on success', () => {
      const order: string[] = []
      const m = setup<number, Error, number, { ctx: number }>(() => ({
        mutationFn: (v) => of(v),
        onMutate: (v) => {
          order.push('mutate')

          return { ctx: v }
        },
        onSuccess: (data, v, context) =>
          order.push(`success:${data}:${v}:${context?.ctx}`),
        onError: () => order.push('error'),
        onSettled: (data, err, v, context) =>
          order.push(`settled:${data}:${context?.ctx}`),
      }))

      m.mutate(5)

      expect(order).toEqual(['mutate', 'success:5:5:5', 'settled:5:5'])
    })

    it('fires onError and onSettled with the context on failure', () => {
      const err = new Error('boom')
      const onSuccess = jasmine.createSpy('onSuccess')
      const onError = jasmine.createSpy('onError')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<number, Error, number, { rollback: boolean }>(() => ({
        mutationFn: () => throwError(() => err),
        onMutate: () => ({ rollback: true }),
        onSuccess,
        onError,
        onSettled,
      }))

      m.mutate(2)

      expect(onSuccess).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(err, 2, { rollback: true })
      expect(onSettled).toHaveBeenCalledWith(undefined, err, 2, {
        rollback: true,
      })
    })

    it('supports optimistic update + rollback via context', () => {
      client.setQueryData(['todos'], ['a'])

      const m = setup<unknown, Error, string, { prev: string[] }>(() => ({
        mutationFn: () => throwError(() => new Error('fail')),
        onMutate: (todo) => {
          const prev = client.getQueryData<string[]>(['todos']) ?? []

          client.setQueryData(['todos'], [...prev, todo])

          return { prev }
        },
        onError: (_err, _todo, context) => {
          if (context) client.setQueryData(['todos'], context.prev)
        },
      }))

      m.mutate('b')

      // Optimistically added 'b', then rolled back to the snapshot on error.
      expect(client.getQueryData(['todos'])).toEqual(['a'])
    })

    // With zone.js, change detection follows what runs in the Angular zone.
    // The hooks run there, so what they start updates the page too: here a
    // timer, on a plain field rather than a signal.
    it('runs them in the Angular zone, so a message onSuccess shows can hide itself on a timer', fakeAsync(() => {
      @Component({
        template: `
          <button (click)="save.mutate()">Save</button>
          <p>{{ message }}</p>
        `,
      })
      class SaveTodo {
        message = ''

        readonly save = injectMutation(() => ({
          mutationFn: () =>
            new Promise<string>((resolve) =>
              setTimeout(() => resolve('saved'), 100),
            ),
          onSuccess: () => {
            this.message = 'Saved'
            setTimeout(() => (this.message = ''), 3000)
          },
        }))
      }

      const fixture = TestBed.createComponent(SaveTodo)
      const message = (): string =>
        fixture.nativeElement.querySelector('p').textContent.trim()

      fixture.autoDetectChanges()
      fixture.nativeElement.querySelector('button').click()

      tick(100)
      expect(message()).toBe('Saved')

      tick(3000)
      expect(message()).toBe('')
    }))

    it('runs them in the Angular zone after a retry too', fakeAsync(() => {
      let attempts = 0
      let inZone: boolean | undefined

      @Component({ template: '<button (click)="save.mutate()">Save</button>' })
      class SaveTodo {
        readonly save = injectMutation(() => ({
          mutationFn: () =>
            ++attempts === 1
              ? throwError(() => new Error('down'))
              : of('saved'),
          retry: 1,
          retryDelay: 100,
          onSuccess: () => {
            inZone = NgZone.isInAngularZone()
          },
        }))
      }

      const fixture = TestBed.createComponent(SaveTodo)

      fixture.autoDetectChanges()
      fixture.nativeElement.querySelector('button').click()
      tick(100)

      expect(attempts).toBe(2)
      expect(inZone).toBe(true)
    }))

    // Only a run asked for from inside the zone comes back into it. One that
    // a timer or a socket's message set up outside the zone starts gets its
    // hooks there, as it did before.
    it('runs them outside the Angular zone for a mutate() called from outside it', fakeAsync(() => {
      let inZone: boolean | undefined
      const m = setup(() => ({
        mutationFn: () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('saved'), 10),
          ),
        onSuccess: () => {
          inZone = NgZone.isInAngularZone()
        },
      }))

      TestBed.inject(NgZone).runOutsideAngular(() => m.mutate())
      tick(10)

      expect(inZone).toBe(false)
    }))
  })

  // A hook may return a promise. The run waits for it before moving on, and
  // stays pending until its last hook is done.
  describe('async hooks', () => {
    it('stays pending until an async onSuccess resolves', fakeAsync(() => {
      const response = new Subject<string>()
      const audit = deferred()
      const m = setup(() => ({
        mutationFn: () => response,
        // Logs the saved record somewhere, e.g. to an audit trail.
        onSuccess: () => audit.promise,
      }))

      m.mutate()
      response.next('saved')
      response.complete()
      flushMicrotasks()

      // The write landed, but its onSuccess is still running.
      expect(m.isPending()).toBe(true)
      expect(m.data()).toBeUndefined()

      audit.resolve()
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
    }))

    it('runs onSettled once an async onSuccess resolves', fakeAsync(() => {
      const audit = deferred()
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => audit.promise,
        onSettled,
      }))

      m.mutate()
      flushMicrotasks()

      expect(onSettled).not.toHaveBeenCalled()

      audit.resolve()
      flushMicrotasks()

      expect(onSettled).toHaveBeenCalledOnceWith(
        'saved',
        null,
        undefined,
        undefined,
      )
    }))

    it('stays pending until an async onError resolves, then runs onSettled', fakeAsync(() => {
      const error = new Error('boom')
      const rollback = deferred()
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => error),
        onError: () => rollback.promise,
        onSettled,
      }))

      m.mutate()
      flushMicrotasks()

      expect(m.isPending()).toBe(true)
      expect(onSettled).not.toHaveBeenCalled()

      rollback.resolve()
      flushMicrotasks()

      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(error)
      expect(onSettled).toHaveBeenCalledOnceWith(
        undefined,
        error,
        undefined,
        undefined,
      )
    }))

    it('stays pending until an async onSettled resolves', fakeAsync(() => {
      const cleanup = deferred()
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSettled: () => cleanup.promise,
      }))

      m.mutate()
      flushMicrotasks()

      expect(m.isPending()).toBe(true)

      cleanup.resolve()
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
    }))

    it('sends the write once an async onMutate resolves, and passes its value on as the context', fakeAsync(() => {
      const snapshot = deferred<{ previous: string[] }>()
      const sent: string[] = []
      const contexts: Array<{ previous: string[] } | undefined> = []
      const m = setup(() => ({
        mutationFn: (title: string) => {
          sent.push(title)

          return throwError(() => new Error('boom'))
        },
        // Snapshots the list for a rollback; getting it may take a while.
        onMutate: () => snapshot.promise,
        onError: (_error, _title, context) => contexts.push(context),
        onSettled: (_data, _error, _title, context) => contexts.push(context),
      }))

      m.mutate('b')
      flushMicrotasks()

      // Nothing goes out while onMutate is still running.
      expect(sent).toEqual([])

      snapshot.resolve({ previous: ['a'] })
      flushMicrotasks()

      expect(sent).toEqual(['b'])
      expect(contexts).toEqual([{ previous: ['a'] }, { previous: ['a'] }])
    }))

    it('settles inside mutate() when no hook returns a promise', () => {
      const saved: string[] = []
      const m = setup(() => ({
        mutationFn: () => of('note'),
        // Returns the new length, a plain value: nothing to wait for.
        onSuccess: (note) => saved.push(note),
      }))

      m.mutate()

      expect(m.isSuccess()).toBe(true)
      expect(saved).toEqual(['note'])
    })

    it('counts an earlier run until its onSuccess is done, while the signals follow the latest call', fakeAsync(() => {
      const responses = { a: new Subject<string>(), b: new Subject<string>() }
      const audits = { a: deferred(), b: deferred() }
      const m = setup(() => ({
        mutationFn: (title: 'a' | 'b') => responses[title],
        onSuccess: (_saved, title) => audits[title].promise,
      }))

      m.mutate('a')
      responses.a.next('a saved')
      responses.a.complete()
      m.mutate('b')

      // 'a' landed and its onSuccess is still running; 'b' is in flight.
      expect(client.isMutating()).toBe(2)
      expect(m.variables()).toBe('b')

      audits.a.resolve()
      flushMicrotasks()

      // 'a' is done and leaves the cache. The signals still follow 'b'.
      expect(client.isMutating()).toBe(1)
      expect(client.getMutationCache().getAll().length).toBe(1)
      expect(m.isPending()).toBe(true)
      expect(m.variables()).toBe('b')
    }))

    it('forgets a run whose onSuccess is still running, and counts it until that is done', fakeAsync(() => {
      const audit = deferred()
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => audit.promise,
        onSettled,
      }))

      m.mutate()
      m.reset()

      expect(m.isIdle()).toBe(true)
      expect(client.isMutating()).toBe(1)

      audit.resolve()
      flushMicrotasks()

      expect(onSettled).toHaveBeenCalled()
      expect(client.isMutating()).toBe(0)
      expect(client.getMutationCache().getAll().length).toBe(0)
      expect(m.isIdle()).toBe(true)
    }))

    it('lets a run finish its async onSuccess after the host is destroyed', fakeAsync(() => {
      const audit = deferred()
      const onSettled = jasmine.createSpy('onSettled')

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation<string, Error, void>(() => ({
          mutationFn: () => of('saved'),
          onSuccess: () => audit.promise,
          onSettled,
        }))
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate()
      fixture.destroy()

      expect(client.isMutating()).toBe(1)
      expect(onSettled).not.toHaveBeenCalled()

      audit.resolve()
      flushMicrotasks()

      expect(onSettled).toHaveBeenCalled()
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))

    it('still sends the write when reset() comes while an async onMutate runs', fakeAsync(() => {
      const snapshot = deferred()
      const sent: string[] = []
      const onSuccess = jasmine.createSpy('onSuccess')
      const m = setup(() => ({
        mutationFn: (title: string) => {
          sent.push(title)

          return of(title)
        },
        onMutate: () => snapshot.promise,
        onSuccess,
      }))

      m.mutate('b')
      m.reset()
      snapshot.resolve()
      flushMicrotasks()

      // reset() forgets the result; it doesn't call off the write.
      expect(sent).toEqual(['b'])
      expect(onSuccess).toHaveBeenCalled()
      expect(m.isIdle()).toBe(true)
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))

    // A list on screen whose requests stay in flight until the spec answers
    // the latest one.
    function showTodos(): { answer: (todos: string[]) => void } {
      let response = new Subject<string[]>()

      @Component({ template: '' })
      class TodoList {
        readonly todos = injectQuery(() => ({
          queryKey: ['todos'],
          queryFn: () => (response = new Subject<string[]>()),
        }))
      }

      TestBed.createComponent(TodoList).detectChanges()

      return {
        // The answer may start the next request, which replaces `response`.
        answer: (todos) => {
          const latest = response

          latest.next(todos)
          latest.complete()
        },
      }
    }

    it('stays pending until the refetch an onSuccess returns has landed', fakeAsync(() => {
      const list = showTodos()

      list.answer(['milk'])

      const m = setup(() => ({
        mutationFn: (title: string) => of(title),
        // Returned, so the mutation waits for the list to be fresh.
        onSuccess: () => client.invalidateQueries({ queryKey: ['todos'] }),
      }))

      m.mutate('bread')
      flushMicrotasks()

      expect(m.isPending()).toBe(true)

      list.answer(['milk', 'bread'])
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
    }))

    it('stays pending until the refetch after the list’s first load has landed', fakeAsync(() => {
      // The list's first load is still in flight.
      const list = showTodos()
      const m = setup(() => ({
        mutationFn: (title: string) => of(title),
        onSuccess: () => client.invalidateQueries({ queryKey: ['todos'] }),
      }))

      m.mutate('bread')
      flushMicrotasks()

      // The load lands, but it may have been read before the write.
      list.answer(['milk'])
      flushMicrotasks()

      expect(m.isPending()).toBe(true)

      list.answer(['milk', 'bread'])
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
    }))

    it("doesn't wait for a refetch an onSuccess only starts", fakeAsync(() => {
      const list = showTodos()

      list.answer(['milk'])

      const m = setup(() => ({
        mutationFn: (title: string) => of(title),
        // Not returned: the refetch runs on its own.
        onSuccess: () => {
          client.invalidateQueries({ queryKey: ['todos'] })
        },
      }))

      m.mutate('bread')
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
      expect(client.isFetching({ queryKey: ['todos'] })).toBe(1)
    }))
  })

  // A hook that fails doesn't change what happened to the write, and the
  // hooks after it still run. A failing onMutate stops the run before the
  // write is sent. Any other hook's error goes to the app's ErrorHandler,
  // once: nothing is rethrown on top of that, so flush() has nothing to
  // throw.
  describe('failing hooks', () => {
    it('fails the run without sending the write when onMutate throws', () => {
      const error = new Error('onMutate failed')
      const sent: string[] = []
      const onError = jasmine.createSpy('onError')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup(() => ({
        mutationFn: (title: string) => {
          sent.push(title)

          return of(title)
        },
        onMutate: () => {
          throw error
        },
        onError,
        onSettled,
      }))

      m.mutate('b')

      expect(sent).toEqual([])
      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(error)
      expect(onError).toHaveBeenCalledOnceWith(error, 'b', undefined)
      expect(onSettled).toHaveBeenCalledOnceWith(
        undefined,
        error,
        'b',
        undefined,
      )
    })

    it('counts an onMutate that throws as one failure', fakeAsync(() => {
      const error = new Error('onMutate failed')
      const m = setup(() => ({
        mutationFn: (title: string) => of(title),
        onMutate: () => {
          throw error
        },
        retry: 1,
        retryDelay: 10,
      }))

      m.mutate('b')
      tick(10)

      expect(m.error()).toBe(error)
      expect(m.failureCount()).toBe(1)
      expect(m.failureReason()).toBe(error)
    }))

    it('fails the run without sending the write when an async onMutate rejects', fakeAsync(() => {
      const error = new Error('onMutate failed')
      const snapshot = deferred<{ previous: string[] }>()
      const sent: string[] = []
      const onError = jasmine.createSpy('onError')
      const m = setup<string, Error, string, { previous: string[] }>(() => ({
        mutationFn: (title: string) => {
          sent.push(title)

          return of(title)
        },
        onMutate: () => snapshot.promise,
        onError,
      }))

      m.mutate('b')
      snapshot.reject(error)
      flushMicrotasks()

      expect(sent).toEqual([])
      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(error)
      expect(onError).toHaveBeenCalledOnceWith(error, 'b', undefined)
    }))

    it('keeps the success when onSuccess throws, still runs onSettled and reports the error', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('onSuccess failed')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw error
        },
        onSettled,
      }))

      m.mutate()

      // The write went through; a broken hook doesn't undo that.
      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
      expect(onSettled).toHaveBeenCalledOnceWith(
        'saved',
        null,
        undefined,
        undefined,
      )
      // The error isn't swallowed: the app's ErrorHandler gets it.
      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
    }))

    it('keeps the error when onError throws, still runs onSettled and reports the error', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('write failed')
      const rollbackError = new Error('rollback failed')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => error),
        onError: () => {
          throw rollbackError
        },
        onSettled,
      }))

      m.mutate()

      expect(m.isError()).toBe(true)
      expect(m.error()).toBe(error)
      expect(onSettled).toHaveBeenCalledOnceWith(
        undefined,
        error,
        undefined,
        undefined,
      )
      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(rollbackError)
    }))

    it('keeps the success when an async onSuccess rejects, and reports the error', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('audit failed')
      const audit = deferred()
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => audit.promise,
        onSettled,
      }))

      m.mutate()
      audit.reject(error)

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
      expect(onSettled).toHaveBeenCalledOnceWith(
        'saved',
        null,
        undefined,
        undefined,
      )
    }))

    it('keeps the outcome when onSettled throws, and reports the error', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('onSettled failed')
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSettled: () => {
          throw error
        },
      }))

      m.mutate()

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
    }))

    it('drops a forgotten run from the cache even when its hook throws', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const response = new Subject<string>()
      const m = setup(() => ({
        mutationFn: () => response,
        onSuccess: () => {
          throw new Error('onSuccess failed')
        },
      }))

      m.mutate()
      m.reset()
      response.next('saved')
      response.complete()

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledTimes(1)
      expect(client.getMutationCache().getAll().length).toBe(0)
      expect(client.isMutating()).toBe(0)
    }))

    it('reports each hook that fails, in order', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const auditError = new Error('audit failed')
      const cleanupError = new Error('cleanup failed')
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw auditError
        },
        onSettled: () => {
          throw cleanupError
        },
      }))

      m.mutate()

      expect(() => flush()).not.toThrow()
      expect(handleError.calls.allArgs()).toEqual([
        [auditError],
        [cleanupError],
      ])
    }))

    // A hook may fail with something that isn't an Error: HttpClient fails
    // with an HttpErrorResponse, say. The ErrorHandler gets it as it is.
    it('reports what a hook fails with as it is, an HttpErrorResponse say', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const response = new HttpErrorResponse({ status: 503, url: '/api/audit' })
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        // Records the write in an audit log, which is down.
        onSuccess: () => firstValueFrom(throwError(() => response)),
      }))

      m.mutate()

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(response)
      expect(m.isSuccess()).toBe(true)
    }))

    // zone.js catches an error thrown in Angular's zone, but not one thrown
    // outside it. A hook runs where mutate() was called from (see
    // 'side-effect callbacks'), and its error reaches the ErrorHandler either
    // way.
    it('reports the error of a hook from a mutate() called in the Angular zone, as a click handler does', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('onSuccess failed')
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw error
        },
      }))

      TestBed.inject(NgZone).run(() => m.mutate())

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
    }))

    it('reports the error of a hook from a mutate() called outside the Angular zone', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('onSuccess failed')
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw error
        },
      }))

      TestBed.inject(NgZone).runOutsideAngular(() => m.mutate())

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
    }))

    // Without zone.js nothing on the server catches an error left to surface
    // on its own: Node ends the process before the page is written out. A
    // hook that reaches for an API only the browser has is enough.
    it('reports the error of a hook during a server render without zone.js, and lets the render finish', fakeAsync(() => {
      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideQueryClient(),
          { provide: PLATFORM_ID, useValue: 'server' },
        ],
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new ReferenceError('localStorage is not defined')

      @Component({
        template: `
          {{ save.status() }}
        `,
      })
      class SaveDraft {
        readonly save = injectMutation(() => ({
          mutationFn: () => of('saved'),
          // Keeps a copy in localStorage, which the server doesn't have.
          onSuccess: () => {
            throw error
          },
        }))

        constructor() {
          this.save.mutate()
        }
      }

      const fixture = TestBed.createComponent(SaveDraft)

      expect(appIsStable()).toBe(true)
      expect(fixture.nativeElement.textContent.trim()).toBe('success')
      expect(handleError).toHaveBeenCalledOnceWith(error)
    }))

    // An app's ErrorHandler may use the client itself, to clear the cache
    // when the session ends, say. The client mustn't need the ErrorHandler
    // while it's being created, or neither could be.
    it('reports to an ErrorHandler that uses the QueryClient itself', fakeAsync(() => {
      @Injectable()
      class AppErrorHandler implements ErrorHandler {
        readonly client = inject(QueryClient)
        readonly errors: unknown[] = []

        handleError(error: unknown): void {
          this.errors.push(error)
        }
      }

      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(),
          { provide: ErrorHandler, useClass: AppErrorHandler },
        ],
      })

      const handler = TestBed.inject(ErrorHandler) as AppErrorHandler
      const error = new Error('onSuccess failed')
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw error
        },
      }))

      m.mutate()

      expect(() => flush()).not.toThrow()
      expect(handler.errors).toEqual([error])
    }))

    // A client provided by another environment injector, a lazy route's say,
    // reports to the ErrorHandler that injector has, as its default hooks
    // get theirs from it with inject().
    it('reports to the ErrorHandler of the injector that provides the client', fakeAsync(() => {
      const appHandleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const routeHandler = { handleError: jasmine.createSpy('handleError') }
      const injector = createEnvironmentInjector(
        [
          provideQueryClient(),
          { provide: ErrorHandler, useValue: routeHandler },
        ],
        TestBed.inject(EnvironmentInjector),
      )
      const error = new Error('onSuccess failed')
      const m = injectMutation(
        () => ({
          mutationFn: () => of('saved'),
          onSuccess: () => {
            throw error
          },
        }),
        { injector },
      )

      m.mutate()

      expect(() => flush()).not.toThrow()
      expect(routeHandler.handleError).toHaveBeenCalledOnceWith(error)
      expect(appHandleError).not.toHaveBeenCalled()

      injector.destroy()
    }))

    // Angular calls the ErrorHandler outside its zone, and so does a failing
    // hook's report, from a hook that ran in the zone too. A timer the
    // handler sets, to hide the message it shows say, doesn't keep a zone.js
    // app busy, or hold up a server render.
    it('lets a zone.js app settle while its ErrorHandler hides a message on a timer', fakeAsync(() => {
      const handleError = spyOn(
        TestBed.inject(ErrorHandler),
        'handleError',
      ).and.callFake(() => {
        // Shows the error, and hides it 3 seconds later.
        setTimeout(() => undefined, 3000)
      })
      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw new Error('onSuccess failed')
        },
      }))

      TestBed.inject(NgZone).run(() => m.mutate())

      expect(appIsStable()).toBe(true)
      expect(handleError).toHaveBeenCalledTimes(1)

      flush()
    }))

    // An ErrorHandler that throws, as one a test provides to fail on any
    // error does, mustn't leave the run hanging: it settles, and the hook's
    // error surfaces as an unhandled rejection, as with no ErrorHandler.
    it('settles the run when the ErrorHandler throws too, and lets the error surface as an unhandled rejection', fakeAsync(() => {
      spyOn(TestBed.inject(ErrorHandler), 'handleError').and.callFake(
        (error: unknown) => {
          throw error
        },
      )

      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw new Error('onSuccess failed')
        },
        onSettled,
      }))

      m.mutate()

      expect(m.isSuccess()).toBe(true)
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(client.isMutating()).toBe(0)
      // fakeAsync rethrows an unhandled rejection when microtasks run.
      expect(() => flush()).toThrowError(
        /Uncaught \(in promise\): Error: onSuccess failed/,
      )
    }))

    // A bootstrapped app hands an error that surfaces in Angular's zone to its
    // ErrorHandler (TestBed doesn't, so the spec listens itself). An error
    // the ErrorHandler threw back surfaces outside the zone, or it would reach
    // that ErrorHandler a second time.
    it("lets the error surface outside the Angular zone when the ErrorHandler throws, so it isn't handed back to it", async () => {
      spyOn(TestBed.inject(ErrorHandler), 'handleError').and.callFake(
        (error: unknown) => {
          throw error
        },
      )
      // zone.js logs the rejection that surfaces outside the zone.
      spyOn(console, 'error')

      const zone = TestBed.inject(NgZone)
      const handedBack: unknown[] = []

      zone.onError.subscribe((error: unknown) => handedBack.push(error))

      const m = setup(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => {
          throw new Error('onSuccess failed')
        },
      }))

      zone.run(() => m.mutate())
      await new Promise((resolve) => setTimeout(resolve))

      expect(m.isSuccess()).toBe(true)
      expect(handedBack).toEqual([])
    })

    // The injector that provides the client can go first, with the app or
    // the test, while a run is in flight. A hook that fails after that can't
    // reach the app's ErrorHandler through it, whatever was reported before:
    // its error surfaces as an unhandled rejection, and the run settles all
    // the same.
    it('settles a run whose hook fails once the client is gone, and lets the error surface as an unhandled rejection', fakeAsync(() => {
      const injector = createEnvironmentInjector(
        [provideQueryClient()],
        TestBed.inject(EnvironmentInjector),
      )
      const handleError = spyOn(injector.get(ErrorHandler), 'handleError')
      const responses: Array<Subject<string>> = []
      const m = injectMutation(
        () => ({
          mutationFn: () => {
            const response = new Subject<string>()

            responses.push(response)

            return response
          },
          onSuccess: () => {
            throw new Error('onSuccess failed')
          },
        }),
        { injector },
      )

      // A run whose hook fails while the client is still there.
      m.mutate()
      responses[0].next('saved')
      responses[0].complete()

      expect(handleError).toHaveBeenCalledTimes(1)

      m.mutate()
      injector.destroy()
      responses[1].next('saved')
      responses[1].complete()

      expect(m.isSuccess()).toBe(true)
      expect(handleError).toHaveBeenCalledTimes(1)
      expect(() => flush()).toThrowError(
        /Uncaught \(in promise\): Error: onSuccess failed/,
      )
    }))
  })

  describe('independent instances', () => {
    it('keeps separate state per mutation', () => {
      const a = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v),
      }))
      const b = setup<number, Error, number>(() => ({
        mutationFn: (v) => of(v * 10),
      }))

      a.mutate(1)
      b.mutate(2)

      expect(a.data()).toBe(1)
      expect(b.data()).toBe(20)
    })
  })

  describe('lifecycle', () => {
    it('does not touch the cache until the first mutate()', () => {
      const m = setup(() => ({ mutationFn: () => of(1) }))

      // Nothing has run, so there's nothing to observe or count.
      expect(client.getMutationCache().getAll().length).toBe(0)

      m.mutate()

      expect(client.getMutationCache().getAll().length).toBe(1)
    })

    it('removes a settled mutation from the cache when the host is destroyed', () => {
      @Component({ template: '' })
      class Host {
        readonly m = injectMutation(() => ({ mutationFn: () => of(1) }))
      }

      const fixture: ComponentFixture<Host> = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.m.mutate()

      expect(client.getMutationCache().getAll().length).toBe(1)

      fixture.destroy()

      expect(client.getMutationCache().getAll().length).toBe(0)
    })

    it('lets an in-flight mutation finish after the host is destroyed', fakeAsync(() => {
      const subject = new Subject<number>()
      const onSuccess = jasmine.createSpy('onSuccess')

      @Component({ template: '' })
      class Host {
        readonly m = injectMutation<number, Error, void>(() => ({
          mutationFn: () => subject,
          onSuccess,
        }))
      }

      const fixture: ComponentFixture<Host> = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.m.mutate()
      fixture.destroy()

      // The write is probably already on the server; cancelling would skip
      // onSuccess and leave the cache stale. So it runs to completion.
      subject.next(7)
      subject.complete()
      tick()

      expect(onSuccess).toHaveBeenCalledWith(7, undefined, undefined)
      // …and cleans itself out of the cache once it's done.
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))

    // A mutate() can also come after the host is gone: from a timer, a promise
    // chain, or a callback that saves on leave. It runs as any other does (the
    // write goes out and the hooks fire), but the host no longer holds it in
    // the cache, so it drops out once it settles.

    it('runs a mutation started after the host is destroyed, then drops it from the cache', () => {
      const sent: Array<[number, string]> = []
      const onSuccess = jasmine.createSpy('onSuccess')
      const onSettled = jasmine.createSpy('onSettled')
      const { fixture } = mountHost((listId: Signal<number>) => {
        const saveDraft = injectMutation<string, Error, string>(() => ({
          mutationFn: (draft) => {
            sent.push([listId(), draft])

            return of('saved')
          },
          onSuccess,
          onSettled,
        }))

        // Saves the draft on leave. Registered after the mutation, so it runs
        // once the mutation has already let go of the host.
        inject(DestroyRef).onDestroy(() => saveDraft.mutate('milk'))

        return saveDraft
      }, 7)

      fixture.destroy()

      expect(sent).toEqual([[7, 'milk']])
      expect(onSuccess).toHaveBeenCalledWith('saved', 'milk', undefined)
      expect(onSettled).toHaveBeenCalled()
      expect(client.getMutationCache().getAll().length).toBe(0)
    })

    it('runs a mutation with a key started after the host is destroyed', () => {
      const sent: string[] = []

      @Component({ template: '' })
      class Page {
        readonly id = input.required<number>()
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', this.id()],
          mutationFn: (title) => {
            sent.push(title)

            return of(title)
          },
        }))
      }

      const fixture = TestBed.createComponent(Page)

      fixture.componentRef.setInput('id', 1)
      fixture.detectChanges()
      fixture.destroy()

      expect(() =>
        fixture.componentInstance.save.mutate('Buy milk'),
      ).not.toThrow()
      expect(sent).toEqual(['Buy milk'])
    })

    // On the server, Angular tears the app down after each render: it marks
    // the app's injector destroyed first, then destroys the components, so a
    // DestroyRef callback runs with the client's injector gone.
    it('runs a mutation its component starts as the whole app is torn down', async () => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))

      @Component({ selector: 'nsq-draft-editor', template: '' })
      class DraftEditor {
        readonly saveDraft = injectMutation<string, Error, string>(() => ({
          mutationFn,
        }))

        constructor() {
          // Saves the draft on leave.
          inject(DestroyRef).onDestroy(() => this.saveDraft.mutate('milk'))
        }
      }

      const host = document.body.appendChild(
        document.createElement('nsq-draft-editor'),
      )
      const app = await createApplication({
        providers: [provideZonelessChangeDetection(), provideQueryClient()],
      })

      app.bootstrap(DraftEditor, host)

      expect(() => app.destroy()).not.toThrow()
      expect(mutationFn).toHaveBeenCalledOnceWith('milk')

      host.remove()
    })

    // A route's providers make an environment injector below the app's, which
    // the router never destroys, not even with the app. As the app is torn
    // down, the client's own injector still counts as alive, but what the
    // client reaches through it from the app's injector is gone.
    it('runs a mutation its component starts as the whole app is torn down, with the client provided below the app', async () => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))

      @Component({ selector: 'nsq-draft-editor', template: '' })
      class DraftEditor {
        readonly saveDraft = injectMutation<string, Error, string>(() => ({
          mutationFn,
        }))

        constructor() {
          // Saves the draft on leave.
          inject(DestroyRef).onDestroy(() => this.saveDraft.mutate('milk'))
        }
      }

      const host = document.body.appendChild(
        document.createElement('nsq-draft-editor'),
      )
      const app = await createApplication({
        providers: [provideZonelessChangeDetection()],
      })
      // Made as the router makes a route's, with the client among its
      // providers.
      const route = createEnvironmentInjector(
        [provideQueryClient()],
        app.injector,
      )
      const editor = createComponent(DraftEditor, {
        environmentInjector: route,
        hostElement: host,
      })

      app.attachView(editor.hostView)

      expect(() => app.destroy()).not.toThrow()
      expect(mutationFn).toHaveBeenCalledOnceWith('milk')

      // The router never destroys it; the spec does, to leave nothing behind.
      route.destroy()
      host.remove()
    })

    // ngOnDestroy runs before the DestroyRef callbacks, once Angular already
    // counts the injector as destroyed.
    it("runs a mutation with a key that its component's ngOnDestroy starts as the whole app is torn down", async () => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))

      @Component({ selector: 'nsq-draft-editor', template: '' })
      class DraftEditor implements OnDestroy {
        readonly saveDraft = injectMutation<string, Error, string>(() => ({
          mutationKey: ['drafts', 'save'],
          mutationFn,
        }))

        // Saves the draft on leave.
        ngOnDestroy(): void {
          this.saveDraft.mutate('milk')
        }
      }

      const host = document.body.appendChild(
        document.createElement('nsq-draft-editor'),
      )
      const app = await createApplication({
        providers: [provideZonelessChangeDetection(), provideQueryClient()],
      })

      app.bootstrap(DraftEditor, host)

      expect(() => app.destroy()).not.toThrow()
      expect(mutationFn).toHaveBeenCalledOnceWith('milk')

      host.remove()
    })

    it("runs a mutation with a key that a service's ngOnDestroy starts as its injector is destroyed", () => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))

      @Injectable()
      class DraftEditor implements OnDestroy {
        readonly saveDraft = injectMutation<string, Error, string>(() => ({
          mutationKey: ['drafts', 'save'],
          mutationFn,
        }))

        ngOnDestroy(): void {
          this.saveDraft.mutate('milk')
        }
      }

      // Such as a route's injector, when the app leaves the route.
      const injector = createEnvironmentInjector(
        [DraftEditor],
        TestBed.inject(EnvironmentInjector),
      )

      injector.get(DraftEditor)

      expect(() => injector.destroy()).not.toThrow()
      expect(mutationFn).toHaveBeenCalledOnceWith('milk')
      expect(client.getMutationCache().getAll().length).toBe(0)
    })

    it('runs a mutation with a key started after the injector of the service that keeps it is destroyed', () => {
      const sent: string[] = []

      @Injectable()
      class Editor {
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationKey: ['todos', 'update', 1],
          mutationFn: (title) => {
            sent.push(title)

            return of(title)
          },
        }))
      }

      // Such as a route's injector, when the app leaves the route.
      const injector = createEnvironmentInjector(
        [Editor],
        TestBed.inject(EnvironmentInjector),
      )
      const editor = injector.get(Editor)

      injector.destroy()

      expect(() => editor.save.mutate('Buy milk')).not.toThrow()
      expect(sent).toEqual(['Buy milk'])
    })

    it('drops a mutation started after the host is destroyed once its request lands', fakeAsync(() => {
      const created = new Subject<number>()
      const attached = new Subject<string>()
      const onSettled = jasmine.createSpy('onSettled')

      @Component({ template: '' })
      class Host {
        readonly create = injectMutation<number, Error, string>(() => ({
          mutationFn: () => created,
        }))

        readonly attach = injectMutation<string, Error, number>(() => ({
          mutationFn: () => attached,
          onSettled,
        }))

        // Creates the todo, then adds it to the list.
        add(title: string): void {
          this.create.mutateAsync(title).then((id) => this.attach.mutate(id))
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.add('milk')
      // The user leaves while the todo is being created.
      fixture.destroy()
      created.next(1)
      created.complete()
      flushMicrotasks()

      // The second write goes out after the host is gone.
      expect(client.isMutating()).toBe(1)

      attached.next('attached')
      attached.complete()

      expect(onSettled).toHaveBeenCalledWith('attached', null, 1, undefined)
      expect(client.isMutating()).toBe(0)
      expect(client.getMutationCache().getAll().length).toBe(0)
    }))

    it('drops a mutation started after its injector is destroyed', () => {
      const injector = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      )
      const m = injectMutation<number, Error, number>(
        () => ({ mutationFn: (v) => of(v) }),
        { injector },
      )

      injector.destroy()
      m.mutate(1)

      expect(client.getMutationCache().getAll().length).toBe(0)
    })

    it('keeps showing a mutation started after the host is destroyed', () => {
      const response = new Subject<string>()

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationFn: () => response,
        }))
      }

      const fixture = TestBed.createComponent(Host)
      const { save } = fixture.componentInstance

      fixture.detectChanges()
      fixture.destroy()
      // e.g. from a timer the host set, firing after it's gone
      save.mutate('milk')

      // The signals follow the latest call, whether it came before the
      // destroy or after it.
      expect(save.isPending()).toBe(true)
      expect(save.variables()).toBe('milk')

      response.next('saved')
      response.complete()

      expect(save.isSuccess()).toBe(true)
      expect(save.data()).toBe('saved')
    })

    it('replaces settled runs in the cache rather than piling them up', () => {
      const m = setup(() => ({ mutationFn: () => of(1) }))

      m.mutate()
      m.mutate()
      m.mutate()

      expect(client.getMutationCache().getAll().length).toBe(1)
    })
  })

  describe('after clear()', () => {
    // clear() forgets every mutation but stops none: as when its component
    // goes away, a run in flight has most likely reached the server.

    it('lets a run in flight finish and run its hooks, and shows how it went', fakeAsync(() => {
      const response = new Subject<string>()
      const onSuccess = jasmine.createSpy('onSuccess')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => response,
        onSuccess,
        onSettled,
      }))

      m.mutate()
      client.clear()

      expect(m.isPending()).toBe(true)

      response.next('saved')
      response.complete()
      flushMicrotasks()

      expect(onSuccess).toHaveBeenCalledWith('saved', undefined, undefined)
      expect(onSettled).toHaveBeenCalled()
      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
    }))

    it('lets the run that calls it from a hook finish', fakeAsync(() => {
      // e.g. a sign-out that clears the cache once the server confirms it
      const response = new Subject<string>()
      const onSettled = jasmine.createSpy('onSettled')
      const signOut = setup<string, Error, void>(() => ({
        mutationFn: () => response,
        onSuccess: () => client.clear(),
        onSettled,
      }))
      const result = settled(signOut.mutateAsync())

      response.next('signed out')
      response.complete()
      flushMicrotasks()

      expect(onSettled).toHaveBeenCalled()
      expect(result.value).toBe('signed out')
      expect(signOut.isSuccess()).toBe(true)
    }))

    it('lets a run waiting to retry try again', fakeAsync(() => {
      const mutationFn = jasmine.createSpy('mutationFn').and.returnValues(
        throwError(() => new Error('down')),
        of('saved'),
      )
      const m = setup<unknown, Error, void>(() => ({
        mutationFn,
        retry: 1,
        retryDelay: 100,
      }))

      m.mutate()
      client.clear()
      tick(100)

      expect(mutationFn).toHaveBeenCalledTimes(2)
      expect(m.data()).toBe('saved')
    }))

    it('keeps showing a run that has settled', () => {
      const m = setup<string, Error, string>(() => ({
        mutationFn: (title) => of(title),
      }))

      m.mutate('milk')
      client.clear()

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('milk')
    })
  })

  // Angular waits for the app to be stable, with nothing pending, before it
  // sends a server render and before whenStable() resolves in a test. A run
  // keeps the app busy from mutate() until its last hook is done, whatever
  // its mutationFn sends the write with.
  describe('app stability', () => {
    it('keeps the app busy from mutate() until its last hook is done', fakeAsync(() => {
      const response = new Subject<string>()
      const audit = deferred<void>()
      const m = setup<string, Error, string>(() => ({
        mutationFn: () => response,
        onSuccess: () => audit.promise,
      }))

      m.mutate('milk')
      expect(appIsStable()).toBe(false)

      response.next('saved')
      response.complete()
      expect(appIsStable()).toBe(false)

      audit.resolve()

      expect(appIsStable()).toBe(true)
      expect(m.isSuccess()).toBe(true)
    }))

    it('lets the app settle once a failed run is through its hooks', fakeAsync(() => {
      const response = new Subject<string>()
      const cleanup = deferred<void>()
      const m = setup<string, Error, string>(() => ({
        mutationFn: () => response,
        onSettled: () => cleanup.promise,
      }))

      m.mutate('milk')
      response.error(new Error('down'))
      expect(appIsStable()).toBe(false)

      cleanup.resolve()

      expect(appIsStable()).toBe(true)
      expect(m.isError()).toBe(true)
    }))

    it('keeps the app busy while an async onMutate runs, before the write is sent', fakeAsync(() => {
      const prepared = deferred<void>()
      const response = new Subject<string>()
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(response)
      const m = setup<string, Error, string>(() => ({
        mutationFn,
        onMutate: () => prepared.promise,
      }))

      m.mutate('milk')

      expect(mutationFn).not.toHaveBeenCalled()
      expect(appIsStable()).toBe(false)

      prepared.resolve()
      flushMicrotasks()
      response.next('saved')
      response.complete()

      expect(appIsStable()).toBe(true)
      expect(m.isSuccess()).toBe(true)
    }))

    it('keeps the app busy through the retries of a write, the waits between them included', fakeAsync(() => {
      const responses: Array<Subject<string>> = []
      const m = setup<string, Error, string>(() => ({
        mutationFn: () => {
          const response = new Subject<string>()

          responses.push(response)

          return response
        },
        retry: 1,
        retryDelay: 100,
      }))

      m.mutate('milk')
      responses[0].error(new Error('down'))
      tick(99)
      expect(appIsStable()).toBe(false)

      tick(1)
      responses[1].next('saved')
      responses[1].complete()

      expect(appIsStable()).toBe(true)
      expect(m.isSuccess()).toBe(true)
    }))

    it('keeps the app busy until a run its component left is done', fakeAsync(() => {
      const response = new Subject<string>()

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationFn: () => response,
        }))
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate('milk')
      // The write has most likely reached the server: the run goes on.
      fixture.destroy()

      expect(appIsStable()).toBe(false)

      response.next('saved')
      response.complete()

      expect(appIsStable()).toBe(true)
    }))

    it('lets whenStable() resolve once the run is done', async () => {
      const m = setup<string, Error, string>(() => ({
        mutationFn: (title) =>
          new Promise((resolve) => setTimeout(() => resolve(title), 20)),
      }))

      m.mutate('milk')
      await TestBed.inject(ApplicationRef).whenStable()

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('milk')
    })

    it('keeps a server render waiting until the run is done', fakeAsync(() => {
      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(),
          { provide: PLATFORM_ID, useValue: 'server' },
        ],
      })

      const response = new Subject<string>()
      const m = setup<string, Error, string>(() => ({
        mutationFn: () => response,
      }))

      m.mutate('milk')
      expect(appIsStable()).toBe(false)

      response.next('saved')
      response.complete()

      expect(appIsStable()).toBe(true)
      expect(m.isSuccess()).toBe(true)
    }))

    // A run already going when the injector that provides its client is
    // destroyed is let finish, as its write has most likely reached the
    // server, and the app waits for it.
    it("keeps the app busy until a run going when the client's injector is destroyed is done", fakeAsync(() => {
      const clientInjector = createEnvironmentInjector(
        [provideQueryClient()],
        TestBed.inject(EnvironmentInjector),
      )
      // Made by hand, it can outlive the injector of the client it uses.
      const injector = createEnvironmentInjector([], clientInjector)
      const response = new Subject<string>()
      const m = injectMutation<string, Error, string>(
        () => ({ mutationFn: () => response }),
        { injector },
      )

      m.mutate('milk')
      clientInjector.destroy()

      expect(appIsStable()).toBe(false)

      response.next('saved')
      response.complete()

      expect(m.isSuccess()).toBe(true)
      expect(appIsStable()).toBe(true)
    }))

    // A run started on a client after the injector that provides it is
    // destroyed still runs, but doesn't keep the app busy.
    it("doesn't let a run started after the client's injector is destroyed keep the app busy", fakeAsync(() => {
      const clientInjector = createEnvironmentInjector(
        [provideQueryClient()],
        TestBed.inject(EnvironmentInjector),
      )
      // Made by hand, it can outlive the injector of the client it uses.
      const injector = createEnvironmentInjector([], clientInjector)
      const response = new Subject<string>()
      const m = injectMutation<string, Error, string>(
        () => ({
          mutationFn: (title) => (title === 'eggs' ? of(title) : response),
        }),
        { injector },
      )

      // One while the client's injector was there, answered at once.
      m.mutate('eggs')
      clientInjector.destroy()
      m.mutate('milk')

      expect(appIsStable()).toBe(true)

      response.next('saved')
      response.complete()

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
    }))

    // zone.js counts the app as busy while a timer set in the Angular zone is
    // pending. A request can leave a timer of its own running after the
    // response, as Node's fetch() does.
    it('lets a zone.js app settle once the run is done, though its request leaves a timer running', fakeAsync(() => {
      const m = setup(() => ({
        mutationFn: () => {
          setTimeout(() => undefined, 10_000)

          return of('saved')
        },
      }))

      // As a click handler calls it: in the Angular zone.
      TestBed.inject(NgZone).run(() => m.mutate())

      expect(m.isSuccess()).toBe(true)
      expect(appIsStable()).toBe(true)
    }))

    // Angular ticks from outside the zone when an app calls
    // ApplicationRef.tick() there, as these specs do. A run an effect starts
    // during such a tick is asked for from outside the zone, so its outcome
    // stays there: entering the zone for an answer that comes at once would
    // make Angular start another tick in the middle of that one (NG0101).
    // Angular 19 throws that error from a timer a moment later instead of
    // handing it to the ErrorHandler, so these specs end with flush().
    it('lets Angular tick from outside the zone while a run an effect starts answers at once', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const save = signal(false)
      const m = setup(() => ({ mutationFn: () => of('saved') }))

      TestBed.runInInjectionContext(() =>
        effect(() => {
          if (save()) m.mutate()
        }),
      )
      save.set(true)
      TestBed.inject(ApplicationRef).tick()

      expect(m.isSuccess()).toBe(true)
      expect(handleError).not.toHaveBeenCalled()

      flush()
    }))

    // The same for a run asked for from inside the zone, answered in the
    // middle of such a tick, as a test double answering in a lifecycle hook
    // does. A run nobody waits for leaves nothing else in the zone to wait
    // for once it lands.
    it('lets Angular tick from outside the zone while a run lands that nobody waits for', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const ack = new Subject<string>()
      let answer: (() => void) | undefined

      @Component({
        template: `
          {{ save.status() }}
        `,
      })
      class SaveTodo implements DoCheck {
        readonly save = injectMutation(() => ({ mutationFn: () => ack }))

        ngDoCheck(): void {
          answer?.()
          answer = undefined
        }
      }

      const fixture = TestBed.createComponent(SaveTodo)
      const app = TestBed.inject(ApplicationRef)

      fixture.detectChanges()
      // A click handler that starts the write and doesn't wait for it.
      TestBed.inject(NgZone).run(() => {
        fixture.componentInstance.save.mutateAsync()
      })
      answer = () => ack.next('saved')
      // Attached as an app's components are, so the app's tick checks it.
      app.attachView(fixture.componentRef.hostView)
      app.tick()

      expect(fixture.componentInstance.save.isSuccess()).toBe(true)
      expect(handleError).not.toHaveBeenCalled()

      flush()
    }))
  })

  describe('concurrent calls', () => {
    it('keeps the latest call as the result, even if an earlier one lands later', fakeAsync(() => {
      const slow = new Subject<string>()
      const fast = new Subject<string>()
      const sources = [slow, fast]

      const m = setup(() => ({
        mutationFn: (variables: string) =>
          sources[variables === 'slow' ? 0 : 1],
      }))

      m.mutate('slow')
      m.mutate('fast')

      // The later call is the one being tracked.
      expect(m.variables()).toBe('fast')

      fast.next('fast result')
      fast.complete()
      tick()

      expect(m.data()).toBe('fast result')

      // The superseded run finishes afterwards. It must not hijack the state.
      slow.next('slow result')
      slow.complete()
      tick()

      expect(m.data()).toBe('fast result')
      expect(m.variables()).toBe('fast')
    }))

    it('does not cancel the earlier call, and still runs its hooks', fakeAsync(() => {
      const slow = new Subject<string>()
      const fast = new Subject<string>()
      const sources = [slow, fast]
      const onSuccess = jasmine.createSpy('onSuccess')

      const m = setup(() => ({
        mutationFn: (variables: string) =>
          sources[variables === 'slow' ? 0 : 1],
        onSuccess,
      }))

      m.mutate('slow')
      m.mutate('fast')

      fast.next('fast result')
      fast.complete()
      slow.next('slow result')
      slow.complete()
      tick()

      // Both writes happened, so both get their side effects.
      expect(onSuccess).toHaveBeenCalledTimes(2)
      expect(onSuccess).toHaveBeenCalledWith('fast result', 'fast', undefined)
      expect(onSuccess).toHaveBeenCalledWith('slow result', 'slow', undefined)
    }))
  })

  // mutateAsync() runs the mutation as mutate() does and returns a promise of
  // the run, settled as its state is.
  describe('mutateAsync', () => {
    it('resolves with the data once the hooks are done', fakeAsync(() => {
      const audit = deferred()
      const m = setup(() => ({
        mutationFn: (title: string) => of(title),
        onSuccess: () => audit.promise,
      }))
      const result = settled(m.mutateAsync('milk'))

      flushMicrotasks()
      expect(result).toEqual({})

      audit.resolve()
      flushMicrotasks()

      expect(result.value).toBe('milk')
      expect(m.isSuccess()).toBe(true)
    }))

    it('rejects with the error once onError and onSettled are done', fakeAsync(() => {
      const error = new Error('down')
      const cleanup = deferred()
      const onError = jasmine.createSpy('onError')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => error),
        onError,
        onSettled: () => cleanup.promise,
      }))
      const result = settled(m.mutateAsync())

      flushMicrotasks()
      expect(onError).toHaveBeenCalled()
      expect(result).toEqual({})

      cleanup.resolve()
      flushMicrotasks()

      expect(result.error).toBe(error)
      expect(m.isError()).toBe(true)
    }))

    it('rejects without sending the write when onMutate fails', fakeAsync(() => {
      const error = new Error('no snapshot')
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))
      const m = setup<string, Error, void>(() => ({
        mutationFn,
        onMutate: () => {
          throw error
        },
      }))
      const result = settled(m.mutateAsync())

      flushMicrotasks()

      expect(result.error).toBe(error)
      expect(mutationFn).not.toHaveBeenCalled()
    }))

    it('resolves when onSuccess fails, as the write went through', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('audit down')
      const m = setup(() => ({
        mutationFn: (title: string) => of(title),
        onSuccess: () => {
          throw error
        },
      }))
      const result = settled(m.mutateAsync('milk'))

      // The hook's error goes to the ErrorHandler, as with mutate().
      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
      expect(result.value).toBe('milk')
    }))

    it('settles each call with its own run', fakeAsync(() => {
      const responses: Array<Subject<string>> = []
      const m = setup(() => ({
        mutationFn: () => {
          const response = new Subject<string>()

          responses.push(response)

          return response
        },
      }))
      const first = settled(m.mutateAsync())
      const second = settled(m.mutateAsync())

      // The later call lands first.
      responses[1].next('b')
      responses[1].complete()
      flushMicrotasks()

      expect(second.value).toBe('b')
      expect(first).toEqual({})

      responses[0].next('a')
      responses[0].complete()
      flushMicrotasks()

      expect(first.value).toBe('a')
      // The signals follow the latest call.
      expect(m.data()).toBe('b')
    }))

    it('settles after the component that started it is gone', fakeAsync(() => {
      const response = new Subject<string>()

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation(() => ({ mutationFn: () => response }))
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      const result = settled(fixture.componentInstance.save.mutateAsync())

      fixture.destroy()
      response.next('saved')
      response.complete()
      flushMicrotasks()

      expect(result.value).toBe('saved')
    }))

    it('surfaces a failure nobody catches as an unhandled rejection, unlike mutate()', fakeAsync(() => {
      const m = setup(() => ({
        mutationFn: () => throwError(() => new Error('down')),
      }))

      m.mutate()
      expect(() => flushMicrotasks()).not.toThrow()

      m.mutateAsync()
      // fakeAsync rethrows an unhandled rejection when microtasks run.
      expect(() => flushMicrotasks()).toThrowError(/down/)
    }))
  })

  // A call of mutate() or mutateAsync() can bring callbacks of its own, for
  // the component's reaction to that write, such as closing a dialog or
  // showing a message. They run after the mutation's own hooks, once the
  // signals show how the run went, for every call, until the host of the
  // mutation is destroyed.
  describe('per-call callbacks', () => {
    it("calls the call's onSuccess and onSettled after the mutation's own hooks, with the data, the variables and the context", () => {
      const order: string[] = []
      const onSuccess = jasmine
        .createSpy('onSuccess')
        .and.callFake(() => order.push('call onSuccess'))
      const onError = jasmine.createSpy('onError')
      const onSettled = jasmine
        .createSpy('onSettled')
        .and.callFake(() => order.push('call onSettled'))
      const m = setup<string, Error, string, { previous: string }>(() => ({
        mutationFn: (title) => of(`saved ${title}`),
        onMutate: () => ({ previous: 'a' }),
        onSuccess: () => order.push('own onSuccess'),
        onSettled: () => order.push('own onSettled'),
      }))

      // of() answers at once, so all of it happens inside mutate().
      m.mutate('b', { onSuccess, onError, onSettled })

      expect(order).toEqual([
        'own onSuccess',
        'own onSettled',
        'call onSuccess',
        'call onSettled',
      ])
      expect(onSuccess).toHaveBeenCalledOnceWith('saved b', 'b', {
        previous: 'a',
      })
      expect(onError).not.toHaveBeenCalled()
      expect(onSettled).toHaveBeenCalledOnceWith('saved b', null, 'b', {
        previous: 'a',
      })
    })

    it("calls the call's onError and onSettled after the mutation's own hooks when the write fails", () => {
      const error = new Error('down')
      const order: string[] = []
      const onSuccess = jasmine.createSpy('onSuccess')
      const onError = jasmine
        .createSpy('onError')
        .and.callFake(() => order.push('call onError'))
      const onSettled = jasmine
        .createSpy('onSettled')
        .and.callFake(() => order.push('call onSettled'))
      const m = setup<string, Error, string, { previous: string }>(() => ({
        mutationFn: () => throwError(() => error),
        onMutate: () => ({ previous: 'a' }),
        onError: () => order.push('own onError'),
        onSettled: () => order.push('own onSettled'),
      }))

      m.mutate('b', { onSuccess, onError, onSettled })

      expect(order).toEqual([
        'own onError',
        'own onSettled',
        'call onError',
        'call onSettled',
      ])
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledOnceWith(error, 'b', { previous: 'a' })
      expect(onSettled).toHaveBeenCalledOnceWith(undefined, error, 'b', {
        previous: 'a',
      })
    })

    it("calls the call's onError and onSettled when onMutate fails, and sends nothing", () => {
      const error = new Error('no snapshot')
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))
      const onError = jasmine.createSpy('onError')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, string>(() => ({
        mutationFn,
        onMutate: () => {
          throw error
        },
      }))

      m.mutate('b', { onError, onSettled })

      expect(mutationFn).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledOnceWith(error, 'b', undefined)
      expect(onSettled).toHaveBeenCalledOnceWith(
        undefined,
        error,
        'b',
        undefined,
      )
    })

    it("runs the callbacks of withMutationCache, then the mutation's own hooks, then the call's", () => {
      const order: string[] = []

      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(
            withMutationCache({
              onSuccess: () => order.push('global onSuccess'),
              onSettled: () => order.push('global onSettled'),
            }),
          ),
        ],
      })

      const m = setup<string, Error, string>(() => ({
        mutationFn: (title) => of(title),
        onSuccess: () => order.push('own onSuccess'),
        onSettled: () => order.push('own onSettled'),
      }))

      m.mutate('b', {
        onSuccess: () => order.push('call onSuccess'),
        onSettled: () => order.push('call onSettled'),
      })

      expect(order).toEqual([
        'global onSuccess',
        'own onSuccess',
        'global onSettled',
        'own onSettled',
        'call onSuccess',
        'call onSettled',
      ])
    })

    it("runs a default hook and the call's callback of the same name: the call's replaces nothing", () => {
      const order: string[] = []

      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(
            withDefaultOptions({
              mutations: { onSuccess: () => order.push('default onSuccess') },
            }),
          ),
        ],
      })

      const m = setup<string, Error, string>(() => ({
        mutationFn: (title) => of(title),
      }))

      m.mutate('b', { onSuccess: () => order.push('call onSuccess') })

      expect(order).toEqual(['default onSuccess', 'call onSuccess'])
    })

    it("keeps the onSuccess of a definition and runs the call's after it, as a dialog that closes itself does", fakeAsync(() => {
      const invalidate = spyOn(client, 'invalidateQueries').and.resolveTo()
      const close = jasmine.createSpy('close')
      // A definition that a service returns, keeping the list in step with
      // the server.
      const update = mutationOptions({
        mutationFn: (change: { id: number; name: string }) => of(change),
        onSuccess: (_data, { id }) =>
          client.invalidateQueries({ queryKey: ['connections', id] }),
      })
      const m = TestBed.runInInjectionContext(() =>
        injectMutation(() => update),
      )

      m.mutate({ id: 7, name: 'VPN' }, { onSuccess: () => close() })

      // The run waits for the promise the definition's onSuccess returns.
      expect(invalidate).toHaveBeenCalledOnceWith({
        queryKey: ['connections', 7],
      })
      expect(close).not.toHaveBeenCalled()

      flushMicrotasks()

      expect(close).toHaveBeenCalledTimes(1)
    }))

    it('shows how the run went in the signals by the time they run', () => {
      const seen: unknown[] = []
      const saved = setup<string, Error, string>(() => ({
        mutationFn: (title) => of(title),
      }))
      const failed = setup<string, Error, string>(() => ({
        mutationFn: () => throwError(() => new Error('down')),
      }))

      saved.mutate('milk', {
        onSuccess: () =>
          seen.push([saved.status(), saved.data(), saved.isPending()]),
      })
      failed.mutate('milk', {
        onError: () =>
          seen.push([
            failed.status(),
            failed.error()?.message,
            failed.isPending(),
          ]),
      })

      expect(seen).toEqual([
        ['success', 'milk', false],
        ['error', 'down', false],
      ])
    })

    it('calls them before the promise of mutateAsync() settles, whichever way it goes', fakeAsync(() => {
      const order: string[] = []
      const saved = setup<string, Error, string>(() => ({
        mutationFn: (title) => of(title),
      }))
      const failed = setup<string, Error, string>(() => ({
        mutationFn: () => throwError(() => new Error('down')),
      }))

      void saved
        .mutateAsync('milk', {
          onSuccess: () => order.push('onSuccess'),
          onSettled: () => order.push('onSettled'),
        })
        .then(() => order.push('resolved'))
      void failed
        .mutateAsync('milk', {
          onError: () => order.push('onError'),
          onSettled: () => order.push('onSettled'),
        })
        .catch(() => order.push('rejected'))
      flushMicrotasks()

      expect(order).toEqual([
        'onSuccess',
        'onSettled',
        'onError',
        'onSettled',
        'resolved',
        'rejected',
      ])
    }))

    // With zone.js, change detection follows what runs in the Angular zone.
    // The call's callbacks run where its hooks do, so what they start updates
    // the page too: here a timer, on a plain field rather than a signal.
    it("runs them in the Angular zone, so a message the call's onSuccess shows can hide itself on a timer", fakeAsync(() => {
      @Component({
        template: `
          <button (click)="save()">Save</button>
          <p>{{ message }}</p>
        `,
      })
      class SaveTodo {
        message = ''

        readonly saving = injectMutation(() => ({
          mutationFn: () =>
            new Promise<string>((resolve) =>
              setTimeout(() => resolve('saved'), 100),
            ),
        }))

        save(): void {
          this.saving.mutate(undefined, {
            onSuccess: () => {
              this.message = 'Saved'
              setTimeout(() => (this.message = ''), 3000)
            },
          })
        }
      }

      const fixture = TestBed.createComponent(SaveTodo)
      const message = (): string =>
        fixture.nativeElement.querySelector('p').textContent.trim()

      fixture.autoDetectChanges()
      fixture.nativeElement.querySelector('button').click()

      tick(100)
      expect(message()).toBe('Saved')

      tick(3000)
      expect(message()).toBe('')
    }))

    // Two rows removed quickly, one mutation for the list: each call gets its
    // own callbacks. The signals show only the latest call, but both writes
    // happened, and one of them may have failed.
    it('calls the callbacks of every call, each with its own outcome, though a later call came before an earlier one landed', () => {
      const responses: Array<Subject<string>> = []
      const outcomes: string[] = []
      const m = setup<string, Error, string>(() => ({
        mutationFn: () => {
          const response = new Subject<string>()

          responses.push(response)

          return response
        },
      }))
      const callbacks = {
        onSuccess: (data: string, id: string) =>
          outcomes.push(`${id} removed: ${data}`),
        onError: (error: Error, id: string) =>
          outcomes.push(`${id} failed: ${error.message}`),
      }

      m.mutate('a', callbacks)
      m.mutate('b', callbacks)
      // The later call lands first, then the earlier one fails.
      responses[1].next('ok')
      responses[1].complete()
      responses[0].error(new Error('locked'))

      expect(outcomes).toEqual(['b removed: ok', 'a failed: locked'])
      expect(m.variables()).toBe('b')
      expect(m.isSuccess()).toBe(true)
    })

    it('calls them for a run that reset() forgot, since its write still happened', () => {
      const response = new Subject<string>()
      const onSuccess = jasmine.createSpy('onSuccess')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => response,
      }))

      m.mutate(undefined, { onSuccess })
      m.reset()
      response.next('saved')
      response.complete()

      expect(onSuccess).toHaveBeenCalledOnceWith('saved', undefined, undefined)
      // The signals don't bring the forgotten run back.
      expect(m.isIdle()).toBe(true)
    })

    it('calls them for a run that clear() forgot', () => {
      const response = new Subject<string>()
      const onSuccess = jasmine.createSpy('onSuccess')
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => response,
      }))

      m.mutate(undefined, { onSuccess })
      client.clear()
      response.next('saved')
      response.complete()

      expect(onSuccess).toHaveBeenCalledOnceWith('saved', undefined, undefined)
    })

    it("doesn't call them once the host is destroyed, while the mutation's own hooks still run and mutateAsync() settles", fakeAsync(() => {
      const responses: Array<Subject<string>> = []
      const ownOnSuccess = jasmine.createSpy('own onSuccess')
      const onSuccess = jasmine.createSpy('onSuccess')
      const onSettled = jasmine.createSpy('onSettled')

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationFn: () => {
            const response = new Subject<string>()

            responses.push(response)

            return response
          },
          onSuccess: ownOnSuccess,
        }))
      }

      const fixture = TestBed.createComponent(Host)
      const { save } = fixture.componentInstance

      fixture.detectChanges()
      // This one lands while the host is there.
      save.mutate('a', { onSuccess, onSettled })
      responses[0].next('saved a')
      responses[0].complete()

      // This one is in flight when the host goes.
      const result = settled(save.mutateAsync('b', { onSuccess, onSettled }))

      fixture.destroy()
      responses[1].next('saved b')
      responses[1].complete()
      flushMicrotasks()

      expect(ownOnSuccess).toHaveBeenCalledTimes(2)
      expect(onSuccess).toHaveBeenCalledOnceWith('saved a', 'a', undefined)
      expect(onSettled).toHaveBeenCalledOnceWith(
        'saved a',
        null,
        'a',
        undefined,
      )
      expect(result.value).toBe('saved b')
    }))

    it("doesn't call them for a mutate() after the host is destroyed, while the write is sent and its hooks run", () => {
      const sent: string[] = []
      const ownOnSuccess = jasmine.createSpy('own onSuccess')
      const onSuccess = jasmine.createSpy('onSuccess')

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation(() => ({
          mutationFn: (title: string) => {
            sent.push(title)

            return of(title)
          },
          onSuccess: ownOnSuccess,
        }))
      }

      const fixture = TestBed.createComponent(Host)
      const { save } = fixture.componentInstance

      fixture.detectChanges()
      save.mutate('a', { onSuccess })
      fixture.destroy()
      // Say from a timer, or the next step of a promise chain.
      save.mutate('b', { onSuccess })

      expect(sent).toEqual(['a', 'b'])
      expect(ownOnSuccess).toHaveBeenCalledTimes(2)
      expect(onSuccess).toHaveBeenCalledOnceWith('a', 'a', undefined)
    })

    // A dialog closed with Escape while the definition's onSuccess waits for
    // the list to refetch: the run is done once the refetch is, and by then
    // the dialog is gone.
    it("doesn't call them when the host is destroyed while the mutation's own hooks run", fakeAsync(() => {
      const refetch = deferred<void>()
      const ownOnSettled = jasmine.createSpy('own onSettled')
      const onSuccess = jasmine.createSpy('onSuccess')
      const onSettled = jasmine.createSpy('onSettled')

      @Component({ template: '' })
      class Dialog {
        readonly save = injectMutation(() => ({
          mutationFn: (title: string) => of(title),
          onSuccess: () => refetch.promise,
          onSettled: ownOnSettled,
        }))
      }

      const fixture = TestBed.createComponent(Dialog)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate('milk', { onSuccess, onSettled })
      fixture.destroy()
      refetch.resolve()
      flushMicrotasks()

      expect(ownOnSettled).toHaveBeenCalledTimes(1)
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onSettled).not.toHaveBeenCalled()
    }))

    // Whether the host is still there is decided once the run lands, for all
    // the callbacks of the call: a dialog that closes itself in onSuccess
    // still gets its onSettled.
    it("calls the call's onSettled too when its onSuccess destroys the host", () => {
      const onSettled = jasmine.createSpy('onSettled')

      @Component({ template: '' })
      class Dialog {
        readonly save = injectMutation(() => ({
          mutationFn: (title: string) => of(title),
        }))
      }

      const fixture = TestBed.createComponent(Dialog)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate('milk', {
        onSuccess: () => fixture.destroy(),
        onSettled,
      })

      expect(onSettled).toHaveBeenCalledOnceWith(
        'milk',
        null,
        'milk',
        undefined,
      )
    })

    // The host of a mutation is where injectMutation() ran. A component that
    // calls mutate() on a mutation a service holds doesn't own it: the
    // callbacks run as long as the service is there.
    it('calls them as long as the host of the mutation is there, wherever mutate() was called from', () => {
      const response = new Subject<string>()
      const onSuccess = jasmine.createSpy('onSuccess')

      @Injectable({ providedIn: 'root' })
      class TodoSaver {
        readonly save = injectMutation<string, Error, string>(() => ({
          mutationFn: () => response,
        }))
      }

      @Component({ template: '' })
      class Dialog {
        readonly #saver = inject(TodoSaver)

        submit(): void {
          this.#saver.save.mutate('Buy milk', { onSuccess })
        }
      }

      const fixture = TestBed.createComponent(Dialog)

      fixture.componentInstance.submit()
      fixture.destroy()
      response.next('saved')
      response.complete()

      expect(onSuccess).toHaveBeenCalledOnceWith('saved', 'Buy milk', undefined)
    })

    it('reports an error a callback throws to the ErrorHandler, once, and changes nothing else', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('dialog gone')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, string>(() => ({
        mutationFn: (title) => of(title),
      }))
      const result = settled(
        m.mutateAsync('milk', {
          onSuccess: () => {
            throw error
          },
          onSettled,
        }),
      )

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
      // The next callback still runs, and the outcome stands.
      expect(onSettled).toHaveBeenCalledOnceWith(
        'milk',
        null,
        'milk',
        undefined,
      )
      expect(m.isSuccess()).toBe(true)
      expect(result.value).toBe('milk')
    }))

    it("reports an error the call's onError throws, still calls onSettled, and rejects with the write's error", fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const writeError = new Error('down')
      const messageError = new Error('no message bar')
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, string>(() => ({
        mutationFn: () => throwError(() => writeError),
      }))
      const result = settled(
        m.mutateAsync('milk', {
          onError: () => {
            throw messageError
          },
          onSettled,
        }),
      )

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(messageError)
      expect(onSettled).toHaveBeenCalledOnceWith(
        undefined,
        writeError,
        'milk',
        undefined,
      )
      expect(m.error()).toBe(writeError)
      expect(result.error).toBe(writeError)
    }))

    it("settles the run and lets the app settle when the call's onSettled throws", fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('cleanup failed')
      const response = new Subject<string>()
      const m = setup<string, Error, void>(() => ({
        mutationFn: () => response,
      }))
      const result = settled(
        m.mutateAsync(undefined, {
          onSettled: () => {
            throw error
          },
        }),
      )

      response.next('saved')
      response.complete()

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
      expect(result.value).toBe('saved')
      expect(appIsStable()).toBe(true)
    }))

    // A callback is the component's reaction, such as a navigation: the run
    // doesn't wait for a promise one returns.
    it("doesn't wait for a promise a callback returns: the run is done and mutateAsync() resolves meanwhile", fakeAsync(() => {
      const navigation = deferred<boolean>()
      const onSuccess = jasmine
        .createSpy('onSuccess')
        .and.returnValue(navigation.promise)
      const onSettled = jasmine.createSpy('onSettled')
      const m = setup<string, Error, string>(() => ({
        mutationFn: (title) => of(title),
      }))
      const result = settled(m.mutateAsync('milk', { onSuccess, onSettled }))

      flushMicrotasks()

      expect(onSuccess).toHaveBeenCalledTimes(1)
      // onSettled doesn't wait for it either.
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(result.value).toBe('milk')
      expect(m.isPending()).toBe(false)
      expect(appIsStable()).toBe(true)

      navigation.resolve(true)
    }))

    it('reports to the ErrorHandler a promise a callback returns that rejects', fakeAsync(() => {
      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const error = new Error('navigation failed')
      const m = setup<string, Error, string>(() => ({
        mutationFn: (title) => of(title),
      }))

      m.mutate('milk', { onSuccess: () => Promise.reject(error) })

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
    }))

    it("doesn't make an effect that calls mutate() depend on what the call's callbacks read", () => {
      const draft = signal('a')
      const locale = signal('en')
      const onSuccess = jasmine
        .createSpy('onSuccess')
        .and.callFake(() => locale())
      let runs = 0

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation(() => ({
          mutationFn: (title: string) => of(title),
        }))

        constructor() {
          effect(() => {
            runs++

            if (runs > 20) return

            this.save.mutate(draft(), { onSuccess })
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      locale.set('nl')
      fixture.detectChanges()

      expect(onSuccess).toHaveBeenCalledTimes(1)
      // Only a new draft is a reason to save.
      expect(runs).toBe(1)
    })
  })

  describe('options', () => {
    it('re-reads the options on every mutate()', () => {
      const first = jasmine.createSpy('first').and.returnValue(of(1))
      const second = jasmine.createSpy('second').and.returnValue(of(2))
      let currentFn = first

      const m = setup<number, Error, void>(() => ({
        mutationFn: () => currentFn(),
      }))

      m.mutate()

      expect(first).toHaveBeenCalledTimes(1)

      currentFn = second
      m.mutate()

      expect(second).toHaveBeenCalledTimes(1)
      expect(m.data()).toBe(2)
    })

    // The options function runs on every call, so it can throw then: say it
    // reads the todo that's selected, and none is. Both calls throw its error
    // before they change anything: the run before stays the one the mutation
    // shows, and stays in the cache.
    it('throws what the options function throws from mutate() and mutateAsync(), and sends nothing', () => {
      const rename = jasmine.createSpy('rename').and.returnValue(of('saved'))
      const todo = signal<{ id: number } | null>(null)
      const noTodo = new Error('No todo selected')
      const m = setup<string, Error, string>(() => {
        const selected = todo()

        if (!selected) throw noTodo

        return { mutationFn: (title) => rename(selected.id, title) }
      })

      expect(() => m.mutate('Buy milk')).toThrow(noTodo)
      expect(() => m.mutateAsync('Buy milk')).toThrow(noTodo)
      expect(rename).not.toHaveBeenCalled()
      expect(m.isIdle()).toBe(true)
      expect(client.getMutationCache().getAll().length).toBe(0)
    })

    it('keeps the run in flight when the options throw, and shows how it went once it lands', () => {
      const response = new Subject<string>()
      const rename = jasmine.createSpy('rename').and.returnValue(response)
      const todo = signal<{ id: number } | null>({ id: 1 })
      const m = setup<string, Error, string>(() => {
        const id = todo()!.id

        return { mutationFn: (title) => rename(id, title) }
      })
      const cache = client.getMutationCache()

      m.mutate('Buy milk')

      const [inFlight] = cache.getAll()

      todo.set(null)

      expect(() => m.mutate('Buy bread')).toThrowError(TypeError)
      expect(() => m.mutateAsync('Buy bread')).toThrowError(TypeError)

      response.next('saved')
      response.complete()

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe('saved')
      expect(rename).toHaveBeenCalledOnceWith(1, 'Buy milk')
      // It's still the run the mutation shows, so it stays in the cache.
      expect(cache.getAll()).toEqual([inFlight])
    })

    it('keeps a settled run when the options throw, until its host is destroyed', () => {
      const todo = signal<{ id: number } | null>({ id: 1 })

      @Component({ template: '' })
      class Host {
        readonly rename = injectMutation(() => {
          const id = todo()!.id

          return { mutationFn: (title: string) => of(`${id}: ${title}`) }
        })
      }

      const fixture: ComponentFixture<Host> = TestBed.createComponent(Host)
      const { rename } = fixture.componentInstance
      const cache = client.getMutationCache()

      fixture.detectChanges()
      rename.mutate('Buy milk')

      const [run] = cache.getAll()

      todo.set(null)

      expect(() => rename.mutate('Buy bread')).toThrowError(TypeError)
      expect(rename.data()).toBe('1: Buy milk')
      expect(cache.getAll()).toEqual([run])

      fixture.destroy()

      expect(cache.getAll().length).toBe(0)
    })
  })

  // withDefaultOptions({ mutations }) fills in what a mutation leaves unset,
  // field by field. Its hooks run in the injection context of the injector
  // that provides the client.
  describe('default options', () => {
    const REPORTS = new InjectionToken<unknown[]>('REPORTS')

    // Provides a client with these defaults, and a list the default hooks can
    // report to through inject(REPORTS). Returns that list.
    function provideDefaults(defaultOptions: DefaultOptions): unknown[] {
      const reports: unknown[] = []

      TestBed.resetTestingModule()
      TestBed.configureTestingModule({
        providers: [
          provideQueryClient(withDefaultOptions(defaultOptions)),
          { provide: REPORTS, useValue: reports },
        ],
      })

      return reports
    }

    it('runs the default onError and onSettled when the mutation has none, with its variables and context', () => {
      const error = new Error('boom')
      const onError = jasmine.createSpy('onError')
      const onSettled = jasmine.createSpy('onSettled')

      provideDefaults({ mutations: { onError, onSettled } })

      const m = setup<string, Error, string, { previous: string[] }>(() => ({
        mutationFn: () => throwError(() => error),
        onMutate: () => ({ previous: ['a'] }),
      }))

      m.mutate('b')

      expect(onError).toHaveBeenCalledOnceWith(error, 'b', { previous: ['a'] })
      expect(onSettled).toHaveBeenCalledOnceWith(undefined, error, 'b', {
        previous: ['a'],
      })
    })

    it('runs the default onSuccess and onSettled when the mutation has none', () => {
      const onSuccess = jasmine.createSpy('onSuccess')
      const onSettled = jasmine.createSpy('onSettled')

      provideDefaults({ mutations: { onSuccess, onSettled } })

      const m = setup(() => ({
        mutationFn: (title: string) => of(`${title} saved`),
      }))

      m.mutate('b')

      expect(onSuccess).toHaveBeenCalledOnceWith('b saved', 'b', undefined)
      expect(onSettled).toHaveBeenCalledOnceWith(
        'b saved',
        null,
        'b',
        undefined,
      )
    })

    it("replaces a default hook with the mutation's own", () => {
      const defaultOnError = jasmine.createSpy('default onError')
      const onError = jasmine.createSpy('onError')

      provideDefaults({ mutations: { onError: defaultOnError } })

      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => new Error('boom')),
        // Handles the error itself, e.g. rolls back an optimistic update.
        onError,
      }))

      m.mutate()

      expect(onError).toHaveBeenCalledTimes(1)
      expect(defaultOnError).not.toHaveBeenCalled()
    })

    it("replaces hooks one by one: the mutation's own onSuccess keeps the default onError", () => {
      const error = new Error('boom')
      const defaultOnError = jasmine.createSpy('default onError')

      provideDefaults({ mutations: { onError: defaultOnError } })

      const m = setup<string, Error, void>(() => ({
        mutationFn: () => throwError(() => error),
        onSuccess: jasmine.createSpy('onSuccess'),
      }))

      m.mutate()

      expect(defaultOnError).toHaveBeenCalledOnceWith(
        error,
        undefined,
        undefined,
      )
    })

    it('treats a hook set to undefined as not set', () => {
      const defaultOnError = jasmine.createSpy('default onError')

      provideDefaults({ mutations: { onError: defaultOnError } })

      // A shared definition that passes an optional hook on, used here
      // without one.
      const saveTodo = (onError?: (error: Error) => void) =>
        mutationOptions({
          mutationFn: () => throwError(() => new Error('boom')),
          onError,
        })
      const m = setup(() => saveTodo())

      m.mutate()

      expect(defaultOnError).toHaveBeenCalledTimes(1)
    })

    it('stays pending until an async default hook resolves', fakeAsync(() => {
      const report = deferred()

      provideDefaults({ mutations: { onSuccess: () => report.promise } })

      const m = setup(() => ({ mutationFn: () => of('saved') }))

      m.mutate()
      flushMicrotasks()

      expect(m.isPending()).toBe(true)

      report.resolve()
      flushMicrotasks()

      expect(m.isSuccess()).toBe(true)
    }))

    it("reports a failing default hook's error to the app's ErrorHandler", fakeAsync(() => {
      const error = new Error('report failed')

      provideDefaults({
        mutations: {
          onSettled: () => {
            throw error
          },
        },
      })

      const handleError = spyOn(TestBed.inject(ErrorHandler), 'handleError')
      const m = setup(() => ({ mutationFn: () => of('saved') }))

      m.mutate()

      expect(() => flush()).not.toThrow()
      expect(handleError).toHaveBeenCalledOnceWith(error)
      expect(m.isSuccess()).toBe(true)
    }))

    it('retries with the default retry and retryDelay', fakeAsync(() => {
      let attempts = 0

      provideDefaults({ mutations: { retry: 1, retryDelay: 50 } })

      const m = setup(() => ({
        mutationFn: () => {
          attempts++

          return throwError(() => new Error('fail'))
        },
      }))

      m.mutate()
      tick(49)

      expect(attempts).toBe(1)

      tick(1)

      expect(attempts).toBe(2)
      expect(m.isError()).toBe(true)
    }))

    it("lets the mutation's own retry override the default, 0 included", fakeAsync(() => {
      let attempts = 0

      provideDefaults({ mutations: { retry: 2, retryDelay: 10 } })

      const m = setup(() => ({
        mutationFn: () => {
          attempts++

          return throwError(() => new Error('fail'))
        },
        // This write isn't safe to send twice.
        retry: 0,
      }))

      m.mutate()
      tick(100)

      expect(attempts).toBe(1)
      expect(m.isError()).toBe(true)
    }))

    it('ignores the query defaults', fakeAsync(() => {
      let attempts = 0

      provideDefaults({ queries: { retry: 3, retryDelay: 10 } })

      const m = setup(() => ({
        mutationFn: () => {
          attempts++

          return throwError(() => new Error('fail'))
        },
      }))

      m.mutate()
      // Past three retries at the default retryDelay, 1 s, 2 s and 4 s apart.
      tick(10_000)

      expect(attempts).toBe(1)
    }))

    it('runs each default hook in an injection context', fakeAsync(() => {
      const reports = provideDefaults({
        mutations: {
          onSuccess: () => inject(REPORTS).push('success'),
          onError: () => inject(REPORTS).push('error'),
          onSettled: () => inject(REPORTS).push('settled'),
        },
      })
      const save = setup(() => ({ mutationFn: () => of('saved') }))
      const remove = setup(() => ({
        mutationFn: () => throwError(() => new Error('boom')),
      }))

      save.mutate()
      remove.mutate()
      flush()

      expect(reports).toEqual(['success', 'settled', 'error', 'settled'])
    }))

    it('resolves inject() from the injector that provides the client, not the component that started the run', fakeAsync(() => {
      const response = new Subject<string>()
      const hostReports: unknown[] = []
      const reports = provideDefaults({
        mutations: { onSuccess: (saved) => inject(REPORTS).push(saved) },
      })

      @Component({
        template: '',
        providers: [{ provide: REPORTS, useValue: hostReports }],
      })
      class Host {
        readonly save = injectMutation(() => ({ mutationFn: () => response }))
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate()
      // The user leaves the page before the save lands.
      fixture.destroy()
      response.next('saved')
      response.complete()
      flush()

      expect(reports).toEqual(['saved'])
      expect(hostReports).toEqual([])
    }))

    it('skips the default hooks once that injector is destroyed', fakeAsync(() => {
      const response = new Subject<string>()
      const onSuccess = jasmine.createSpy('onSuccess')

      provideDefaults({ mutations: { onSuccess } })

      const m = setup(() => ({ mutationFn: () => response }))

      m.mutate()
      // The test ends, or the app is destroyed, while the save is in flight.
      TestBed.resetTestingModule()
      response.next('saved')
      response.complete()

      expect(() => flush()).not.toThrow()
      expect(onSuccess).not.toHaveBeenCalled()
      expect(m.isSuccess()).toBe(true)
    }))

    // Angular counts that injector destroyed as soon as it starts tearing the
    // app down, after each server render say, and destroys the components
    // after that. A mutation one of them starts as it goes, with a write that
    // answers at once, lands in between.
    it('skips the default hooks for a mutation its component starts as the whole app is torn down', fakeAsync(() => {
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(of('saved'))
      const onSuccess = jasmine.createSpy('default onSuccess')
      const onSettled = jasmine.createSpy('default onSettled')

      @Component({ selector: 'nsq-draft-editor', template: '' })
      class DraftEditor {
        readonly saveDraft = injectMutation<string, Error, string>(() => ({
          mutationFn,
        }))

        constructor() {
          // Saves the draft on leave.
          inject(DestroyRef).onDestroy(() => this.saveDraft.mutate('milk'))
        }
      }

      const host = document.body.appendChild(
        document.createElement('nsq-draft-editor'),
      )
      let app!: ApplicationRef

      void createApplication({
        providers: [
          provideZonelessChangeDetection(),
          provideQueryClient(
            withDefaultOptions({ mutations: { onSuccess, onSettled } }),
          ),
        ],
      }).then((created) => (app = created))
      flushMicrotasks()
      app.bootstrap(DraftEditor, host)
      app.destroy()

      expect(() => flush()).not.toThrow()
      expect(mutationFn).toHaveBeenCalledOnceWith('milk')
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onSettled).not.toHaveBeenCalled()

      host.remove()
    }))

    // A client provided below the app's injector, by a route say, outlives
    // the app: the router never destroys that injector. Its defaults belong
    // to the app all the same.
    it('skips the default hooks of a client provided below the app once the app is torn down', fakeAsync(() => {
      const response = new Subject<string>()
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.returnValue(response)
      const onSuccess = jasmine.createSpy('default onSuccess')
      const onSettled = jasmine.createSpy('default onSettled')

      @Component({ selector: 'nsq-draft-editor', template: '' })
      class DraftEditor {
        readonly saveDraft = injectMutation<string, Error, string>(() => ({
          mutationFn,
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
        [
          provideQueryClient(
            withDefaultOptions({ mutations: { onSuccess, onSettled } }),
          ),
        ],
        app.injector,
      )
      const editor = createComponent(DraftEditor, {
        environmentInjector: route,
        hostElement: host,
      })

      app.attachView(editor.hostView)
      editor.instance.saveDraft.mutate('milk')
      // The app is torn down while the save is in flight.
      app.destroy()
      response.next('saved')
      response.complete()

      expect(() => flush()).not.toThrow()
      expect(mutationFn).toHaveBeenCalledOnceWith('milk')
      expect(onSuccess).not.toHaveBeenCalled()
      expect(onSettled).not.toHaveBeenCalled()

      // The router never destroys it; the spec does, to leave nothing behind.
      route.destroy()
      host.remove()
    }))
  })

  // An effect that mutates or resets should depend only on what it reads
  // itself, not on what mutate() or reset() read to do their job.
  describe('called in an effect', () => {
    // Mounts a component whose effect saves `draft()` as it changes, as an
    // auto-save does, with `call`. Stopped after 20 runs, so a loop fails the
    // expectations rather than change detection.
    function autoSave<TContext>(
      draft: Signal<string>,
      optionsFn: () => MutationOptions<string, Error, string, TContext>,
      call: 'mutate' | 'mutateAsync' = 'mutate',
    ): ComponentFixture<unknown> {
      let runs = 0

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation(optionsFn)

        constructor() {
          effect(() => {
            runs++

            if (runs > 20) return

            void this.save[call](draft())
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()

      return fixture
    }

    it('saves once per change with an optimistic update', () => {
      const draft = signal('a')
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.callFake((title: string) => of(title))

      client.setQueryData<string[]>(['todos'], [])

      const fixture = autoSave(draft, () => ({
        mutationFn,
        onMutate: (title) => {
          const prev = client.getQueryData<string[]>(['todos']) ?? []

          client.setQueryData(['todos'], [...prev, title])

          return { prev }
        },
      }))

      expect(mutationFn).toHaveBeenCalledTimes(1)

      draft.set('b')
      fixture.detectChanges()

      expect(mutationFn).toHaveBeenCalledTimes(2)
      expect(client.getQueryData(['todos'])).toEqual(['a', 'b'])
    })

    it("mutate() doesn't track what the options, onMutate or mutationFn read", () => {
      const draft = signal('a')
      const retries = signal(0)
      const locale = signal('en')
      const noteId = signal(1)
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.callFake((title: string) => of(`${noteId()}: ${title}`))

      const fixture = autoSave(draft, () => ({
        mutationFn,
        retry: retries(),
        onMutate: () => locale(),
      }))

      retries.set(1)
      locale.set('nl')
      noteId.set(2)
      fixture.detectChanges()

      // Only a new draft is a reason to save.
      expect(mutationFn).toHaveBeenCalledTimes(1)
    })

    it("mutateAsync() doesn't track what the options or mutationFn read", () => {
      const draft = signal('a')
      const retries = signal(0)
      const noteId = signal(1)
      const mutationFn = jasmine
        .createSpy('mutationFn')
        .and.callFake((title: string) => of(`${noteId()}: ${title}`))

      const fixture = autoSave(
        draft,
        () => ({ mutationFn, retry: retries() }),
        'mutateAsync',
      )

      retries.set(1)
      noteId.set(2)
      fixture.detectChanges()

      // Only a new draft is a reason to save.
      expect(mutationFn).toHaveBeenCalledTimes(1)
    })

    it('saves each change once while an earlier save is in flight', () => {
      const draft = signal('a')
      const saves: Array<Subject<string>> = []
      const mutationFn = jasmine
        .createSpy<(title: string) => Subject<string>>('mutationFn')
        .and.callFake(() => {
          const save = new Subject<string>()

          saves.push(save)

          return save
        })
      const fixture = autoSave(draft, () => ({ mutationFn }))

      // Typed on before the first save landed, as fast typing does.
      draft.set('ab')
      fixture.detectChanges()

      // The first save lands while the second is in flight, then the second.
      for (const save of saves.slice(0, 2)) {
        save.next('saved')
        save.complete()
        fixture.detectChanges()
      }

      expect(mutationFn.calls.allArgs()).toEqual([['a'], ['ab']])
    })

    it("reset() doesn't re-run the effect when the forgotten save lands", () => {
      const open = signal(true)
      const response = new Subject<string>()
      let runs = 0

      @Component({ template: '' })
      class Host {
        readonly save = injectMutation(() => ({ mutationFn: () => response }))

        constructor() {
          // Clears what the save left behind once the form closes.
          effect(() => {
            runs++

            if (!open()) this.save.reset()
          })
        }
      }

      const fixture = TestBed.createComponent(Host)

      fixture.detectChanges()
      fixture.componentInstance.save.mutate()
      open.set(false)
      fixture.detectChanges()

      response.next('saved')
      response.complete()
      fixture.detectChanges()

      // Once on mount, once for the close.
      expect(runs).toBe(2)
    })
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      expect(() =>
        injectMutation(() => ({ mutationFn: () => of(1) })),
      ).toThrowError(/NG0203|injection context/)
    })

    it('works outside an injection context when given an injector', () => {
      const injector = TestBed.inject(Injector)
      const m = injectMutation<number, Error, number>(
        () => ({ mutationFn: (v) => of(v) }),
        { injector },
      )

      m.mutate(42)

      expect(m.isSuccess()).toBe(true)
      expect(m.data()).toBe(42)
    })
  })
})
