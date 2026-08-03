import { generic } from "./generic";
import { playwrightGeneric } from "./playwright-generic";
import type { Adapter } from "./types";

export const adapters: Record<string, Adapter> = {
  generic,
  "playwright-generic": playwrightGeneric,
};

export function resolveAdapter(name: string): Adapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(
      `Unknown adapter "${name}". Valid adapters: ${Object.keys(adapters).join(", ")}`,
    );
  }
  return adapter;
}
