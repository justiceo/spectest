// This project's source imports use `.js` specifiers (matching the esbuild-bundled
// runtime output) even though the source files are `.ts`. Node's native TS execution
// (used by `npm run test:unit`, no bundler involved) needs this hook to fall back to
// the sibling `.ts` file when the literal `.js` specifier doesn't exist on disk.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}
