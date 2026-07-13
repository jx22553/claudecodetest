---
name: project-code-review
description: Review the current code changes (or a named file/directory) across four dimensions — code quality, library dependencies & risk, compliance/licensing, and security. Use when the user asks for a "code review", "review my changes", "audit this code", or checks on dependencies, licensing, or security of this project.
---

# Project Code Review

Perform a structured review of code in this repository. Cover four dimensions and report findings ranked by severity. Be concrete: cite `file:line`, explain the risk, and give a fix.

## Scope

Default to the **uncommitted diff plus changes on the current branch vs. `main`**. If the user names a file, directory, or PR, review that instead.

```bash
git status --short
git diff --stat main...HEAD
git diff main...HEAD
```

If there is no diff, review the whole working tree (`index.html` and any other tracked source).

## What to check

### 1. Code quality
- **Correctness**: logic bugs, off-by-one, unhandled states, race conditions (e.g. the `setTimeout` CPU move racing a reset or a second click).
- **State integrity**: any mutation of game state that is not followed by the required `renderBoard()` call (see CLAUDE.md — the UI is a pure function of state).
- **Readability**: naming, dead code, duplicated logic, functions doing too much. Match the surrounding style.
- **Robustness**: input validation, boundary conditions, error handling.
- **Consistency**: does the change follow the patterns already in the file (e.g. reusing `WIN_LINES`, full re-render model)?

### 2. Library dependencies & risk
This project is deliberately dependency-free and single-file. Treat **any newly introduced dependency as a finding to justify**, not a default.
- Flag new `<script src>`/`<link>` to external CDNs, npm packages, or added `package.json`/lockfiles.
- For anything added, report: purpose, version pinning, maintenance status, transitive weight, and whether a small amount of vanilla code would remove the need.
- Flag supply-chain risks: unpinned versions, no SRI (`integrity=`) on external scripts, typosquat-prone names, abandoned packages.

### 3. Compliance & licensing
- Check the license of any added dependency or copied code snippet for compatibility; flag copyleft (GPL/AGPL) or missing/unknown licenses.
- Flag copied-in third-party code without attribution.
- Flag privacy/regulatory concerns: collection of personal data, analytics/telemetry, cookies/localStorage of user data, third-party network calls that leak data.

### 4. Security
- **XSS / injection**: use of `innerHTML`, `document.write`, `eval`, `new Function`, or inserting unescaped user/dynamic input into the DOM. Prefer `textContent`/`createElement`.
- **Untrusted input**: URL params, `postMessage`, `localStorage`, or fetched data used without validation.
- **Network**: external `fetch`/`XHR` endpoints, mixed content (http on https), missing SRI, secrets or tokens committed in source.
- **Unsafe browser APIs**: `target="_blank"` without `rel="noopener"`, permissive CSP, dangerous `window.open` usage.
- **Secrets**: any hardcoded keys, tokens, passwords, or credentials.

## Output format

Report as a short summary plus grouped findings. For each finding:

```
[SEVERITY] <one-line title>  —  file:line
  Risk:  what can go wrong
  Fix:   concrete change to make
```

Use severities **Critical / High / Medium / Low / Nit**. Rank most severe first. If a dimension is clean, say so in one line rather than padding. End with a one-sentence overall verdict (e.g. "Safe to merge after addressing the two High findings").

Do not modify code during a review unless the user explicitly asks you to apply the fixes.
