// Filesystem-path helpers, ignore rules, and tree construction shared by the
// editor UI and the AI tools.

export interface TreeNode {
  name: string;
  /** Workspace-relative POSIX path. Empty string for the synthetic root. */
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.cache', '.vite', '.turbo', '.parcel-cache',
  '.idea', '.vscode', 'venv', '.venv', '__pycache__', '.pytest_cache',
  'target', 'bin', 'obj', '.gradle', '.terraform',
]);

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tif', 'tiff',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'webm',
  'wav', 'ogg', 'flac', 'psd', 'sketch', 'class', 'jar', 'wasm',
]);

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Directory portion of a POSIX path (empty if none). */
export function dirOf(posix: string): string {
  const i = posix.lastIndexOf('/');
  return i < 0 ? '' : posix.slice(0, i);
}

/** Final segment of a POSIX path. */
export function baseOf(posix: string): string {
  const i = posix.lastIndexOf('/');
  return i < 0 ? posix : posix.slice(i + 1);
}

export function isIgnored(relPosix: string): boolean {
  return relPosix.split('/').some((seg) => IGNORED_DIRS.has(seg));
}

export function isProbablyBinary(relPosix: string): boolean {
  const base = baseOf(relPosix);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXTS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Turn an absolute-or-relative path returned by findFiles() into a workspace-
 * relative POSIX path, given the workspace root as a POSIX path.
 */
export function toRelative(rootPosix: string, filePath: string): string {
  let fp = toPosix(filePath);
  if (rootPosix) {
    const prefix = `${rootPosix}/`;
    if (fp.toLowerCase().startsWith(prefix.toLowerCase())) {
      fp = fp.slice(prefix.length);
    }
  }
  return fp.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Build a nested tree from a flat list of relative file paths. */
export function buildTree(relPaths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
  const byPath = new Map<string, TreeNode>([['', root]]);

  for (const rel of relPaths) {
    const parts = rel.split('/').filter(Boolean);
    let parent = root;
    let curPath = '';
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const seg = parts[i];
      curPath = curPath ? `${curPath}/${seg}` : seg;
      let node = byPath.get(curPath);
      if (!node) {
        node = { name: seg, path: curPath, isDir: !isLast, children: [] };
        parent.children.push(node);
        byPath.set(curPath, node);
      } else if (!isLast) {
        node.isDir = true;
      }
      parent = node;
    }
  }

  sortTree(root);
  return root;
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}

/** Depth-first list of every file path in the tree. */
export function collectFiles(node: TreeNode, out: string[] = []): string[] {
  for (const child of node.children) {
    if (child.isDir) collectFiles(child, out);
    else out.push(child.path);
  }
  return out;
}

/** Depth-first list of every path in the tree (files and folders). */
export function collectPaths(node: TreeNode, out: string[] = []): string[] {
  for (const child of node.children) {
    out.push(child.path);
    if (child.isDir) collectPaths(child, out);
  }
  return out;
}

/**
 * Fast, stable content hash (FNV-1a, 32-bit) used only to detect that a file
 * changed since its description was written. Not cryptographic.
 */
export function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
