// Parse/serialize the `.explorer` file. Only descriptions are persisted; the
// file/folder tree is derived live from the filesystem so it never goes stale.

export interface DescriptionEntry {
  text: string;
  /**
   * Content hash of the described file at the time this text was last
   * written (see scan.ts#hashContent). Absent for legacy plain-string entries
   * or unreadable/binary files -- such entries are never flagged stale, since
   * there's nothing to compare against.
   */
  hash?: string;
}

export interface ExplorerData {
  version: number;
  root: string;
  /** Map of workspace-relative POSIX path -> description entry. */
  descriptions: Record<string, DescriptionEntry>;
}

export function emptyData(): ExplorerData {
  return { version: 1, root: '.', descriptions: {} };
}

export function parseExplorer(raw: string): ExplorerData {
  if (!raw || !raw.trim()) return emptyData();
  try {
    // The parsed shape is untrusted input (hand-edited file, older version, or
    // corrupt data), so descriptions is read as unknown values and validated
    // per-entry below rather than trusted as ExplorerData up front.
    const obj = JSON.parse(raw) as { version?: unknown; root?: unknown; descriptions?: Record<string, unknown> };
    const descriptions: Record<string, DescriptionEntry> = {};
    if (obj.descriptions && typeof obj.descriptions === 'object') {
      for (const [key, value] of Object.entries(obj.descriptions)) {
        if (typeof value === 'string') {
          // Legacy/hand-edited shape: plain string, no staleness tracking.
          if (value.trim()) descriptions[key] = { text: value };
        } else if (value && typeof value === 'object') {
          const text = (value as Partial<DescriptionEntry>).text;
          const hash = (value as Partial<DescriptionEntry>).hash;
          if (typeof text === 'string' && text.trim()) {
            descriptions[key] = {
              text,
              ...(typeof hash === 'string' ? { hash } : {}),
            };
          }
        }
      }
    }
    return {
      version: typeof obj.version === 'number' ? obj.version : 1,
      root: typeof obj.root === 'string' ? obj.root : '.',
      descriptions,
    };
  } catch {
    // Corrupt or partial file: start clean rather than throwing so the editor
    // still opens. The user's next save rewrites valid JSON.
    return emptyData();
  }
}

export function serializeExplorer(data: ExplorerData): string {
  // Sort keys so diffs stay stable regardless of insertion order.
  const sorted: Record<string, DescriptionEntry> = {};
  for (const key of Object.keys(data.descriptions).sort()) {
    const entry = data.descriptions[key];
    const text = entry?.text?.trim();
    if (!text) continue;
    sorted[key] = entry.hash ? { text, hash: entry.hash } : { text };
  }
  return `${JSON.stringify({ version: data.version, root: data.root, descriptions: sorted }, null, 2)}\n`;
}
