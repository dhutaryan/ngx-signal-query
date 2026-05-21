import { Component, effect, inject, signal } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import { injectQuery } from 'ngx-query'

import { AppQueries } from './app-queries'
import { JsonPipe } from '@angular/common'

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, JsonPipe],
  template: `
    <h1>Welcome to {{ title() }}!</h1>

    <pre>
      {{ query.data() | json }}
    </pre
    >

    <router-outlet />
  `,
  styles: [],
})
export class App {
  protected readonly title = signal('docs')

  private readonly _queries = inject(AppQueries)

  protected readonly query = injectQuery(() => this._queries.recipe())

  constructor() {
    effect(() => {
      console.log(this.query.data())
    })
  }
}
