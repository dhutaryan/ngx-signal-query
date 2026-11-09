import {
  EnvironmentInjector,
  Injector,
  PendingTasks,
  createEnvironmentInjector,
} from '@angular/core'
import { TestBed } from '@angular/core/testing'

import { lazyPendingTasks } from './pending-tasks'

describe('lazyPendingTasks', () => {
  it('adds no task, and throws nothing, once the injector is destroyed', () => {
    const injector = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    )

    injector.destroy()

    const removeTask = lazyPendingTasks(injector).add()

    expect(() => removeTask()).not.toThrow()
  })

  // As on Angular 19 while change detection is being set up: the injector is
  // there, but PendingTasks can't be created.
  it('throws what keeps PendingTasks from being created while the injector is still there', () => {
    const failure = new Error('PendingTasks failed')
    const injector = Injector.create({
      providers: [
        {
          provide: PendingTasks,
          useFactory: () => {
            throw failure
          },
        },
      ],
    })

    expect(() => lazyPendingTasks(injector).add()).toThrow(failure)
  })
})
