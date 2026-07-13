import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core'
import { provideRouter, withInMemoryScrolling } from '@angular/router'
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http'
import {
  NG_DOC_DEFAULT_PAGE_PROCESSORS,
  NG_DOC_DEFAULT_PAGE_SKELETON,
  provideMainPageProcessor,
  provideNgDocApp,
  providePageSkeleton,
} from '@ng-doc/app'
import { NG_DOC_ROUTING, provideNgDocContext } from '@ng-doc/generated'

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(
      // NG_DOC_ROUTING has no route for the empty path, so `/` (and any unknown
      // URL) falls through to the wildcard and lands on the first page.
      [...NG_DOC_ROUTING, { path: '**', redirectTo: 'introduction' }],
      withInMemoryScrolling({
        scrollPositionRestoration: 'enabled',
        anchorScrolling: 'enabled',
      }),
    ),
    provideHttpClient(withInterceptorsFromDi()),
    provideNgDocContext(),
    provideNgDocApp(),
    providePageSkeleton(NG_DOC_DEFAULT_PAGE_SKELETON),
    provideMainPageProcessor(NG_DOC_DEFAULT_PAGE_PROCESSORS),
  ],
}
