// AI tools so the chat agent can read the project structure and fill in
// descriptions in the active `.explorer` file.

import type { AIToolContext, ExtensionAITool, ExtensionToolResult } from '@nimbalyst/extension-sdk';
import { parseExplorer, serializeExplorer } from './explorerFile';
import { buildTree, collectFiles, collectPaths, hashContent, isIgnored, toRelative } from './scan';
import { absJoin, rootFromFilePath } from './paths';
import { findStalePaths } from './staleness';

function requireExplorerFile(context: AIToolContext): string | ExtensionToolResult {
  const path = context.activeFilePath;
  if (!path) return { success: false, error: 'No active file. Open a .explorer file first.' };
  if (!path.toLowerCase().endsWith('.explorer')) {
    return { success: false, error: 'The active file is not a .explorer file.' };
  }
  return path;
}

async function scanRelPaths(context: AIToolContext, rootPosix: string): Promise<string[]> {
  const found = await context.extensionContext.services.filesystem.findFiles('**/*');
  const rels: string[] = [];
  for (const f of found) {
    const rel = toRelative(rootPosix, f);
    if (!rel || rel.toLowerCase().endsWith('.explorer') || isIgnored(rel)) continue;
    rels.push(rel);
  }
  return rels;
}

export const aiTools: ExtensionAITool[] = [
  {
    name: 'projectexplorer.get_overview',
    description:
      'Return the project file/folder tree for the active .explorer file, descriptions already recorded, which of those are stale (the file changed since the description was written), and which are orphaned (the file no longer exists). Use this to understand the project structure before writing descriptions.',
    scope: 'editor',
    editorFilePatterns: ['*.explorer'],
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context): Promise<ExtensionToolResult> => {
      const filePath = requireExplorerFile(context);
      if (typeof filePath !== 'string') return filePath;
      try {
        const rootPosix = rootFromFilePath(filePath);
        const rels = await scanRelPaths(context, rootPosix);
        const tree = buildTree(rels);
        const raw = await context.extensionContext.services.filesystem.readFile(filePath);
        const data = parseExplorer(raw);

        const validPaths = new Set(collectPaths(tree));
        const orphanedPaths = Object.keys(data.descriptions).filter((p) => !validPaths.has(p));
        const stalePaths = await findStalePaths(
          context.extensionContext.services,
          rootPosix,
          tree,
          data.descriptions,
        );

        const descriptions: Record<string, string> = {};
        for (const [key, entry] of Object.entries(data.descriptions)) descriptions[key] = entry.text;

        return {
          success: true,
          message: `Found ${collectFiles(tree).length} files, ${stalePaths.size} stale description(s), ${orphanedPaths.length} orphaned description(s).`,
          data: {
            files: collectFiles(tree),
            descriptions,
            stalePaths: [...stalePaths],
            orphanedPaths,
          },
        };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: 'projectexplorer.set_descriptions',
    description:
      'Merge a map of file/folder path -> description into the active .explorer file. Paths must be workspace-relative (as returned by get_overview). Existing entries are overwritten; omitted ones are kept. Use this to fill in missing descriptions or refresh ones get_overview reported as stale.',
    scope: 'editor',
    editorFilePatterns: ['*.explorer'],
    inputSchema: {
      type: 'object',
      properties: {
        descriptions: {
          type: 'object',
          description: 'Object mapping relative path to a one-line description string.',
        },
      },
      required: ['descriptions'],
    },
    handler: async (args, context): Promise<ExtensionToolResult> => {
      const filePath = requireExplorerFile(context);
      if (typeof filePath !== 'string') return filePath;
      const incoming = args.descriptions;
      if (!incoming || typeof incoming !== 'object') {
        return { success: false, error: 'descriptions must be an object of path -> string.' };
      }
      try {
        const rootPosix = rootFromFilePath(filePath);
        const raw = await context.extensionContext.services.filesystem.readFile(filePath);
        const data = parseExplorer(raw);
        let applied = 0;
        for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
          if (typeof value !== 'string' || !value.trim()) continue;
          const text = value.trim();
          // Capture a content hash so a future edit to the described file can
          // be detected as making this description stale (see get_overview).
          let hash: string | undefined;
          try {
            const fileRaw = await context.extensionContext.services.filesystem.readFile(
              absJoin(rootPosix, key),
            );
            hash = hashContent(fileRaw);
          } catch {
            // Folder or unreadable file: store without a hash (never flagged stale).
          }
          data.descriptions[key] = hash ? { text, hash } : { text };
          applied++;
        }
        await context.extensionContext.services.filesystem.writeFile(filePath, serializeExplorer(data));
        return { success: true, message: `Saved ${applied} description(s) to ${filePath}.` };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
];
