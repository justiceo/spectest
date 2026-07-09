// This project's source imports use `.js` specifiers (matching the esbuild-bundled
// runtime output) even though the source files are `.ts`. Some files (e.g. cli.ts)
// instead use extensionless specifiers, since esbuild resolves either style. Node's
// native TS execution (used by `npm run test:unit`, no bundler involved) needs this
// hook to fall back to the sibling `.ts` file in both cases.
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (isRelative && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  }
  if (isRelative && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}
