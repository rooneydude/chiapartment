import { useEffect, useMemo, type DependencyList } from "react";

/** A memoized GPU resource, freed when it is replaced or its owner unmounts. */
export function useDisposable<T extends { dispose(): void } | null>(
  create: () => T,
  deps: DependencyList,
): T {
  const resource = useMemo(create, deps);
  useEffect(() => () => resource?.dispose(), [resource]);
  return resource;
}
