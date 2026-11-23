import { Injector, type Signal, signal } from '@angular/core'
import {
  TestBed,
  fakeAsync,
  flushMicrotasks,
  tick,
} from '@angular/core/testing'
import { of, Subject } from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import { injectIsMutating } from './inject-is-mutating'
import { injectMutation } from './inject-mutation'
import type { MutationKey } from './mutation'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

describe('injectIsMutating', () => {
  let client: QueryClient
  let injector: Injector

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
    injector = TestBed.inject(Injector)
  })

  it('is 0 when nothing is mutating', () => {
    const isMutating = TestBed.runInInjectionContext(() => injectIsMutating())

    expect(isMutating()).toBe(0)
  })

  it('reactively tracks a mutation through its lifecycle', fakeAsync(() => {
    const subject = new Subject<number>()

    TestBed.runInInjectionContext(() => {
      const isMutating = injectIsMutating()
      const m = injectMutation<number, Error, void>(() => ({
        mutationFn: () => subject,
      }))

      expect(isMutating()).toBe(0)

      m.mutate()
      expect(isMutating()).toBe(1)

      subject.next(1)
      subject.complete()
      tick()

      expect(isMutating()).toBe(0)
    })
  }))

  it('keeps counting a mutation until its hooks are done', fakeAsync(() => {
    let finishAudit!: () => void
    const audit = new Promise<void>((resolve) => {
      finishAudit = resolve
    })

    TestBed.runInInjectionContext(() => {
      const isMutating = injectIsMutating()
      const m = injectMutation(() => ({
        mutationFn: () => of('saved'),
        onSuccess: () => audit,
      }))

      m.mutate()
      flushMicrotasks()

      // The write landed, but its onSuccess is still running.
      expect(isMutating()).toBe(1)

      finishAudit()
      flushMicrotasks()

      expect(isMutating()).toBe(0)
    })
  }))

  it('counts multiple concurrent mutations', () => {
    TestBed.runInInjectionContext(() => {
      const isMutating = injectIsMutating()
      const a = injectMutation<number, Error, void>(() => ({
        mutationFn: () => new Subject<number>(),
      }))
      const b = injectMutation<number, Error, void>(() => ({
        mutationFn: () => new Subject<number>(),
      }))

      a.mutate()
      b.mutate()

      expect(isMutating()).toBe(2)
    })
  })

  it('drops to 0 once clear() forgets the runs, and counts the ones after it', () => {
    TestBed.runInInjectionContext(() => {
      const isMutating = injectIsMutating()
      const m = injectMutation<number, Error, void>(() => ({
        mutationFn: () => new Subject<number>(),
      }))

      m.mutate()
      expect(isMutating()).toBe(1)

      client.clear()

      // The run goes on, and its component still shows it, but it has left
      // the cache.
      expect(isMutating()).toBe(0)
      expect(m.isPending()).toBe(true)

      m.mutate()
      expect(isMutating()).toBe(1)
    })
  })

  describe('filters', () => {
    // A mutation whose writes stay in flight.
    function saving(mutationKey?: MutationKey) {
      return injectMutation<number, Error, void>(() => ({
        mutationKey,
        mutationFn: () => new Subject<number>(),
      }))
    }

    it('counts only the pending runs whose key matches', () => {
      TestBed.runInInjectionContext(() => {
        const todos = injectIsMutating(() => ({ mutationKey: ['todos'] }))
        const exactly = injectIsMutating(() => ({
          mutationKey: ['todos'],
          exact: true,
        }))
        const all = injectIsMutating()

        saving(['todos', 'update']).mutate()
        saving(['todos']).mutate()
        saving(['users', 'update']).mutate()
        saving().mutate()

        expect(todos()).toBe(2)
        expect(exactly()).toBe(1)
        expect(all()).toBe(4)
      })
    })

    it('lets a component count the writes to its own todo, with an input in the key', () => {
      const rows = [1, 2].map((id) =>
        mountHost(
          (todoId: Signal<number>) =>
            injectIsMutating(() => ({
              mutationKey: ['todos', 'update', todoId()],
            })),
          id,
        ),
      )
      // A dialog somewhere else saves todo 1.
      const save = TestBed.runInInjectionContext(() =>
        saving(['todos', 'update', 1]),
      )

      save.mutate()

      expect(rows.map(({ created }) => created())).toEqual([1, 0])

      // The second row moves on to todo 1.
      rows[1].value.set(1)
      rows[1].fixture.detectChanges()

      expect(rows[1].created()).toBe(1)
    })

    // A run's key never changes, so a write of another kind can't come to
    // match: the count doesn't follow its state.
    it("doesn't count again when a run whose key doesn't match changes state", () => {
      TestBed.runInInjectionContext(() => {
        const filters = jasmine
          .createSpy('filters')
          .and.returnValue({ mutationKey: ['todos'] })
        const todos = injectIsMutating(filters)
        const write = new Subject<number>()
        // Held by its injectMutation, so the run stays in the cache once done.
        const users = injectMutation<number, Error, void>(() => ({
          mutationKey: ['users'],
          mutationFn: () => write,
        }))

        users.mutate()

        expect(todos()).toBe(0)

        const counted = filters.calls.count()

        write.next(1)
        write.complete()

        expect(users.isSuccess()).toBe(true)
        expect(todos()).toBe(0)
        expect(filters.calls.count()).toBe(counted)
      })
    })

    it('matches a run by the key its options gave when mutate() was called', () => {
      TestBed.runInInjectionContext(() => {
        const editing = signal(1)
        const save = injectMutation<number, Error, void>(() => ({
          mutationKey: ['todos', 'update', editing()],
          mutationFn: () => new Subject<number>(),
        }))
        const first = injectIsMutating(() => ({
          mutationKey: ['todos', 'update', 1],
        }))
        const second = injectIsMutating(() => ({
          mutationKey: ['todos', 'update', 2],
        }))

        save.mutate()
        editing.set(2)

        expect(first()).toBe(1)
        expect(second()).toBe(0)
      })
    })
  })

  describe('injection context', () => {
    it('throws when called outside an injection context', () => {
      expect(() => injectIsMutating()).toThrowError(/NG0203|injection context/)
    })

    it('takes the filters and an injector outside an injection context', () => {
      const todos = injectIsMutating(() => ({ mutationKey: ['todos'] }), {
        injector,
      })
      const all = injectIsMutating(undefined, { injector })

      for (const mutationKey of [
        ['todos', 'update'],
        ['users', 'update'],
      ]) {
        client
          .getMutationCache()
          .build<number, Error, void, unknown>({
            mutationKey,
            mutationFn: () => new Subject<number>(),
          })
          .execute()
      }

      expect(todos()).toBe(1)
      expect(all()).toBe(2)
    })

    it('works outside an injection context when given an injector', () => {
      const isMutating = injectIsMutating({ injector })

      expect(isMutating()).toBe(0)

      const mutation = client
        .getMutationCache()
        .build<number, Error, void, unknown>({
          mutationFn: () => new Subject<number>(),
        })

      mutation.execute()

      expect(isMutating()).toBe(1)
    })
  })
})
