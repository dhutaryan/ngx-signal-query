import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core'
import {
  provideClientHydration,
  withEventReplay,
  withNoHttpTransferCache,
} from '@angular/platform-browser'
import {
  TitleStrategy,
  provideRouter,
  withInMemoryScrolling,
} from '@angular/router'
import {
  provideHttpClient,
  withFetch,
  withInterceptorsFromDi,
} from '@angular/common/http'
import {
  NG_DOC_DEFAULT_PAGE_PROCESSORS,
  NG_DOC_DEFAULT_PAGE_SKELETON,
  provideMainPageProcessor,
  provideNgDocApp,
  providePageSkeleton,
} from '@ng-doc/app'
import { NG_DOC_ROUTING, provideNgDocContext } from '@ng-doc/generated'
import { DocsTitleStrategy } from './docs-title-strategy'

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
    { provide: TitleStrategy, useClass: DocsTitleStrategy },
    // ng-doc loads its icons and the API list through HttpClient, and while the
    // build prerenders the pages, it serves its own files to fetch() only.
    provideHttpClient(withFetch(), withInterceptorsFromDi()),
    // The app takes over the prerendered page rather than drawing it again,
    // except for the article: ng-doc opts it out of hydration and draws it again
    // in the same frame. No transfer cache: the browser asks for ng-doc's files
    // by other URLs than the prerender did, so the cached copies would never be
    // used.
    provideClientHydration(withEventReplay(), withNoHttpTransferCache()),
    provideNgDocContext(),
    provideNgDocApp(),
    providePageSkeleton(NG_DOC_DEFAULT_PAGE_SKELETON),
    provideMainPageProcessor(NG_DOC_DEFAULT_PAGE_PROCESSORS),
  ],
}
