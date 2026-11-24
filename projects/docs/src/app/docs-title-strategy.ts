import { DOCUMENT } from '@angular/common'
import { Injectable, inject } from '@angular/core'
import { Meta, Title } from '@angular/platform-browser'
import {
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  TitleStrategy,
} from '@angular/router'

const SITE_NAME = 'ngx-signal-query'

// The deployed docs. A prerender runs at http://ng-localhost, so the address
// can't come from the document.
const SITE_URL = 'https://dhutaryan.github.io/ngx-signal-query/'

/**
 * Gives every page its own title, og:title, og:url and canonical link, for
 * search results and link previews. The prerender writes them into each page's
 * HTML, and in the browser they follow navigation.
 */
@Injectable({ providedIn: 'root' })
export class DocsTitleStrategy extends TitleStrategy {
  readonly #title = inject(Title)
  readonly #meta = inject(Meta)
  readonly #document = inject(DOCUMENT)

  override updateTitle(snapshot: RouterStateSnapshot): void {
    // The page's title first, then its section's: three sections each have a
    // page called "Overview". ng-doc nests every page in empty-path routes that
    // repeat its title, so a title equal to the one before it is skipped.
    const titles: string[] = []
    let route: ActivatedRouteSnapshot | null = snapshot.root

    for (; route; route = route.firstChild) {
      if (route.title && route.title !== titles[0]) titles.unshift(route.title)
    }

    const title = [...titles, SITE_NAME].join(' · ')

    // GitHub Pages answers a page's address with a trailing slash; without one,
    // it redirects there first.
    const path = snapshot.url.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '')
    const url = path ? `${SITE_URL}${path}/` : SITE_URL

    this.#title.setTitle(title)
    this.#meta.updateTag({ property: 'og:title', content: title })
    this.#meta.updateTag({ property: 'og:url', content: url })

    let canonical = this.#document.head.querySelector('link[rel="canonical"]')

    if (!canonical) {
      canonical = this.#document.createElement('link')
      canonical.setAttribute('rel', 'canonical')
      this.#document.head.appendChild(canonical)
    }

    canonical.setAttribute('href', url)
  }
}
