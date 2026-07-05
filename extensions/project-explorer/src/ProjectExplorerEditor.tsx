import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

import { getServices } from './host';
import { parseExplorer, serializeExplorer, emptyData } from './explorerFile';
import type { ExplorerData } from './explorerFile';
import { buildTree, collectFiles, collectPaths, hashContent, isIgnored, toRelative } from './scan';
import type { TreeNode } from './scan';
import { absJoin, rootFromFilePath } from './paths';
import { generateDescriptions } from './describe';
import { findStalePaths } from './staleness';

export function ProjectExplorerEditor({ host }: EditorHostProps) {
  const dataRef = useRef<ExplorerData>(emptyData());
  const [, forceRender] = useReducer((x) => x + 1, 0);
  // Guards a scan from running twice concurrently, and seeds the default
  // top-level expansion exactly once (so auto-refresh keeps the user's tree open).
  const scanInFlight = useRef(false);
  const seeded = useRef(false);

  const [tree, setTree] = useState<TreeNode | null>(null);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  // Paths whose file content no longer matches the hash recorded with their
  // description -- i.e. the description is potentially out of date.
  const [staleSet, setStaleSet] = useState<Set<string>>(new Set());

  const rootPosix = useMemo(() => rootFromFilePath(host.filePath), [host.filePath]);
  const explorerRel = useMemo(
    () => toRelative(rootPosix, host.filePath),
    [rootPosix, host.filePath],
  );

  const refreshStaleness = useCallback(
    async (t: TreeNode) => {
      const services = getServices();
      if (!services?.filesystem) return;
      try {
        const stale = await findStalePaths(services, rootPosix, t, dataRef.current.descriptions);
        setStaleSet(stale);
      } catch {
        // Best-effort -- leave the previous staleness state untouched.
      }
    },
    [rootPosix],
  );

  const scan = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true;
      const services = getServices();
      if (!services?.filesystem) {
        if (!silent) setMessage('Filesystem access is unavailable for this extension.');
        return;
      }
      if (scanInFlight.current) return;
      scanInFlight.current = true;
      if (!silent) {
        setScanning(true);
        setMessage(null);
      }
      try {
        const found = await services.filesystem.findFiles('**/*');
        const rels: string[] = [];
        for (const f of found) {
          const rel = toRelative(rootPosix, f);
          if (!rel || rel === explorerRel || isIgnored(rel)) continue;
          rels.push(rel);
        }
        const next = buildTree(rels);
        setTree(next);
        // Seed the top-level expansion only on the first scan; later scans
        // (Refresh / auto-refresh) preserve whatever the user has open.
        setExpanded((prev) => {
          if (seeded.current) return prev;
          seeded.current = true;
          return new Set(next.children.filter((c) => c.isDir).map((c) => c.path));
        });
        void refreshStaleness(next);
      } catch (e) {
        if (!silent) {
          setMessage(`Could not scan the project: ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        scanInFlight.current = false;
        if (!silent) setScanning(false);
      }
    },
    [rootPosix, explorerRel, refreshStaleness],
  );

  // Auto-refresh: rescan when the app window/tab regains focus, so files added
  // or removed outside the editor show up without a manual Refresh. Debounced,
  // and silent so it never clears status messages or flips the toolbar spinner.
  const scanRef = useRef(scan);
  scanRef.current = scan;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void scanRef.current({ silent: true }), 300);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') trigger();
    };
    window.addEventListener('focus', trigger);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', trigger);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const { isLoading, error, theme, markDirty } = useEditorLifecycle<ExplorerData>(host, {
    applyContent: (data) => {
      dataRef.current = data;
      forceRender();
    },
    getCurrentContent: () => dataRef.current,
    parse: parseExplorer,
    serialize: serializeExplorer,
    onLoaded: () => {
      void scan();
    },
    onExternalChange: (data) => {
      dataRef.current = data;
      forceRender();
      if (tree) void refreshStaleness(tree);
    },
  });

  const getDesc = (path: string): string => dataRef.current.descriptions[path]?.text ?? '';

  const clearStale = (paths: Iterable<string>) => {
    setStaleSet((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of paths) {
        if (next.delete(p)) changed = true;
      }
      return changed ? next : prev;
    });
  };

  const setDesc = useCallback(
    (path: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        delete dataRef.current.descriptions[path];
        markDirty();
        forceRender();
        return;
      }
      // Write immediately so the UI reflects the edit without waiting on a file read.
      dataRef.current.descriptions[path] = { text: trimmed };
      markDirty();
      clearStale([path]);
      forceRender();

      // Best-effort: attach a content hash in the background so a later change
      // to this file can be flagged as making the description stale.
      const services = getServices();
      if (services?.filesystem) {
        void services.filesystem.readFile(absJoin(rootPosix, path)).then(
          (raw) => {
            const current = dataRef.current.descriptions[path];
            if (current?.text === trimmed) {
              dataRef.current.descriptions[path] = { text: trimmed, hash: hashContent(raw) };
            }
          },
          () => {
            // Not readable (a folder, or the file was removed) -- leave without a hash.
          },
        );
      }
    },
    [rootPosix, markDirty],
  );

  const toggleExpand = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const runGeneration = useCallback(
    async (paths: string[]) => {
      const services = getServices();
      if (!services?.ai) {
        setMessage('AI is unavailable. Enable an AI provider in settings to draft descriptions.');
        return;
      }
      if (paths.length === 0) {
        setMessage('Every file already has a description. Use the ✨ on a row to redo one.');
        return;
      }
      setGenerating(true);
      setMessage(`Describing 0/${paths.length}…`);
      try {
        const map = await generateDescriptions(services, rootPosix, paths, (p) =>
          setMessage(`Describing ${p.done}/${p.total}…`),
        );
        const count = Object.keys(map).length;
        for (const [path, entry] of Object.entries(map)) {
          dataRef.current.descriptions[path] = entry;
        }
        if (count > 0) {
          markDirty();
          clearStale(Object.keys(map));
        }
        forceRender();
        setMessage(`Drafted ${count} description${count === 1 ? '' : 's'}. Review and save (Ctrl+S).`);
      } catch (e) {
        setMessage(`AI drafting failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setGenerating(false);
      }
    },
    [rootPosix, markDirty],
  );

  const describeMissing = useCallback(() => {
    if (!tree) return;
    const missing = collectFiles(tree).filter((p) => !getDesc(p));
    void runGeneration(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, runGeneration]);

  if (error) return <div className="pe-state">Failed to load: {error.message}</div>;
  if (isLoading) return <div className="pe-state">Loading…</div>;

  const totalFiles = tree ? collectFiles(tree).length : 0;
  const describedFiles = tree ? collectFiles(tree).filter((p) => getDesc(p)).length : 0;

  // Computed fresh every render (not memoized): dataRef.current.descriptions is
  // mutated in place, so its object identity never changes and a useMemo keyed
  // on it would never invalidate after an edit, generation, or prune.
  const orphanPaths = tree
    ? (() => {
        const valid = new Set(collectPaths(tree));
        return Object.keys(dataRef.current.descriptions).filter((k) => !valid.has(k));
      })()
    : [];

  const pruneOrphans = () => {
    if (orphanPaths.length === 0) return;
    for (const path of orphanPaths) delete dataRef.current.descriptions[path];
    markDirty();
    clearStale(orphanPaths);
    forceRender();
    setMessage(
      `Removed ${orphanPaths.length} description${orphanPaths.length === 1 ? '' : 's'} for files that no longer exist. Save (Ctrl+S) to persist.`,
    );
  };

  return (
    <div className="pe-root" data-theme={theme}>
      <div className="pe-toolbar">
        <span className="pe-title">Project Explorer</span>
        <span className="pe-count">
          {describedFiles}/{totalFiles} files described
        </span>
        <span className="pe-spacer" />
        {orphanPaths.length > 0 && (
          <button
            className="pe-btn"
            onClick={pruneOrphans}
            disabled={scanning || generating}
            title="Remove descriptions for files that no longer exist"
          >
            Clean up {orphanPaths.length}
          </button>
        )}
        <button className="pe-btn" onClick={() => void scan()} disabled={scanning || generating}>
          {scanning ? 'Scanning…' : 'Refresh'}
        </button>
        <button className="pe-btn pe-btn-primary" onClick={describeMissing} disabled={generating || scanning || !tree}>
          {generating ? 'Describing…' : '✨ Describe with AI'}
        </button>
      </div>

      {message && <div className="pe-message">{message}</div>}

      <div className="pe-body">
        {!tree ? (
          <div className="pe-state">{scanning ? 'Scanning project…' : 'No files scanned yet.'}</div>
        ) : tree.children.length === 0 ? (
          <div className="pe-state">No files found in this project.</div>
        ) : (
          <ul className="pe-list">
            {tree.children.map((child) => (
              <NodeRow
                key={child.path}
                node={child}
                depth={0}
                expanded={expanded}
                editing={editing}
                generating={generating}
                getDesc={getDesc}
                isStale={(path) => staleSet.has(path)}
                onToggle={toggleExpand}
                onStartEdit={setEditing}
                onCommitEdit={(path, text) => {
                  setDesc(path, text);
                  setEditing(null);
                }}
                onCancelEdit={() => setEditing(null)}
                onGenerateOne={(path) => void runGeneration([path])}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface NodeRowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  editing: string | null;
  generating: boolean;
  getDesc: (path: string) => string;
  isStale: (path: string) => boolean;
  onToggle: (path: string) => void;
  onStartEdit: (path: string) => void;
  onCommitEdit: (path: string, text: string) => void;
  onCancelEdit: () => void;
  onGenerateOne: (path: string) => void;
}

function NodeRow(props: NodeRowProps) {
  const { node, depth, expanded, editing, getDesc } = props;
  const isOpen = expanded.has(node.path);
  const desc = getDesc(node.path);
  const isEditing = editing === node.path;
  const stale = !node.isDir && !!desc && props.isStale(node.path);

  return (
    <li className="pe-node">
      <div className="pe-row" style={{ paddingLeft: depth * 16 + 8 }}>
        <button
          className="pe-caret"
          onClick={() => (node.isDir ? props.onToggle(node.path) : props.onStartEdit(node.path))}
          aria-label={node.isDir ? 'Toggle folder' : 'Edit description'}
        >
          {node.isDir ? (isOpen ? '▾' : '▸') : ''}
        </button>
        <span className="pe-icon">{node.isDir ? '📁' : '📄'}</span>
        <span
          className="pe-name"
          onClick={() => (node.isDir ? props.onToggle(node.path) : props.onStartEdit(node.path))}
          title={node.path}
        >
          {node.name}
        </span>
        {!node.isDir && (
          <button
            className="pe-mini"
            title={stale ? 'File changed since this was written — redraft with AI' : 'Draft this description with AI'}
            disabled={props.generating}
            onClick={() => props.onGenerateOne(node.path)}
          >
            ✨
          </button>
        )}
      </div>

      <div className="pe-descwrap" style={{ paddingLeft: depth * 16 + 42 }}>
        {isEditing ? (
          <textarea
            className="pe-editor"
            autoFocus
            defaultValue={desc}
            placeholder="Describe what this does…"
            onBlur={(e) => props.onCommitEdit(node.path, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                (e.target as HTMLTextAreaElement).blur();
              } else if (e.key === 'Escape') {
                props.onCancelEdit();
              }
            }}
          />
        ) : desc ? (
          <div className="pe-desc" onClick={() => props.onStartEdit(node.path)}>
            {desc}
            {stale && (
              <span className="pe-stale" title="This file's content changed since the description was written">
                ⚠ stale
              </span>
            )}
          </div>
        ) : (
          <button className="pe-add" onClick={() => props.onStartEdit(node.path)}>
            + add description
          </button>
        )}
      </div>

      {node.isDir && isOpen && node.children.length > 0 && (
        <ul className="pe-list">
          {node.children.map((child) => (
            <NodeRow {...props} key={child.path} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
