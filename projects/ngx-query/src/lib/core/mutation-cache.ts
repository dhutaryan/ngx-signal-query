import { Injectable } from '@angular/core'

import { Cache } from './cache'
import { Mutation, MutationOptions } from './mutation'

@Injectable()
export class MutationCache extends Cache<Mutation<unknown, unknown, unknown>> {
  #lastId = 0

  build<TData, TError, TVariables>(
    options: MutationOptions<TData, TError, TVariables>,
  ): Mutation<TData, TError, TVariables> {
    const mutation = new Mutation(++this.#lastId, options)
    this.addEntry(
      String(mutation.mutationId),
      mutation as Mutation<unknown, unknown, unknown>,
    )
    return mutation
  }

  remove<TData, TError, TVariables>(
    mutation: Mutation<TData, TError, TVariables>,
  ): void {
    this.removeEntry(String(mutation.mutationId))
  }

  override clear(): void {
    this.getAll().forEach((mutation) => mutation.cancel())
    super.clear()
  }
}
