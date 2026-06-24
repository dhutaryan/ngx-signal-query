// Sections shown in the generated release notes (one per commit type).
// NOTE: this list controls the changelog only — what triggers a release is
// defined separately in `releaseRules` below.
const TYPES = [
  { type: 'feat', section: '🚀 Features' },
  { type: 'fix', section: '🐛 Bug Fixes' },
  { type: 'perf', section: '🚄 Performance' },
  { type: 'refactor', section: '💅 Refactoring' },
  { type: 'docs', section: '📝 Documentation' },
  { type: 'test', section: '🧪 Tests' },
  { type: 'build', section: '🛠️ Build System' },
  { type: 'ci', section: '🚦️ CI' },
  { type: 'revert', section: '⏪ Reverts' },
]

module.exports = {
  branches: ['main', { name: 'dev', prerelease: true }],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
        // Only these types cut a release; docs/test/build/ci do not.
        releaseRules: [
          { breaking: true, release: 'major' },
          { revert: true, release: 'patch' },
          { type: 'feat', release: 'minor' },
          { type: 'fix', release: 'patch' },
          { type: 'perf', release: 'patch' },
          { type: 'refactor', release: 'patch' },
        ],
      },
    ],
    [
      '@semantic-release/release-notes-generator',
      { preset: 'conventionalcommits', presetConfig: { types: TYPES } },
    ],
    '@semantic-release/github',
    ['@semantic-release/npm', { pkgRoot: 'dist/ngx-signal-query' }],
  ],
}
