// Preloaded with `node --import` so actors can `import * as sr from 'sr'`.
import { registerHooks } from 'node:module';

const target = process.env.SR_NODE_LIB || 'file:///sr/node/sr.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sr') return { url: target, shortCircuit: true, format: 'module-typescript' };
    return next(specifier, context);
  },
});
