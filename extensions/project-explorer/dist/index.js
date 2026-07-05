import { jsxs as $, jsx as v } from "react/jsx-runtime";
import { useState as j, useRef as A, useCallback as k, useEffect as T, useReducer as be, useMemo as te, createElement as we } from "react";
function Ce(t, e) {
  const [n, i] = j(!0), [o, r] = j(null), [l, d] = j(!1), [y, m] = j(t.theme), [c, b] = j(null), [N, L] = j(t.isSourceModeActive?.() ?? !1), w = A(e);
  w.current = e;
  const g = A(""), D = A(!1), C = k(
    (a) => {
      const { parse: p } = w.current;
      return p ? p(a) : a;
    },
    []
    // stable -- reads from ref
  ), E = k(
    (a) => {
      const { serialize: p } = w.current;
      return p ? p(a) : String(a);
    },
    []
    // stable -- reads from ref
  ), P = k(() => {
    w.current.getCurrentContent && (D.current || (D.current = !0, d(!0), t.setDirty(!0)));
  }, [t]), O = k(() => {
    D.current && (D.current = !1, d(!1), t.setDirty(!1));
  }, [t]);
  T(() => {
    let a = !0;
    return (async () => {
      try {
        const h = w.current;
        if (h.binary) {
          const S = await t.loadBinaryContent();
          if (!a)
            return;
          h.applyContent(S);
        } else {
          const S = await t.loadContent();
          if (!a)
            return;
          const F = C(S);
          g.current = S, h.applyContent(F);
        }
        if (!a)
          return;
        i(!1), w.current.onLoaded?.();
      } catch (h) {
        if (!a)
          return;
        const S = h instanceof Error ? h : new Error(String(h));
        r(S), i(!1);
      }
    })(), () => {
      a = !1;
    };
  }, [t, C]), T(() => t.onSaveRequested(async () => {
    const a = w.current;
    try {
      if (a.onSave)
        await a.onSave();
      else {
        if (!a.getCurrentContent)
          return;
        const p = a.getCurrentContent();
        if (a.binary)
          await t.saveContent(p);
        else {
          const h = E(p);
          g.current = h, await t.saveContent(h);
        }
      }
      O();
    } catch {
    }
  }), [t, E, O]), T(() => t.onFileChanged((a) => {
    if (a === g.current)
      return;
    const p = w.current;
    try {
      const h = C(a);
      g.current = a, p.applyContent(h), O(), p.onExternalChange?.(h);
    } catch {
    }
  }), [t, C, O]), T(() => t.onThemeChanged((a) => {
    m(a);
  }), [t]), T(() => t.onDiffRequested ? t.onDiffRequested((p) => {
    const h = w.current;
    if (h.onDiffRequested) {
      h.onDiffRequested(p);
      return;
    }
    let S, F;
    try {
      S = h.binary ? p.originalContent : C(p.originalContent), F = h.binary ? p.modifiedContent : C(p.modifiedContent);
    } catch {
      return;
    }
    b({
      original: S,
      modified: F,
      tagId: p.tagId,
      sessionId: p.sessionId,
      accept: () => {
        w.current.applyContent(F), h.binary || (g.current = E(F)), t.reportDiffResult?.({
          content: h.binary ? "" : E(F),
          action: "accept"
        }), O(), b(null);
      },
      reject: () => {
        w.current.applyContent(S), h.binary || (g.current = E(S)), t.reportDiffResult?.({
          content: h.binary ? "" : E(S),
          action: "reject"
        }), O(), b(null);
      }
    });
  }) : void 0, [t, C, E, O]), T(() => {
    if (t.onDiffCleared)
      return t.onDiffCleared(async () => {
        const a = w.current;
        if (a.onDiffCleared) {
          await a.onDiffCleared();
          return;
        }
        b(null), a.binary || t.loadContent().then((p) => {
          const h = C(p);
          g.current = p, w.current.applyContent(h), O();
        });
      });
  }, [t, C, O]), T(() => {
    if (t.onSourceModeChanged)
      return t.onSourceModeChanged((a) => {
        L(a);
      });
  }, [t]);
  const q = t.toggleSourceMode ? k(() => t.toggleSourceMode?.(), [t]) : void 0;
  return {
    markDirty: P,
    isLoading: n,
    error: o,
    theme: y,
    isDirty: l,
    diffState: c,
    toggleSourceMode: q,
    isSourceMode: N
  };
}
let se;
function Se(t) {
  se = t;
}
function G() {
  return se;
}
function V() {
  return { version: 1, root: ".", descriptions: {} };
}
function X(t) {
  if (!t || !t.trim()) return V();
  try {
    const e = JSON.parse(t), n = {};
    if (e.descriptions && typeof e.descriptions == "object") {
      for (const [i, o] of Object.entries(e.descriptions))
        if (typeof o == "string")
          o.trim() && (n[i] = { text: o });
        else if (o && typeof o == "object") {
          const r = o.text, l = o.hash;
          typeof r == "string" && r.trim() && (n[i] = {
            text: r,
            ...typeof l == "string" ? { hash: l } : {}
          });
        }
    }
    return {
      version: typeof e.version == "number" ? e.version : 1,
      root: typeof e.root == "string" ? e.root : ".",
      descriptions: n
    };
  } catch {
    return V();
  }
}
function ie(t) {
  const e = {};
  for (const n of Object.keys(t.descriptions).sort()) {
    const i = t.descriptions[n], o = i?.text?.trim();
    o && (e[n] = i.hash ? { text: o, hash: i.hash } : { text: o });
  }
  return `${JSON.stringify({ version: t.version, root: t.root, descriptions: e }, null, 2)}
`;
}
const xe = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".vite",
  ".turbo",
  ".parcel-cache",
  ".idea",
  ".vscode",
  "venv",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  "target",
  "bin",
  "obj",
  ".gradle",
  ".terraform"
]), De = /* @__PURE__ */ new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "avif",
  "tif",
  "tiff",
  "pdf",
  "zip",
  "gz",
  "tar",
  "rar",
  "7z",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "webm",
  "wav",
  "ogg",
  "flac",
  "psd",
  "sketch",
  "class",
  "jar",
  "wasm"
]);
function oe(t) {
  return t.replace(/\\/g, "/");
}
function Ee(t) {
  const e = t.lastIndexOf("/");
  return e < 0 ? t : t.slice(e + 1);
}
function ce(t) {
  return t.split("/").some((e) => xe.has(e));
}
function ae(t) {
  const e = Ee(t), n = e.lastIndexOf(".");
  return n < 0 ? !1 : De.has(e.slice(n + 1).toLowerCase());
}
function Z(t, e) {
  let n = oe(e);
  if (t) {
    const i = `${t}/`;
    n.toLowerCase().startsWith(i.toLowerCase()) && (n = n.slice(i.length));
  }
  return n.replace(/^\.\//, "").replace(/^\/+/, "");
}
function le(t) {
  const e = { name: "", path: "", isDir: !0, children: [] }, n = /* @__PURE__ */ new Map([["", e]]);
  for (const i of t) {
    const o = i.split("/").filter(Boolean);
    let r = e, l = "";
    for (let d = 0; d < o.length; d++) {
      const y = d === o.length - 1, m = o[d];
      l = l ? `${l}/${m}` : m;
      let c = n.get(l);
      c ? y || (c.isDir = !0) : (c = { name: m, path: l, isDir: !y, children: [] }, r.children.push(c), n.set(l, c)), r = c;
    }
  }
  return de(e), e;
}
function de(t) {
  t.children.sort((e, n) => e.isDir !== n.isDir ? e.isDir ? -1 : 1 : e.name.localeCompare(n.name));
  for (const e of t.children) de(e);
}
function z(t, e = []) {
  for (const n of t.children)
    n.isDir ? z(n, e) : e.push(n.path);
  return e;
}
function ee(t, e = []) {
  for (const n of t.children)
    e.push(n.path), n.isDir && ee(n, e);
  return e;
}
function J(t) {
  let e = 2166136261;
  for (let n = 0; n < t.length; n++)
    e ^= t.charCodeAt(n), e = Math.imul(e, 16777619);
  return (e >>> 0).toString(16);
}
function Y(t, e) {
  return t ? `${t}/${e}` : e;
}
function Q(t) {
  const e = oe(t), n = e.lastIndexOf("/");
  return n < 0 ? "" : e.slice(0, n);
}
const je = 1500, ne = 12, Ne = "You document codebases. For each file provided, write ONE concise sentence (max ~20 words) describing what the file does and its role in the project. Base it on the path and any content given. Respond with ONLY a JSON object mapping each given file path (verbatim) to its description string.";
async function Pe(t, e, n, i) {
  const o = t.ai;
  if (!o) throw new Error("AI is not available. Enable an AI provider in settings.");
  const r = {}, l = n.length;
  let d = 0;
  for (let y = 0; y < n.length; y += ne) {
    const m = n.slice(y, y + ne), c = [];
    for (const g of m) {
      let D = "", C;
      if (!ae(g))
        try {
          const E = await t.filesystem.readFile(Y(e, g));
          C = J(E), D = E.slice(0, je);
        } catch {
        }
      c.push({ path: g, content: D, hash: C });
    }
    const b = c.map((g) => `PATH: ${g.path}
${g.content ? `CONTENT:
${g.content}` : "(no readable text content)"}`).join(`

---

`), N = await o.chatCompletion({
      systemPrompt: Ne,
      messages: [{ role: "user", content: b }],
      temperature: 0,
      responseFormat: { type: "json_object" }
    }), L = Oe(N.content, m), w = new Map(c.map((g) => [g.path, g.hash]));
    for (const [g, D] of Object.entries(L)) {
      const C = w.get(g);
      r[g] = C ? { text: D, hash: C } : { text: D };
    }
    d += m.length, i?.({ done: d, total: l });
  }
  return r;
}
function Oe(t, e) {
  const n = {};
  let i;
  try {
    i = JSON.parse(t);
  } catch {
    return n;
  }
  if (!i || typeof i != "object") return n;
  const o = new Set(e);
  for (const [r, l] of Object.entries(i))
    o.has(r) && typeof l == "string" && l.trim() && (n[r] = l.trim());
  return n;
}
async function fe(t, e, n, i) {
  const o = /* @__PURE__ */ new Set(), r = z(n).filter((l) => i[l]?.hash && !ae(l));
  return await Promise.all(
    r.map(async (l) => {
      const d = i[l];
      if (d?.hash)
        try {
          const y = await t.filesystem.readFile(Y(e, l));
          J(y) !== d.hash && o.add(l);
        } catch {
        }
    })
  ), o;
}
function Re({ host: t }) {
  const e = A(V()), [, n] = be((s) => s + 1, 0), i = A(!1), o = A(!1), [r, l] = j(null), [d, y] = j(!1), [m, c] = j(null), [b, N] = j(!1), [L, w] = j(/* @__PURE__ */ new Set()), [g, D] = j(null), [C, E] = j(/* @__PURE__ */ new Set()), P = te(() => Q(t.filePath), [t.filePath]), O = te(
    () => Z(P, t.filePath),
    [P, t.filePath]
  ), q = k(
    async (s) => {
      const f = G();
      if (f?.filesystem)
        try {
          const u = await fe(f, P, s, e.current.descriptions);
          E(u);
        } catch {
        }
    },
    [P]
  ), a = k(
    async (s) => {
      const f = s?.silent === !0, u = G();
      if (!u?.filesystem) {
        f || c("Filesystem access is unavailable for this extension.");
        return;
      }
      if (!i.current) {
        i.current = !0, f || (y(!0), c(null));
        try {
          const x = await u.filesystem.findFiles("**/*"), R = [];
          for (const W of x) {
            const I = Z(P, W);
            !I || I === O || ce(I) || R.push(I);
          }
          const B = le(R);
          l(B), w((W) => o.current ? W : (o.current = !0, new Set(B.children.filter((I) => I.isDir).map((I) => I.path)))), q(B);
        } catch (x) {
          f || c(`Could not scan the project: ${x instanceof Error ? x.message : String(x)}`);
        } finally {
          i.current = !1, f || y(!1);
        }
      }
    },
    [P, O, q]
  ), p = A(a);
  p.current = a, T(() => {
    let s;
    const f = () => {
      s && clearTimeout(s), s = setTimeout(() => {
        p.current({ silent: !0 });
      }, 300);
    }, u = () => {
      document.visibilityState === "visible" && f();
    };
    return window.addEventListener("focus", f), document.addEventListener("visibilitychange", u), () => {
      s && clearTimeout(s), window.removeEventListener("focus", f), document.removeEventListener("visibilitychange", u);
    };
  }, []);
  const { isLoading: h, error: S, theme: F, markDirty: M } = Ce(t, {
    applyContent: (s) => {
      e.current = s, n();
    },
    getCurrentContent: () => e.current,
    parse: X,
    serialize: ie,
    onLoaded: () => {
      a();
    },
    onExternalChange: (s) => {
      e.current = s, n(), r && q(r);
    }
  }), H = (s) => e.current.descriptions[s]?.text ?? "", K = (s) => {
    E((f) => {
      let u = !1;
      const x = new Set(f);
      for (const R of s)
        x.delete(R) && (u = !0);
      return u ? x : f;
    });
  }, pe = k(
    (s, f) => {
      const u = f.trim();
      if (!u) {
        delete e.current.descriptions[s], M(), n();
        return;
      }
      e.current.descriptions[s] = { text: u }, M(), K([s]), n();
      const x = G();
      x?.filesystem && x.filesystem.readFile(Y(P, s)).then(
        (R) => {
          e.current.descriptions[s]?.text === u && (e.current.descriptions[s] = { text: u, hash: J(R) });
        },
        () => {
        }
      );
    },
    [P, M]
  ), he = (s) => {
    w((f) => {
      const u = new Set(f);
      return u.has(s) ? u.delete(s) : u.add(s), u;
    });
  }, U = k(
    async (s) => {
      const f = G();
      if (!f?.ai) {
        c("AI is unavailable. Enable an AI provider in settings to draft descriptions.");
        return;
      }
      if (s.length === 0) {
        c("Every file already has a description. Use the ✨ on a row to redo one.");
        return;
      }
      N(!0), c(`Describing 0/${s.length}…`);
      try {
        const u = await Pe(
          f,
          P,
          s,
          (R) => c(`Describing ${R.done}/${R.total}…`)
        ), x = Object.keys(u).length;
        for (const [R, B] of Object.entries(u))
          e.current.descriptions[R] = B;
        x > 0 && (M(), K(Object.keys(u))), n(), c(`Drafted ${x} description${x === 1 ? "" : "s"}. Review and save (Ctrl+S).`);
      } catch (u) {
        c(`AI drafting failed: ${u instanceof Error ? u.message : String(u)}`);
      } finally {
        N(!1);
      }
    },
    [P, M]
  ), ge = k(() => {
    if (!r) return;
    const s = z(r).filter((f) => !H(f));
    U(s);
  }, [r, U]);
  if (S) return /* @__PURE__ */ $("div", { className: "pe-state", children: [
    "Failed to load: ",
    S.message
  ] });
  if (h) return /* @__PURE__ */ v("div", { className: "pe-state", children: "Loading…" });
  const me = r ? z(r).length : 0, ye = r ? z(r).filter((s) => H(s)).length : 0, _ = r ? (() => {
    const s = new Set(ee(r));
    return Object.keys(e.current.descriptions).filter((f) => !s.has(f));
  })() : [], ve = () => {
    if (_.length !== 0) {
      for (const s of _) delete e.current.descriptions[s];
      M(), K(_), n(), c(
        `Removed ${_.length} description${_.length === 1 ? "" : "s"} for files that no longer exist. Save (Ctrl+S) to persist.`
      );
    }
  };
  return /* @__PURE__ */ $("div", { className: "pe-root", "data-theme": F, children: [
    /* @__PURE__ */ $("div", { className: "pe-toolbar", children: [
      /* @__PURE__ */ v("span", { className: "pe-title", children: "Project Explorer" }),
      /* @__PURE__ */ $("span", { className: "pe-count", children: [
        ye,
        "/",
        me,
        " files described"
      ] }),
      /* @__PURE__ */ v("span", { className: "pe-spacer" }),
      _.length > 0 && /* @__PURE__ */ $(
        "button",
        {
          className: "pe-btn",
          onClick: ve,
          disabled: d || b,
          title: "Remove descriptions for files that no longer exist",
          children: [
            "Clean up ",
            _.length
          ]
        }
      ),
      /* @__PURE__ */ v("button", { className: "pe-btn", onClick: () => {
        a();
      }, disabled: d || b, children: d ? "Scanning…" : "Refresh" }),
      /* @__PURE__ */ v("button", { className: "pe-btn pe-btn-primary", onClick: ge, disabled: b || d || !r, children: b ? "Describing…" : "✨ Describe with AI" })
    ] }),
    m && /* @__PURE__ */ v("div", { className: "pe-message", children: m }),
    /* @__PURE__ */ v("div", { className: "pe-body", children: r ? r.children.length === 0 ? /* @__PURE__ */ v("div", { className: "pe-state", children: "No files found in this project." }) : /* @__PURE__ */ v("ul", { className: "pe-list", children: r.children.map((s) => /* @__PURE__ */ v(
      ue,
      {
        node: s,
        depth: 0,
        expanded: L,
        editing: g,
        generating: b,
        getDesc: H,
        isStale: (f) => C.has(f),
        onToggle: he,
        onStartEdit: D,
        onCommitEdit: (f, u) => {
          pe(f, u), D(null);
        },
        onCancelEdit: () => D(null),
        onGenerateOne: (f) => {
          U([f]);
        }
      },
      s.path
    )) }) : /* @__PURE__ */ v("div", { className: "pe-state", children: d ? "Scanning project…" : "No files scanned yet." }) })
  ] });
}
function ue(t) {
  const { node: e, depth: n, expanded: i, editing: o, getDesc: r } = t, l = i.has(e.path), d = r(e.path), y = o === e.path, m = !e.isDir && !!d && t.isStale(e.path);
  return /* @__PURE__ */ $("li", { className: "pe-node", children: [
    /* @__PURE__ */ $("div", { className: "pe-row", style: { paddingLeft: n * 16 + 8 }, children: [
      /* @__PURE__ */ v(
        "button",
        {
          className: "pe-caret",
          onClick: () => e.isDir ? t.onToggle(e.path) : t.onStartEdit(e.path),
          "aria-label": e.isDir ? "Toggle folder" : "Edit description",
          children: e.isDir ? l ? "▾" : "▸" : ""
        }
      ),
      /* @__PURE__ */ v("span", { className: "pe-icon", children: e.isDir ? "📁" : "📄" }),
      /* @__PURE__ */ v(
        "span",
        {
          className: "pe-name",
          onClick: () => e.isDir ? t.onToggle(e.path) : t.onStartEdit(e.path),
          title: e.path,
          children: e.name
        }
      ),
      !e.isDir && /* @__PURE__ */ v(
        "button",
        {
          className: "pe-mini",
          title: m ? "File changed since this was written — redraft with AI" : "Draft this description with AI",
          disabled: t.generating,
          onClick: () => t.onGenerateOne(e.path),
          children: "✨"
        }
      )
    ] }),
    /* @__PURE__ */ v("div", { className: "pe-descwrap", style: { paddingLeft: n * 16 + 42 }, children: y ? /* @__PURE__ */ v(
      "textarea",
      {
        className: "pe-editor",
        autoFocus: !0,
        defaultValue: d,
        placeholder: "Describe what this does…",
        onBlur: (c) => t.onCommitEdit(e.path, c.target.value),
        onKeyDown: (c) => {
          c.key === "Enter" && (c.metaKey || c.ctrlKey) ? c.target.blur() : c.key === "Escape" && t.onCancelEdit();
        }
      }
    ) : d ? /* @__PURE__ */ $("div", { className: "pe-desc", onClick: () => t.onStartEdit(e.path), children: [
      d,
      m && /* @__PURE__ */ v("span", { className: "pe-stale", title: "This file's content changed since the description was written", children: "⚠ stale" })
    ] }) : /* @__PURE__ */ v("button", { className: "pe-add", onClick: () => t.onStartEdit(e.path), children: "+ add description" }) }),
    e.isDir && l && e.children.length > 0 && /* @__PURE__ */ v("ul", { className: "pe-list", children: e.children.map((c) => /* @__PURE__ */ we(ue, { ...t, key: c.path, node: c, depth: n + 1 })) })
  ] });
}
function re(t) {
  const e = t.activeFilePath;
  return e ? e.toLowerCase().endsWith(".explorer") ? e : { success: !1, error: "The active file is not a .explorer file." } : { success: !1, error: "No active file. Open a .explorer file first." };
}
async function ke(t, e) {
  const n = await t.extensionContext.services.filesystem.findFiles("**/*"), i = [];
  for (const o of n) {
    const r = Z(e, o);
    !r || r.toLowerCase().endsWith(".explorer") || ce(r) || i.push(r);
  }
  return i;
}
const Te = [
  {
    name: "projectexplorer.get_overview",
    description: "Return the project file/folder tree for the active .explorer file, descriptions already recorded, which of those are stale (the file changed since the description was written), and which are orphaned (the file no longer exists). Use this to understand the project structure before writing descriptions.",
    scope: "editor",
    editorFilePatterns: ["*.explorer"],
    inputSchema: { type: "object", properties: {} },
    handler: async (t, e) => {
      const n = re(e);
      if (typeof n != "string") return n;
      try {
        const i = Q(n), o = await ke(e, i), r = le(o), l = await e.extensionContext.services.filesystem.readFile(n), d = X(l), y = new Set(ee(r)), m = Object.keys(d.descriptions).filter((N) => !y.has(N)), c = await fe(
          e.extensionContext.services,
          i,
          r,
          d.descriptions
        ), b = {};
        for (const [N, L] of Object.entries(d.descriptions)) b[N] = L.text;
        return {
          success: !0,
          message: `Found ${z(r).length} files, ${c.size} stale description(s), ${m.length} orphaned description(s).`,
          data: {
            files: z(r),
            descriptions: b,
            stalePaths: [...c],
            orphanedPaths: m
          }
        };
      } catch (i) {
        return { success: !1, error: i instanceof Error ? i.message : String(i) };
      }
    }
  },
  {
    name: "projectexplorer.set_descriptions",
    description: "Merge a map of file/folder path -> description into the active .explorer file. Paths must be workspace-relative (as returned by get_overview). Existing entries are overwritten; omitted ones are kept. Use this to fill in missing descriptions or refresh ones get_overview reported as stale.",
    scope: "editor",
    editorFilePatterns: ["*.explorer"],
    inputSchema: {
      type: "object",
      properties: {
        descriptions: {
          type: "object",
          description: "Object mapping relative path to a one-line description string."
        }
      },
      required: ["descriptions"]
    },
    handler: async (t, e) => {
      const n = re(e);
      if (typeof n != "string") return n;
      const i = t.descriptions;
      if (!i || typeof i != "object")
        return { success: !1, error: "descriptions must be an object of path -> string." };
      try {
        const o = Q(n), r = await e.extensionContext.services.filesystem.readFile(n), l = X(r);
        let d = 0;
        for (const [y, m] of Object.entries(i)) {
          if (typeof m != "string" || !m.trim()) continue;
          const c = m.trim();
          let b;
          try {
            const N = await e.extensionContext.services.filesystem.readFile(
              Y(o, y)
            );
            b = J(N);
          } catch {
          }
          l.descriptions[y] = b ? { text: c, hash: b } : { text: c }, d++;
        }
        return await e.extensionContext.services.filesystem.writeFile(n, ie(l)), { success: !0, message: `Saved ${d} description(s) to ${n}.` };
      } catch (o) {
        return { success: !1, error: o instanceof Error ? o.message : String(o) };
      }
    }
  }
], $e = {
  ProjectExplorerEditor: Re
};
function Le(t) {
  Se(t.services), console.log("Project Explorer activated");
}
function Me() {
  console.log("Project Explorer deactivated");
}
export {
  Le as activate,
  Te as aiTools,
  $e as components,
  Me as deactivate
};
//# sourceMappingURL=index.js.map
