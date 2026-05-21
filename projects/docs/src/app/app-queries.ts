import { inject, Injectable } from '@angular/core'
import { queryOptions } from 'ngx-query'

import { AppRepository } from './app-repository'

@Injectable({ providedIn: 'root' })
export class AppQueries {
  private readonly _repository = inject(AppRepository)

  public recipe() {
    return queryOptions({
      queryKey: ['app'],
      queryFn: () => this._repository.get(),
    })
  }
}
