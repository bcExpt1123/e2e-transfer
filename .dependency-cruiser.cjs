/**
 * Layer rules from docs/MAINTAINABILITY.md. CI fails on any violation.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: 'core must not depend on the app, Svelte or concrete adapters',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { path: ['^apps/', '^packages/(signaling|storage)/src', 'node_modules/svelte'] },
    },
    {
      name: 'adapters-independent',
      comment: 'signaling and storage adapters must not import each other',
      severity: 'error',
      // an adapter is a file (memory.ts) or a folder (nostr/); index.ts may re-export all of them
      from: { path: '^packages/(signaling|storage)/src/([^/.]+)', pathNot: '/src/index\\.ts$' },
      to: {
        path: '^packages/$1/src/',
        pathNot: '^packages/$1/src/($2([./]|$)|shared/)',
      },
    },
    {
      name: 'features-independent',
      comment: 'features must not import each other; share via lib/',
      severity: 'error',
      from: { path: '^apps/web/src/features/([^/]+)/' },
      to: { path: '^apps/web/src/features/', pathNot: '^apps/web/src/features/$1/' },
    },
    {
      name: 'ui-is-presentational',
      comment: 'design-system components must not use core or app state',
      severity: 'error',
      from: { path: '^apps/web/src/lib/ui/' },
      to: { path: ['^packages/', '^apps/web/src/lib/state/', '^apps/web/src/features/'] },
    },
    {
      name: 'core-only-via-state',
      comment: 'features reach core only through lib/state',
      severity: 'error',
      from: { path: '^apps/web/src/features/' },
      to: { path: '^packages/core/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|dist|paraglide)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'svelte', 'default'] },
  },
};
