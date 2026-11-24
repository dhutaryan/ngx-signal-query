// Writes sitemap.xml into the built docs: one entry per page, at the canonical
// address that DocsTitleStrategy writes into the page. Pages without one, such
// as the redirects from a section to its first page, are left out.
//
// Usage: node projects/docs/scripts/sitemap.mjs dist/docs/browser
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = process.argv[2]

if (!root) {
  throw new Error('Usage: node sitemap.mjs <folder of the built docs>')
}

const urls = []

for (const file of readdirSync(root, { recursive: true })) {
  if (basename(file) !== 'index.html') continue

  const html = readFileSync(join(root, file), 'utf8')
  const link = html.match(/<link\b[^>]*\brel="canonical"[^>]*>/)?.[0]
  const href = link?.match(/\bhref="([^"]+)"/)?.[1]

  if (href) urls.push(href)
}

// No page with a canonical link means the prerender or DocsTitleStrategy broke,
// so the deploy stops rather than publish an empty sitemap.
if (urls.length === 0) {
  throw new Error(`No page in ${root} has a canonical link`)
}

urls.sort()

// The hrefs come from the HTML, where they're escaped already, so they go into
// the XML as they are.
const entries = urls.map((url) => `  <url><loc>${url}</loc></url>`)
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...entries,
  '</urlset>',
  '',
].join('\n')

writeFileSync(join(root, 'sitemap.xml'), sitemap)
console.log(`sitemap.xml: ${urls.length} pages`)
