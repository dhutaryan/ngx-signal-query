import {
  Component,
  type Signal,
  type WritableSignal,
  input,
  signal,
  viewChild,
} from '@angular/core'
import { type ComponentFixture, TestBed } from '@angular/core/testing'

// Mounts what `create` makes inside a host component, so its effects are tied
// to a real view and flush on detectChanges(). The host is rendered from a
// parent template, as in an app, and gets `value` through an `input.required`
// binding: what `create` makes may read it, although it has no value yet
// while the host is being constructed. Returns what `create` made, the
// parent's `value` signal (set it and detectChanges() to push a new input)
// and the fixture (destroy it to unmount).
export function mountHost<T, TValue>(
  create: (value: Signal<TValue>) => T,
  value?: TValue,
): {
  fixture: ComponentFixture<unknown>
  created: T
  value: WritableSignal<TValue>
} {
  @Component({ selector: 'app-host', template: '' })
  class Host {
    readonly value = input.required<TValue>()
    readonly created = create(this.value)
  }

  @Component({ imports: [Host], template: '<app-host [value]="value()" />' })
  class Parent {
    readonly value = signal(value as TValue)
    readonly host = viewChild.required(Host)
  }

  const fixture = TestBed.createComponent(Parent)

  fixture.detectChanges()

  return {
    fixture,
    created: fixture.componentInstance.host().created,
    value: fixture.componentInstance.value,
  }
}
