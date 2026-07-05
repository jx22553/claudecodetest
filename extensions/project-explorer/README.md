# Project Explorer

> Development plan — please review and provide feedback before implementation begins.

## Overview

Project Explorer is a Nimbalyst extension that gives you a single, navigable view of
your whole project: a tree of files/folders on one side and, on the other, a
human-readable description of what each file or component does and how it fits into
the app. Think of it as an always-up-to-date "map + guidebook" for the codebase.

It opens as a custom editor on a `.explorer` project file that stores the descriptions,
so the notes live in your repo and travel with the code.

## How it works (as built, v0.1)

1. You create/open a `project.explorer` file at the repo root.
2. The extension scans the project and renders an **expandable outline** of files
   and folders (ignoring `node_modules`, `.git`, `dist`, etc.).
3. Each file/folder shows an inline **description** you can click to edit.
4. Descriptions are **AI-drafted, you-edit**: the **✨ Describe with AI** button
   drafts a one-line summary for every file lacking one; a per-row ✨ redoes one.
5. Only descriptions are saved back into the `.explorer` file as JSON; the tree is
   always derived live from the filesystem.

### Keeping it up to date

- **Structure**: rebuilt from the filesystem on open, on **Refresh**, and
  automatically when the app window/tab regains focus. New/removed files appear
  after any of those; expanded folders are preserved across refreshes.
- **Descriptions**: persisted per relative path, alongside a content hash of the
  file captured when the description was last written (manually or by AI).
  New files start blank until described.
  - **Stale detection**: if a file's content no longer matches that hash, its
    row shows a **⚠ stale** badge (checked on every scan, so it updates on
    Refresh/auto-refresh). Click the row's ✨ to redraft it.
  - **Orphan pruning**: if a described file is renamed or deleted, its entry
    stays in the JSON (nothing is lost) until you click **Clean up N** in the
    toolbar, which appears whenever descriptions exist for paths no longer in
    the tree.
  - Descriptions from before this version (or hand-written ones) have no
    hash and are simply never flagged stale — they still work, just without
    staleness tracking until re-saved.

## Open Questions

1. **Where do the descriptions come from?**
   - Option A (recommended): AI generates them via an extension AI tool, you can edit.
   - Option B: You write them all by hand; extension is just a viewer/editor.
   - Option C: Both — AI drafts, you refine.

2. **What counts as a "component"?**
   - Option A: Just files/folders (works for any project, including this HTML game).
   - Option B: Parse code to list functions/exports/classes per file (more work,
     language-specific — would start with JS/TS + the single-file HTML here).

3. **Scope of the scan**
   - Respect `.gitignore` and skip `node_modules`, `dist`, etc.? (recommended: yes)
   - Any folders you specifically want included/excluded?

4. **View style** — do you prefer a two-pane tree + detail layout, or an
   expandable outline where descriptions appear inline under each file?

## Proposed Features

### Core Features (v0.1.0)
- [ ] Custom editor bound to `*.explorer` files
- [ ] Directory scan → tree view (gitignore-aware)
- [ ] Detail pane showing description for the selected file/folder
- [ ] Inline editing of descriptions, saved to the `.explorer` JSON file
- [ ] "New Project Explorer" entry in the New File menu
- [ ] Theme-aware styling (light/dark via `--nim-*` variables)

### Nice to Have (Future)
- [x] AI tool: auto-generate a description for a file or the whole project
- [x] "Stale" indicator when a file changed after its description was written
- [x] Prune descriptions for files that were renamed/deleted
- [ ] Per-file component/export extraction for JS/TS
- [ ] Search/filter the tree
- [ ] Dependency/relationship graph (Excalidraw or Mermaid export)

## Technical Approach

### File format (`.explorer`, JSON)
```json
{
  "version": 1,
  "root": ".",
  "descriptions": {
    "index.html": { "text": "Single-file Tic-Tac-Toe game (markup, CSS, JS).", "hash": "a1b2c3d4" },
    "CLAUDE.md": "Guidance for Claude Code working in this repo."
  }
}
```
Each entry is either `{ text, hash }` (hash is a content fingerprint of the
described file, used for stale detection) or a plain string (legacy/hand-written
entries with no staleness tracking — both shapes parse fine). The tree is derived
live from the filesystem at open time; only descriptions are persisted, so the
file stays small and never goes out of sync with the real tree.

### Component structure
- `ProjectExplorerEditor` — top-level custom editor (uses `useEditorLifecycle`
  for load/save/parse/serialize of the `.explorer` JSON).
- `TreeView` — recursive file/folder tree, selection state.
- `DetailPane` — shows + edits the description for the selected node.

### Host capabilities to confirm
The tree needs to read the project's file listing. I'll verify which SDK/host API
exposes directory reads to an extension before finalizing the scan approach; if
extensions are sandboxed away from arbitrary FS reads, the fallback is to store a
snapshot of the tree in the `.explorer` file and refresh it via an AI tool.

## Implementation Checklist

### Phase 1: Structure
- [ ] manifest.json contributions (customEditors, newFileMenu, fileIcons)
- [ ] `.explorer` parse/serialize + `useEditorLifecycle` wiring
- [ ] Two-pane layout shell with theme variables

### Phase 2: Core functionality
- [ ] Directory scan + tree rendering
- [ ] Selection → detail pane
- [ ] Inline description editing + dirty/save

### Phase 3: Polish
- [ ] gitignore filtering, empty/error states
- [ ] Keyboard navigation in the tree

### Phase 4: AI integration (if approved)
- [ ] `projectexplorer.describe_file` / `describe_project` AI tools
- [ ] Tool handlers + wiring into the detail pane

## Next Steps

1. Answer the open questions above.
2. Confirm or adjust the feature list.
3. Say "approved" when ready and I'll start implementation.

---
*This plan was generated by the Extension Developer Kit. Edit as needed.*
