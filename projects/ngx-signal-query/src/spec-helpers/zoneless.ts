import * as core from '@angular/core'

// Change detection without zone.js, as Angular's
// provideZonelessChangeDetection() sets it up. CI also runs the specs on
// Angular 19, which has that provider as
// provideExperimentalZonelessChangeDetection (Angular 20 renamed it), so this
// calls whichever of the two the installed Angular has.
export function provideZonelessChangeDetection(): core.EnvironmentProviders {
  const exported = core as unknown as Record<
    string,
    () => core.EnvironmentProviders
  >

  return (
    exported['provideZonelessChangeDetection'] ??
    exported['provideExperimentalZonelessChangeDetection']
  )()
}
