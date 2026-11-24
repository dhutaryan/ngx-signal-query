import { RenderMode, type ServerRoute } from '@angular/ssr'

// The build prerenders every page into its own index.html, so GitHub Pages
// serves each page with a 200 and its text, rather than the SPA fallback's 404.
export const serverRoutes: ServerRoute[] = [
  { path: '**', renderMode: RenderMode.Prerender },
]
