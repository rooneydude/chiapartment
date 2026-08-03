import { generic } from "./generic";
import { leo } from "./leo";
import { oldtownpark } from "./oldtownpark";
import { playwrightGeneric } from "./playwright-generic";
import { sightmap } from "./sightmap";
import { stead220 } from "./stead220";
import type { Adapter } from "./types";

export const adapters: Record<string, Adapter> = {
  generic,
  "playwright-generic": playwrightGeneric,
  oldtownpark,
  stead220,
  sightmap,
  leo,
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
