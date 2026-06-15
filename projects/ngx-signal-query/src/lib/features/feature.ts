import { Provider } from '@angular/core'

export enum QueryClientFeatureKind {
  DefaultOptions,
}

export interface QueryClientFeature<
  K extends QueryClientFeatureKind = QueryClientFeatureKind,
> {
  ɵkind: K
  ɵproviders: Provider[]
}

export function queryClientFeature<K extends QueryClientFeatureKind>(
  kind: K,
  providers: Provider[],
): QueryClientFeature<K> {
  return { ɵkind: kind, ɵproviders: providers }
}
