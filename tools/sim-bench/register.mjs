// Resolves the project's extensionless TypeScript imports under plain Node
// (native ES modules: the solver's hot loops run as they do once bundled).
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      const url = new URL(specifier, context.parentURL);
      for (const candidate of [`${url.href}.ts`, `${url.href}/index.ts`])
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
    }
    return nextResolve(specifier, context);
  },
});
