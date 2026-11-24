import {
  ApplicationRef,
  Component,
  EnvironmentInjector,
  Injectable,
  Injector,
  type Signal,
  computed,
  createEnvironmentInjector,
  inject,
  signal,
} from '@angular/core'
import { TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing'
import { type Observable, of, Subject } from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import { injectMutation } from './inject-mutation'
import { injectMutationState } from './inject-mutation-state'
import { injectQuery } from './inject-query'
import type { MutationFilters, MutationKey } from './mutation'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'

type Todo = { id: number; title: string }

// Writes that stay in flight until the spec answers them, in any order:
// answer(i) or fail(i) settles the i-th one sent. TVariables only types the
// parameter of mutationFn: the writes ignore the variables.
function writes<TVariables>() {
  const responses: Array<Subject<string>> = []
  const mutationFn: (variables: TVariables) => Observable<string> = () => {
    const response = new Subject<string>()

    responses.push(response)

    return response
  }

  return {
    mutationFn,
    answer: (i: number): void => {
      responses[i].next('saved')
      responses[i].complete()
    },
    fail: (i: number): void => responses[i].error(new Error('failed')),
  }
}

// A mutation whose writes stay in flight.
function saving(mutationKey?: MutationKey) {
  return injectMutation<string, Error, void>(() => ({
    mutationKey,
    mutationFn: () => new Subject<string>(),
  }))
}

describe('injectMutationState', () => {
  let client: QueryClient
  let injector: Injector

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
    injector = TestBed.inject(Injector)
  })

  it('is empty while nothing has run', () => {
    const states = TestBed.runInInjectionContext(() => injectMutationState())

    expect(states()).toEqual([])
  })

  it("lists every run's state, in the order the runs started", () => {
    TestBed.runInInjectionContext(() => {
      const states = injectMutationState()
      const saves = writes<string>()
      const save = injectMutation(() => ({ mutationFn: saves.mutationFn }))
      const remove = injectMutation(() => ({
        mutationFn: (id: number) => of(id),
      }))

      remove.mutate(3)
      save.mutate('milk')

      expect(states()).toEqual([
        {
          status: 'success',
          data: 3,
          error: null,
          variables: 3,
          context: undefined,
          failureCount: 0,
          failureReason: null,
          submittedAt: jasmine.any(Number),
        },
        {
          status: 'pending',
          data: undefined,
          error: null,
          variables: 'milk',
          context: undefined,
          failureCount: 0,
          failureReason: null,
          submittedAt: jasmine.any(Number),
        },
      ])
    })
  })

  it('lists two writes in flight at once that one mutation started', () => {
    TestBed.runInInjectionContext(() => {
      const saves = writes<string>()
      const save = injectMutation(() => ({ mutationFn: saves.mutationFn }))
      const runs = injectMutationState(() => ({
        select: (mutation) => [mutation.state.variables, mutation.state.status],
      }))

      save.mutate('milk')
      save.mutate('bread')

      expect(runs()).toEqual([
        ['milk', 'pending'],
        ['bread', 'pending'],
      ])

      // The later write lands first, and the order stays.
      saves.answer(1)

      expect(runs()).toEqual([
        ['milk', 'pending'],
        ['bread', 'success'],
      ])
    })
  })

  it('lists a run once it starts, follows its state, and drops it on reset()', () => {
    TestBed.runInInjectionContext(() => {
      const saves = writes<string>()
      const save = injectMutation(() => ({ mutationFn: saves.mutationFn }))
      const statuses = injectMutationState(() => ({
        select: (mutation) => mutation.state.status,
      }))
      // Without select, the items are the states themselves.
      const states = injectMutationState()

      expect(statuses()).toEqual([])
      expect(states()).toEqual([])

      save.mutate('milk')

      expect(statuses()).toEqual(['pending'])
      expect(states()).toEqual([
        jasmine.objectContaining({ status: 'pending' }),
      ])

      saves.fail(0)

      expect(statuses()).toEqual(['error'])
      expect(states()).toEqual([jasmine.objectContaining({ status: 'error' })])

      save.reset()

      expect(statuses()).toEqual([])
      expect(states()).toEqual([])
    })
  })

  it('drops every run once clear() forgets them, and lists the ones after it', () => {
    TestBed.runInInjectionContext(() => {
      const saves = writes<string>()
      const save = injectMutation(() => ({ mutationFn: saves.mutationFn }))
      const variables = injectMutationState(() => ({
        select: (mutation) => mutation.state.variables,
      }))

      save.mutate('milk')
      client.clear()

      expect(variables()).toEqual([])

      save.mutate('bread')

      expect(variables()).toEqual(['bread'])
    })
  })

  it('lists the writes that other components and services start', () => {
    const adds = writes<string>()
    const deletes = writes<number>()

    @Injectable({ providedIn: 'root' })
    class TodoStore {
      readonly remove = injectMutation(() => ({
        mutationKey: ['todos', 'delete'],
        mutationFn: deletes.mutationFn,
      }))
    }

    @Component({ template: '' })
    class AddTodoDialog {
      readonly add = injectMutation(() => ({
        mutationKey: ['todos', 'add'],
        mutationFn: adds.mutationFn,
      }))
    }

    @Component({ template: '' })
    class TodoList {
      readonly writing = injectMutationState(() => ({
        filters: { mutationKey: ['todos'] },
        select: (mutation) => mutation.state.variables,
      }))
    }

    const list = TestBed.createComponent(TodoList)
    const dialog = TestBed.createComponent(AddTodoDialog)

    list.detectChanges()
    dialog.detectChanges()
    dialog.componentInstance.add.mutate('milk')
    TestBed.inject(TodoStore).remove.mutate(3)

    expect(list.componentInstance.writing()).toEqual(['milk', 3])
  })

  // Deletes that overlap, each of which refetches the list from its
  // onSuccess: the second refetch takes the place of the first, and both
  // deletes wait for it.
  it('keeps two overlapping deletes listed until the list without them lands', fakeAsync(() => {
    const deletes = writes<number>()
    // The list's latest request.
    let response = new Subject<number[]>()

    @Injectable({ providedIn: 'root' })
    class TodoStore {
      readonly remove = injectMutation(() => ({
        mutationKey: ['todos', 'delete'],
        mutationFn: deletes.mutationFn,
        // Returned, so the delete stays pending until the list is fresh.
        onSuccess: () =>
          this.#client.invalidateQueries({ queryKey: ['todos'] }),
      }))

      // Read once a delete has landed, long after construction.
      readonly #client = inject(QueryClient)
    }

    @Component({ template: '' })
    class TodoList {
      readonly todos = injectQuery(() => ({
        queryKey: ['todos'],
        queryFn: () => (response = new Subject<number[]>()),
      }))

      readonly deleting = injectMutationState(() => ({
        filters: { mutationKey: ['todos', 'delete'], status: 'pending' },
        select: (mutation) => mutation.state.variables as number,
      }))
    }

    // The answer may start the next request, which replaces `response`.
    const answerList = (todos: number[]): void => {
      const latest = response

      latest.next(todos)
      latest.complete()
    }
    const list = TestBed.createComponent(TodoList)
    const { todos, deleting } = list.componentInstance
    const store = TestBed.inject(TodoStore)

    list.detectChanges()
    answerList([1, 2, 3])
    store.remove.mutate(1)
    store.remove.mutate(2)

    expect(deleting()).toEqual([1, 2])

    deletes.answer(0)
    flushMicrotasks()

    expect(deleting()).toEqual([1, 2])

    deletes.answer(1)
    flushMicrotasks()

    expect(deleting()).toEqual([1, 2])

    answerList([3])
    flushMicrotasks()

    expect(todos.data()).toEqual([3])
    expect(deleting()).toEqual([])
  }))

  describe('filters', () => {
    it('lists only the runs whose key and status match', () => {
      TestBed.runInInjectionContext(() => {
        const keysOf = (filters: MutationFilters) =>
          injectMutationState(() => ({
            filters,
            select: (mutation) => mutation.mutationKey,
          }))

        saving(['todos', 'update']).mutate()
        saving(['todos']).mutate()
        saving(['users', 'update']).mutate()
        saving().mutate()
        // Done, and still shown by its mutation.
        injectMutation(() => ({
          mutationKey: ['todos', 'delete'],
          mutationFn: () => of('deleted'),
        })).mutate()

        expect(keysOf({ mutationKey: ['todos'] })()).toEqual([
          ['todos', 'update'],
          ['todos'],
          ['todos', 'delete'],
        ])
        expect(keysOf({ mutationKey: ['todos'], exact: true })()).toEqual([
          ['todos'],
        ])
        expect(keysOf({ status: 'success' })()).toEqual([['todos', 'delete']])
        expect(keysOf({ mutationKey: ['todos'], status: 'pending' })()).toEqual(
          [['todos', 'update'], ['todos']],
        )
        // A run without a key matches only filters without one.
        expect(keysOf({})().length).toBe(5)
        expect(keysOf({ mutationKey: [] })().length).toBe(4)
      })
    })

    it('lets each row list the deletes of its own todo, with an input in the filters', () => {
      const deletes = writes<number>()
      const rows = [1, 2].map((id) =>
        mountHost(
          (todoId: Signal<number>) =>
            injectMutationState(() => ({
              filters: {
                mutationKey: ['todos', 'delete', todoId()],
                status: 'pending',
              },
            })),
          id,
        ),
      )
      // A dialog somewhere else deletes todo 2.
      const remove = TestBed.runInInjectionContext(() =>
        injectMutation(() => ({
          mutationKey: ['todos', 'delete', 2],
          mutationFn: deletes.mutationFn,
        })),
      )

      remove.mutate(2)

      expect(rows.map(({ created }) => created().length)).toEqual([0, 1])

      // The first row moves on to todo 2.
      rows[0].value.set(2)
      rows[0].fixture.detectChanges()

      expect(rows[0].created().length).toBe(1)
    })

    it('follows the signals the options read, select included', () => {
      TestBed.runInInjectionContext(() => {
        const kind = signal('add')
        const label = signal('saving')
        const runs = injectMutationState(() => ({
          filters: { mutationKey: ['todos', kind()] },
          select: (mutation) =>
            `${label()} ${String(mutation.state.variables)}`,
        }))

        injectMutation(() => ({
          mutationKey: ['todos', 'add'],
          mutationFn: (title: string) => of(title),
        })).mutate('milk')
        injectMutation(() => ({
          mutationKey: ['todos', 'delete'],
          mutationFn: (id: number) => of(id),
        })).mutate(3)

        expect(runs()).toEqual(['saving milk'])

        kind.set('delete')

        expect(runs()).toEqual(['saving 3'])

        label.set('removing')

        expect(runs()).toEqual(['removing 3'])
      })
    })
  })

  describe('select', () => {
    it('gets each run the way the cache callbacks do: its state, meta and key', () => {
      TestBed.runInInjectionContext(() => {
        const snapshots = injectMutationState(() => ({
          select: (mutation) => mutation,
        }))

        injectMutation(() => ({
          mutationKey: ['todos', 'update'],
          meta: { invalidates: ['todos'] },
          mutationFn: (title: string) => of(title),
        })).mutate('milk')
        saving().mutate()

        expect(snapshots()).toEqual([
          {
            state: {
              status: 'success',
              data: 'milk',
              error: null,
              variables: 'milk',
              context: undefined,
              failureCount: 0,
              failureReason: null,
              submittedAt: jasmine.any(Number),
            },
            meta: { invalidates: ['todos'] },
            mutationKey: ['todos', 'update'],
          },
          // A run without a key has no mutationKey field.
          {
            state: jasmine.objectContaining({ status: 'pending' }),
            meta: undefined,
          },
        ])
      })
    })
  })

  // The list keeps its reference while the same runs are listed with equal
  // items, and each item keeps its own while it's equal and its run stays in
  // the list, whichever runs start or leave around it: an app may compare
  // them with ===, such as with includes() or `track`.
  describe('references', () => {
    it('keeps the same list while what select returns stays the same', () => {
      TestBed.runInInjectionContext(() => {
        const deletes = writes<number>()
        const remove = injectMutation(() => ({
          mutationKey: ['todos', 'delete'],
          mutationFn: deletes.mutationFn,
        }))
        const ids = injectMutationState(() => ({
          filters: { mutationKey: ['todos', 'delete'] },
          // A new object each time it's called.
          select: (mutation) => ({ id: mutation.state.variables as number }),
        }))

        remove.mutate(1)
        remove.mutate(2)

        const before = ids()

        expect(before).toEqual([{ id: 1 }, { id: 2 }])

        // Another kind of write starts.
        saving().mutate()

        expect(ids()).toBe(before)

        // The second delete lands, and its mutation still shows it.
        deletes.answer(1)

        expect(ids()).toBe(before)
      })
    })

    it('keeps the items that stay the same when another one changes', () => {
      TestBed.runInInjectionContext(() => {
        const deletes = writes<number>()
        const remove = injectMutation(() => ({
          mutationKey: ['todos', 'delete'],
          mutationFn: deletes.mutationFn,
        }))
        const rows = injectMutationState(() => ({
          select: (mutation) => ({
            id: mutation.state.variables as number,
            status: mutation.state.status,
          }),
        }))

        remove.mutate(1)
        remove.mutate(2)

        const [first] = rows()

        deletes.answer(1)

        expect(rows()).toEqual([
          { id: 1, status: 'pending' },
          { id: 2, status: 'success' },
        ])
        expect(rows()[0]).toBe(first)
      })
    })

    it('keeps the object a write was started with, once a write before it lands', () => {
      TestBed.runInInjectionContext(() => {
        const saves = writes<Todo>()
        const save = injectMutation(() => ({
          mutationKey: ['todos', 'update'],
          mutationFn: saves.mutationFn,
        }))
        const saving = injectMutationState(() => ({
          filters: { mutationKey: ['todos', 'update'], status: 'pending' },
          select: (mutation) => mutation.state.variables as Todo,
        }))
        const todos: Todo[] = [
          { id: 1, title: 'milk' },
          { id: 2, title: 'bread' },
        ]
        // Each row shows a spinner while its todo is being saved.
        const spinners = todos.map((todo) =>
          computed(() => saving().includes(todo)),
        )

        save.mutate(todos[0])
        save.mutate(todos[1])

        expect(spinners.map((spinner) => spinner())).toEqual([true, true])

        // The save of todo 1 lands first; todo 2's is still in flight.
        saves.answer(0)

        expect(spinners.map((spinner) => spinner())).toEqual([false, true])
      })
    })

    it('lists the object a write was started with, also when the run before had an equal one', () => {
      TestBed.runInInjectionContext(() => {
        const saves = writes<Todo>()
        const save = injectMutation(() => ({
          mutationKey: ['todos', 'update'],
          mutationFn: saves.mutationFn,
        }))
        // The update in flight, or the outcome the mutation shows.
        const updated = injectMutationState(() => ({
          filters: { mutationKey: ['todos', 'update'] },
          select: (mutation) => mutation.state.variables as Todo,
        }))
        const first = { id: 1, title: 'milk' }

        save.mutate(first)
        saves.answer(0)

        expect(updated()).toEqual([first])

        // The same values saved again, from a new object.
        const second = { id: 1, title: 'milk' }

        save.mutate(second)

        expect(updated()[0]).toBe(second)
      })
    })

    it('keeps the state of a run that stays, once a run before it leaves', () => {
      TestBed.runInInjectionContext(() => {
        const saves = writes<Todo>()
        const save = injectMutation(() => ({ mutationFn: saves.mutationFn }))
        const states = injectMutationState(() => ({
          filters: { status: 'pending' },
        }))
        const bread = { id: 2, title: 'bread' }

        save.mutate({ id: 1, title: 'milk' })
        save.mutate(bread)

        const [, breadState] = states()

        saves.answer(0)

        expect(states().length).toBe(1)
        expect(states()[0]).toBe(breadState)
        expect(states()[0].variables).toBe(bread)
      })
    })

    it('keeps what select built for a run that stays, once a run before it leaves', () => {
      TestBed.runInInjectionContext(() => {
        const deletes = writes<number>()
        const remove = injectMutation(() => ({
          mutationFn: deletes.mutationFn,
        }))
        const rows = injectMutationState(() => ({
          filters: { status: 'pending' },
          // A new object each time it's called.
          select: (mutation) => ({ id: mutation.state.variables as number }),
        }))

        remove.mutate(1)
        remove.mutate(2)
        remove.mutate(3)

        const [, second, third] = rows()

        deletes.answer(0)

        expect(rows()).toEqual([{ id: 2 }, { id: 3 }])
        expect(rows()[0]).toBe(second)
        expect(rows()[1]).toBe(third)
      })
    })

    it('keeps the items before a run that starts', () => {
      TestBed.runInInjectionContext(() => {
        const deletes = writes<number>()
        const remove = injectMutation(() => ({
          mutationFn: deletes.mutationFn,
        }))
        const rows = injectMutationState(() => ({
          select: (mutation) => ({ id: mutation.state.variables as number }),
        }))

        remove.mutate(1)

        const [first] = rows()

        remove.mutate(2)

        expect(rows()).toEqual([{ id: 1 }, { id: 2 }])
        expect(rows()[0]).toBe(first)
      })
    })
  })

  // A run stays in the cache while it's in flight, or while its mutation
  // shows it: the list holds the writes in flight and the outcome that each
  // mutation still shows, not a history of every write.
  describe('runs that are done', () => {
    it('lists the outcome a mutation shows, until its next mutate()', () => {
      TestBed.runInInjectionContext(() => {
        const saves = writes<string>()
        const save = injectMutation(() => ({ mutationFn: saves.mutationFn }))
        const runs = injectMutationState(() => ({
          select: (mutation) => [
            mutation.state.variables,
            mutation.state.status,
          ],
        }))

        save.mutate('milk')
        saves.answer(0)

        expect(runs()).toEqual([['milk', 'success']])

        save.mutate('bread')

        expect(runs()).toEqual([['bread', 'pending']])
      })
    })

    it('drops the outcome a mutation shows once its key changes', () => {
      // The todo a store edits, which its page sets.
      const id = signal(1)
      const save = TestBed.runInInjectionContext(() =>
        injectMutation(() => ({
          mutationKey: ['todos', 'update', id()],
          mutationFn: (title: string) => of(title),
        })),
      )
      const keys = TestBed.runInInjectionContext(() =>
        injectMutationState(() => ({
          select: (mutation) => mutation.mutationKey,
        })),
      )

      save.mutate('milk')

      expect(keys()).toEqual([['todos', 'update', 1]])

      // The page moves on to todo 2.
      id.set(2)
      TestBed.inject(ApplicationRef).tick()

      expect(keys()).toEqual([])
    })

    it("drops the outcome a route's service shows once the route is destroyed", () => {
      @Injectable()
      class TodoEditor {
        readonly save = injectMutation(() => ({
          mutationFn: (title: string) => of(title),
        }))
      }

      // Made as the router makes a route's injector.
      const route = createEnvironmentInjector(
        [TodoEditor],
        TestBed.inject(EnvironmentInjector),
      )
      const statuses = TestBed.runInInjectionContext(() =>
        injectMutationState(() => ({
          select: (mutation) => mutation.state.status,
        })),
      )

      route.get(TodoEditor).save.mutate('milk')

      expect(statuses()).toEqual(['success'])

      route.destroy()

      expect(statuses()).toEqual([])
    })

    it("drops a mutation's outcome once its component is destroyed", () => {
      @Component({ template: '' })
      class SaveButton {
        readonly save = injectMutation(() => ({
          mutationFn: (title: string) => of(title),
        }))
      }

      const statuses = TestBed.runInInjectionContext(() =>
        injectMutationState(() => ({
          select: (mutation) => mutation.state.status,
        })),
      )
      const button = TestBed.createComponent(SaveButton)

      button.detectChanges()
      button.componentInstance.save.mutate('milk')

      expect(statuses()).toEqual(['success'])

      button.destroy()

      expect(statuses()).toEqual([])
    })

    it('lists a write still in flight after its dialog is closed, and drops it once it fails', () => {
      const adds = writes<string>()

      @Component({ template: '' })
      class AddTodoDialog {
        readonly add = injectMutation(() => ({
          mutationKey: ['todos', 'add'],
          mutationFn: adds.mutationFn,
        }))
      }

      const adding = TestBed.runInInjectionContext(() =>
        injectMutationState(() => ({
          filters: { mutationKey: ['todos', 'add'] },
          select: (mutation) => [
            mutation.state.variables,
            mutation.state.status,
          ],
        })),
      )
      const dialog = TestBed.createComponent(AddTodoDialog)

      dialog.detectChanges()
      dialog.componentInstance.add.mutate('milk')
      dialog.destroy()

      expect(adding()).toEqual([['milk', 'pending']])

      adds.fail(0)

      expect(adding()).toEqual([])
    })
  })

  // Reading the signal throws what the options function or select throws,
  // the way reading a computed does, and works again once the cause is gone.
  describe('errors', () => {
    it('throws what select throws, until the run it throws for leaves', () => {
      TestBed.runInInjectionContext(() => {
        const saves = writes<string>()
        const save = injectMutation(() => ({ mutationFn: saves.mutationFn }))
        const failure = new Error('not a title')
        const titles = injectMutationState(() => ({
          select: (mutation) => {
            if (mutation.state.variables === '') throw failure

            return mutation.state.variables as string
          },
        }))

        save.mutate('')
        save.mutate('milk')

        expect(() => titles()).toThrow(failure)

        // The empty title lands, and no mutation shows it any more.
        saves.answer(0)

        expect(titles()).toEqual(['milk'])
      })
    })

    it('throws what the options function throws, until it stops', () => {
      TestBed.runInInjectionContext(() => {
        // The todo the key needs, still loading.
        const todo = signal<Todo | undefined>(undefined)
        const saving = injectMutationState(() => ({
          filters: { mutationKey: ['todos', 'update', todo()!.id] },
        }))

        expect(() => saving()).toThrowError(TypeError)

        todo.set({ id: 1, title: 'milk' })

        expect(saving()).toEqual([])
      })
    })
  })

  describe('injection context', () => {
    // The error names injectMutationState, not just the token that inject()
    // failed to find.
    it('throws when called outside an injection context, naming itself', () => {
      expect(() => injectMutationState()).toThrowError(
        /NG0203.*injectMutationState\(\) can only be used within an injection context/,
      )
    })

    it('works outside an injection context when given an injector', () => {
      const all = injectMutationState(undefined, { injector })
      const todos = injectMutationState(
        () => ({
          filters: { mutationKey: ['todos'] },
          select: (mutation) => mutation.mutationKey,
        }),
        { injector },
      )

      for (const mutationKey of [
        ['todos', 'update'],
        ['users', 'update'],
      ]) {
        client
          .getMutationCache()
          .build<string, Error, void, unknown>({
            mutationKey,
            mutationFn: () => new Subject<string>(),
          })
          .execute()
      }

      expect(all().length).toBe(2)
      expect(todos()).toEqual([['todos', 'update']])
    })
  })
})
