import type { Provider } from '@angular/core'

/** Discriminator identifying each kind of {@link QueryClientFeature}. */
export enum QueryClientFeatureKind {
  DefaultOptions,
}

/**
 * An opaque feature passed to {@link provideQueryClient}. Create one with a
 * `with*` helper such as {@link withDefaultOptions} rather than constructing it
 * directly; the `ɵ`-prefixed members are internal.
 */
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
