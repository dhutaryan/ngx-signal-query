import { inject, Injectable } from '@angular/core'
import { mutationOptions, queryOptions } from 'ngx-query'

import { AppRepository } from './app-repository'

@Injectable({ providedIn: 'root' })
export class AppQueries {
  private readonly _repository = inject(AppRepository)

  public recipe(id: number) {
    return queryOptions({
      queryKey: ['app', id],
      queryFn: () => this._repository.get(id),
      staleTime: 60_000,
    })
  }

  public addRecipe() {
    return mutationOptions({
      mutationFn: (name: string) => this._repository.add(name),
    })
  }
}
