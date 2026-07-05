// Detects descriptions whose file has changed since the description's hash
// was captured. Only reads files that actually have a stored hash, so cost
// scales with "files you've described", not "files in the repo".

import type { Services } from './host';
import type { DescriptionEntry } from './explorerFile';
import { absJoin } from './paths';
import { hashContent, isProbablyBinary } from './scan';
import type { TreeNode } from './scan';
import { collectFiles } from './scan';

/** Returns the set of file paths whose current content no longer matches the hash on record. */
export async function findStalePaths(
  services: Services,
  rootPosix: string,
  tree: TreeNode,
  descriptions: Record<string, DescriptionEntry>,
): Promise<Set<string>> {
  const stale = new Set<string>();
  const candidates = collectFiles(tree).filter((p) => descriptions[p]?.hash && !isProbablyBinary(p));

  await Promise.all(
    candidates.map(async (rel) => {
      const entry = descriptions[rel];
      if (!entry?.hash) return;
      try {
        const raw = await services.filesystem.readFile(absJoin(rootPosix, rel));
        if (hashContent(raw) !== entry.hash) stale.add(rel);
      } catch {
        // Unreadable now (e.g. race with a delete) -- don't flag as stale,
        // the tree scan will drop it from the list on the next pass anyway.
      }
    }),
  );

  return stale;
}
