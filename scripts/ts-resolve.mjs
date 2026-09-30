/**
 * Lets a build script import TypeScript sources from src/, which import
 * each other without file extensions (webpack, vitest and tsc resolve
 * those). Node's type stripping loads a `.ts` file but resolves only exact
 * specifiers, so this retries a relative import from a `.ts` file that
 * found nothing with `.ts` appended.
 *
 * Register it before the first such import. Static imports are resolved
 * before any of the importing module's code runs, so import those sources
 * dynamically, after the call.
 */

import { registerHooks } from 'node:module';

let registered = false;

export function registerTsResolution() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (err) {
        const retry = err?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !specifier.endsWith('.ts') && context.parentURL?.endsWith('.ts');
        if (retry) return next(`${specifier}.ts`, context);
        throw err;
      }
    },
  });
}
