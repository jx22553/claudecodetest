import { toPosix } from './scan';

/** Join a workspace root (POSIX) and a relative path into an absolute path. */
export function absJoin(rootPosix: string, rel: string): string {
  if (!rootPosix) return rel;
  return `${rootPosix}/${rel}`;
}

/** Workspace root as a POSIX path, derived from an absolute file path. */
export function rootFromFilePath(filePath: string): string {
  const posix = toPosix(filePath);
  const i = posix.lastIndexOf('/');
  return i < 0 ? '' : posix.slice(0, i);
}
