// The dashboard is type-checked by `tsc --noEmit` and by `next build`, which is the
// authoritative gate for this repository. No ESLint rule set is configured, so this
// flat config exists only to give any ESLint runner a valid, empty configuration
// instead of failing to bootstrap.
export default [{ ignores: ['**/*'] }]
