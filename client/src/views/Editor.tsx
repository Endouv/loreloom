import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, countWords, streamSse, type Chapter, type ChapterMeta, type ChapterVersion } from "../api.js";
import { diffLines, diffStats, type DiffLine } from "../diff.js";
import { Button, Card, Empty, Input, Label, Modal, Spinner, Tag, TextArea, useAppState } from "../ui.js";

type SaveState = "saved" | "dirty" | "saving" | "error";

interface SearchHit {
  chapterId: number;
  chapterTitle: string;
  excerpt: string;
}

// A generation the server saved *while* it streamed — insurance against a
// crashed tab so no AI output is ever lost before the author clicks Insert.
interface DraftRow {
  id: number;
  task: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  chapterId: number | null;
}

interface VersionBody {
  id: number;
  body: string;
  title: string;
  source: string;
  createdAt: string;
}

const WRITING_ACTIONS = [
  { mode: "draft", label: "Draft from brief", blurb: "Turn your notes below into prose" },
  { mode: "expand", label: "Expand selection / chapter", blurb: "Richer prose, same facts" },
  { mode: "rewrite", label: "Rewrite selection / chapter", blurb: "Natural polish, same meaning" },
  { mode: "transition", label: "Write transition", blurb: "Smooth bridge for the next scene" },
  { mode: "dialogue", label: "Improve dialogue", blurb: "Character-rooted speech" },
  { mode: "describe", label: "Describe scene", blurb: "Concrete sensory detail" },
] as const;

// The prose doctor: each mode is a focused pass over the same text, and the
// server returns an explicit before → after list instead of silently rewriting.
const POLISH_MODES = [
  { key: "grammar", label: "Grammar", blurb: "Fix grammar, punctuation and tense slips" },
  { key: "structure", label: "Better sentences", blurb: "Restructure awkward sentences, smoother flow" },
  { key: "vocabulary", label: "Stronger words", blurb: "Replace weak or repeated words" },
  { key: "repetition", label: "Repetition", blurb: "Vary repeated words and patterns" },
  { key: "dialogue", label: "Dialogue", blurb: "Trim filler, sharpen voices" },
  { key: "pacing", label: "Pacing", blurb: "Tighten slow, overwritten passages" },
  { key: "description", label: "Description", blurb: "Concrete detail, less padding" },
  { key: "tone", label: "Tone", blurb: "Keep the passage tonally consistent" },
] as const;

interface PolishChange {
  type: string;
  original: string;
  suggestion: string;
  note: string;
}

const STATUS_TONES: Record<string, "gold" | "amber" | "green"> = { draft: "gold", revision: "amber", completed: "green" };

export const Editor: React.FC = () => {
  const { prefs, activeNovelId } = useAppState();
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [words, setWords] = useState(0);
  const [error, setError] = useState("");
  const [versions, setVersions] = useState<ChapterVersion[] | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [aiOpen, setAiOpen] = useState(true);
  const [aiOutput, setAiOutput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiModel, setAiModel] = useState("");
  const [aiMode, setAiMode] = useState<string>("draft");
  const [aiInstructions, setAiInstructions] = useState("");
  const [aiSelection, setAiSelection] = useState(true); // use selected text when on
  const [aiFromSelection, setAiFromSelection] = useState("");
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  // Version diff: `lines` are the old snapshot (base) vs the current editor text.
  const [diffView, setDiffView] = useState<{ meta: ChapterVersion; lines: DiffLine[] } | null>(null);
  // Fix & polish (the /ai/editor JSON endpoint)
  const [polishModes, setPolishModes] = useState<string[]>(["grammar"]);
  const [polishBusy, setPolishBusy] = useState(false);
  const [polish, setPolish] = useState<{ revised: string; changes: PolishChange[]; model: string } | null>(null);
  const [polishError, setPolishError] = useState("");
  const [polishFromSelection, setPolishFromSelection] = useState(false);
  // The exact range the polish was requested for; applying must never fall back
  // to replacing the whole chapter when the user clicked elsewhere in between.
  const polishRangeRef = useRef<{ from: number; to: number } | null>(null);
  const [chapterModal, setChapterModal] = useState<{ mode: "new" | "rename"; name: string } | null>(null);


  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewRef = useRef<any>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadingDocRef = useRef(false);
  const lastSavedRef = useRef("");
  // Chapter body fetched before the CodeMirror view finished constructing
  // (dynamic imports). The view flushes this on creation.
  const pendingBodyRef = useRef<string | null>(null);
  // The editor container only exists once a chapter is open, so creation must
  // react to it appearing (a callback ref + version counters, not a mount-once
  // effect, or the view would never be constructed).
  const [editorNode, setEditorNode] = useState<HTMLDivElement | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);

  useEffect(() => {
    if (!activeNovelId) return;
    api
      .get<ChapterMeta[]>(`/novels/${activeNovelId}/chapters`)
      .then((cs) => {
        setChapters(cs);
        setActiveId((cur) => (cur && cs.some((c) => c.id === cur) ? cur : (cs[0]?.id ?? null)));
      })
      .catch((e) => setError(e.message));
  }, [activeNovelId]);

  // A polish result belongs to one chapter and one selection. Drop it when the
  // author switches chapters so it can never be applied to the wrong text.
  useEffect(() => {
    setPolish(null);
    setPolishError("");
    setPolishFromSelection(false);
    polishRangeRef.current = null;
  }, [activeId]);

  const reloadChapters = useCallback(() => {
    if (!activeNovelId) return;
    api.get<ChapterMeta[]>(`/novels/${activeNovelId}/chapters`).then(setChapters).catch(() => {});
  }, [activeNovelId]);

  // Create the CodeMirror editor once the container node exists. The ref div
  // is unmounted while no chapter is open, so this runs when it first mounts.
  useEffect(() => {
    if (!editorNode || viewRef.current) return;
    let disposed = false;
    void import("@codemirror/state").then(async ({ EditorState }) => {
      if (disposed) return;
      const CMView = await import("@codemirror/view");
      const { history, historyKeymap, defaultKeymap } = await import("@codemirror/commands");
      const { EditorView, keymap, placeholder, drawSelection, EditorView: _ } = CMView as any;
      const view = new EditorView({
        parent: editorNode,
        state: EditorState.create({
          doc: "",
          extensions: [
            history(),
            keymap.of([...historyKeymap, ...defaultKeymap]),
            placeholder("The page is empty. Write, or ask the AI on the right for a draft…"),
            drawSelection(),
            EditorView.lineWrapping,
            EditorState.allowMultipleSelections.of(false),
            EditorView.updateListener.of((u: any) => {
              if (!u.docChanged || loadingDocRef.current) return;
              const text = u.state.doc.toString();
              setWords(countWords(text));
              setSaveState("dirty");
            }),
          ],
        }),
      });
      viewRef.current = view;
      view.dom.setAttribute("class", `cm-editor ${prefs?.ui.focusMode ? "cm-focus-dim" : ""}`);
      // If a chapter was fetched while the view was still constructing, load it now.
      if (pendingBodyRef.current !== null) {
        const body = pendingBodyRef.current;
        pendingBodyRef.current = null;
        loadingDocRef.current = true;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: body } });
        loadingDocRef.current = false;
      }
      setEditorVersion((v) => v + 1);
    });
    return () => {
      disposed = true;
      viewRef.current?.destroy?.();
      viewRef.current = null;
    };
  }, [editorNode]);

  // Focus-mode dimming is a pure class change; no need to rebuild the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dom.setAttribute("class", `cm-editor ${prefs?.ui.focusMode ? "cm-focus-dim" : ""}`);
  }, [prefs?.ui.focusMode, editorVersion]);

  // Load a chapter into the editor. If the CodeMirror view isn't constructed
  // yet (async imports), the body is parked in pendingBodyRef and the view
  // picks it up on creation — so ordering never matters.
  useEffect(() => {
    if (!activeId) return;
    loadingDocRef.current = true;
    api
      .get<Chapter>(`/chapters/${activeId}`)
      .then((c) => {
        setChapter(c);
        setWords(c.wordCount);
        lastSavedRef.current = c.body;
        setSaveState("saved");
        const view = viewRef.current;
        if (view) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: c.body },
          });
        } else {
          pendingBodyRef.current = c.body;
        }
        loadingDocRef.current = false;
      })
      .catch((e) => setError(e.message))
      .finally(() => {
        loadingDocRef.current = false;
      });
  }, [activeId]);

  const persist = useCallback(
    async (payload: Partial<Chapter>) => {
      if (!activeId) return;
      setSaveState("saving");
      try {
        const updated = await api.put<Chapter>(`/chapters/${activeId}`, payload);
        setChapter(updated);
        setChapters((cs) => cs.map((c) => (c.id === activeId ? { ...c, title: updated.title, status: updated.status, wordCount: updated.wordCount, notes: updated.notes } : c)));
        setSaveState("saved");
      } catch (e: any) {
        setSaveState("error");
        setError(e.message);
      }
    },
    [activeId]
  );

  const scheduleAutosave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const interval = prefs?.autosaveIntervalMs ?? 1200;
    saveTimer.current = setTimeout(() => {
      const view = viewRef.current;
      if (!view || !activeId) return;
      const text = view.state.doc.toString();
      if (text === lastSavedRef.current) {
        setSaveState("saved");
        return;
      }
      lastSavedRef.current = text;
      persist({ body: text });
    }, interval);
  }, [activeId, persist, prefs]);

  // Hook doc changes into autosave.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const onDocChange = () => {
      if (loadingDocRef.current) return;
      setSaveState("dirty");
      scheduleAutosave();
    };
    // listen via CodeMirror updateListener already; this covers focus-mode class changes
    view.dom.addEventListener("input", onDocChange);
    return () => view.dom.removeEventListener("input", onDocChange);
  }, [activeId, scheduleAutosave]);

  const beforeunload = useCallback((e: BeforeUnloadEvent) => {
    if (saveState === "dirty" || saveState === "saving") {
      e.preventDefault();
      e.returnValue = "";
    }
  }, [saveState]);
  useEffect(() => {
    window.addEventListener("beforeunload", beforeunload);
    return () => window.removeEventListener("beforeunload", beforeunload);
  }, [beforeunload]);

  const captureSelection = () => {
    const view = viewRef.current;
    if (!view) return "";
    const sel = view.state.selection.main;
    return sel.empty ? "" : view.state.doc.sliceString(sel.from, sel.to);
  };

  const insertAtCursor = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.to, insert: (sel.empty ? "" : "\n\n") + text },
      selection: { anchor: sel.to + text.length },
    });
    setAiOutput("");
  };

  const replaceSelectionOrChapter = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    } else {
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text } });
    }
    setAiOutput("");
  };

  const loadDrafts = useCallback(() => {
    if (!activeNovelId || !chapter) {
      setDrafts([]);
      return;
    }
    api
      .get<DraftRow[]>(`/ai/drafts?novelId=${activeNovelId}&chapterId=${chapter.id}`)
      .then(setDrafts)
      .catch(() => setDrafts([]));
  }, [activeNovelId, chapter]);

  useEffect(() => {
    if (aiOpen) loadDrafts();
  }, [aiOpen, loadDrafts]);

  const runAi = async (mode: string) => {
    if (!activeNovelId || !chapter || aiBusy) return;
    const view = viewRef.current;
    const whole = view?.state.doc.toString() ?? "";
    const sel = aiSelection ? captureSelection() : "";
    const input = sel || whole;
    setAiFromSelection(sel);
    if (mode === "draft" && !aiInstructions.trim()) {
      setError("For a draft, describe the scene or paste your notes in the instructions box first.");
      return;
    }
    setAiBusy(true);
    setAiOutput("");
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamSse(
        "/ai/write",
        { novelId: activeNovelId, chapterId: chapter.id, mode, input, instructions: aiInstructions },
        {
          onStart: (e) => setAiModel(e.model),
          onDelta: (t) => setAiOutput((o) => o + t),
          onEvent: (type, e) => {
            if (type === "error") setError(e.message || "Generation failed.");
            if (type === "cancelled") setError("Generation cancelled.");
          },
        },
        controller.signal
      );
    } finally {
      setAiBusy(false);
      abortRef.current = null;
      loadDrafts(); // server persisted this generation as a recoverable draft
    }
  };

  // ---- Fix & polish: grammar, better sentences, stronger words… ----------
  const runPolish = async () => {
    if (!activeNovelId || !chapter || polishBusy) return;
    const view = viewRef.current;
    const selRange = view?.state.selection.main;
    const useSelection = aiSelection && !!selRange && !selRange.empty;
    const text = useSelection ? view!.state.doc.sliceString(selRange!.from, selRange!.to) : view?.state.doc.toString() || "";
    setPolishFromSelection(useSelection);
    polishRangeRef.current = useSelection ? { from: selRange!.from, to: selRange!.to } : null;
    setPolishError("");
    setPolish(null);
    if (!text.trim()) {
      setPolishError("There is no text to edit yet — write something (or select a passage) first.");
      return;
    }
    if (text.length > 16000) {
      setPolishError(
        `That ${useSelection ? "selection" : "chapter"} is ${text.length.toLocaleString()} characters — one editing pass handles up to 16,000. Select the passage you want polished, then run it again.`
      );
      return;
    }
    if (!polishModes.length) {
      setPolishError("Pick at least one kind of fix above.");
      return;
    }
    setPolishBusy(true);
    try {
      const result = await api.post<{ revised: string; changes: PolishChange[]; model: string }>("/ai/editor", {
        novelId: activeNovelId,
        text,
        modes: polishModes,
      });
      setPolish(result);
    } catch (e: any) {
      setPolishError(e.message || "The editing model failed.");
    } finally {
      setPolishBusy(false);
    }
  };

  const applyPolish = async () => {
    if (!polish || !activeId) return;
    const view = viewRef.current;
    if (!view) return;
    const range = polishFromSelection ? polishRangeRef.current : null;
    if (range) {
      const docLen = view.state.doc.length;
      const to = Math.min(range.to, docLen);
      const from = Math.min(range.from, to);
      view.dispatch({
        changes: { from, to, insert: polish.revised },
        selection: { anchor: from + polish.revised.length },
      });
    } else {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: polish.revised } });
    }
    // Snapshot the previous text first, then save the polished version.
    const body = view.state.doc.toString();
    try {
      await api.put(`/chapters/${activeId}?source=manual`, { body });
      lastSavedRef.current = body;
      setSaveState("saved");
      loadVersions();
    } catch (e: any) {
      setSaveState("error");
      setError(e.message);
    }
    setPolish(null);
    setPolishFromSelection(false);
    polishRangeRef.current = null;
  };

  const saveVersion = async () => {
    if (!activeId) return;
    await api.put(`/chapters/${activeId}?source=manual`, { body: viewRef.current.state.doc.toString() });
    loadVersions();
    setSaveState("saved");
  };

  const loadVersions = useCallback(() => {
    if (!activeId) return;
    api.get<ChapterVersion[]>(`/chapters/${activeId}/versions`).then(setVersions).catch(() => setVersions([]));
  }, [activeId]);

  const showVersionDiff = async (v: ChapterVersion) => {
    if (!activeId) return;
    // Snapshot (old) vs the text currently in the editor (new):
    // del = in that snapshot but edited away since, add = written since.
    const [version, current] = await Promise.all([
      api.get<VersionBody>(`/chapters/${activeId}/versions/${v.id}`),
      Promise.resolve(viewRef.current?.state.doc.toString() ?? chapter?.body ?? ""),
    ]);
    setDiffView({ meta: v, lines: diffLines(version.body, current) });
  };

  useEffect(() => {
    if (showVersions) loadVersions();
  }, [showVersions, loadVersions]);

  const restoreVersion = async (versionId: number) => {
    if (!confirm("Restore this version? The current text is snapshot first, so this can be undone from history.")) return;
    const restored = await api.post<Chapter>(`/chapters/${activeId}/versions/${versionId}/restore`);
    setChapter(restored);
    lastSavedRef.current = restored.body;
    setSaveState("saved");
    const view = viewRef.current!;
    loadingDocRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: restored.body } });
    loadingDocRef.current = false;
    loadVersions();
    setShowVersions(false);
  };

  const runSearch = async () => {
    if (!activeNovelId || !searchQ.trim()) return;
    const data = await api.get<{ results: SearchHit[] }>(`/novels/${activeNovelId}/search?q=${encodeURIComponent(searchQ)}`);
    setHits(data.results);
  };

  const createChapter = async () => {
    if (!activeNovelId || !chapterModal) return;
    const created = await api.post<Chapter>(`/novels/${activeNovelId}/chapters`, { title: chapterModal.name.trim() || "New Chapter" });
    setChapters((cs) => [...cs, { ...created }]);
    setActiveId(created.id);
    setChapterModal(null);
  };

  const renameChapter = async () => {
    if (!activeId || !chapterModal) return;
    const updated = await api.put<Chapter>(`/chapters/${activeId}`, { title: chapterModal.name.trim() });
    setChapter(updated);
    setChapters((cs) => cs.map((c) => (c.id === activeId ? { ...c, title: updated.title } : c)));
    setChapterModal(null);
  };

  const deleteChapter = async (id: number) => {
    const target = chapters.find((c) => c.id === id);
    if (!confirm(`Delete "${target?.title}"? Its history goes with it.`)) return;
    await api.del(`/chapters/${id}`);
    const rest = chapters.filter((c) => c.id !== id);
    setChapters(rest);
    if (activeId === id) {
      // Don't leave the deleted chapter open: jump to the first remaining one.
      setActiveId(rest[0]?.id ?? null);
      setChapter(null);
      setWords(0);
    }
  };

  const moveChapter = async (id: number, dir: -1 | 1) => {
    const idx = chapters.findIndex((c) => c.id === id);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= chapters.length) return;
    const ids = chapters.map((c) => c.id);
    [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
    const ordered = await api.put<ChapterMeta[]>(`/novels/${activeNovelId}/chapters/reorder`, { ids });
    setChapters(ordered);
  };

  const setStatus = async (status: string) => {
    if (!activeId) return;
    await persist({ status: status as Chapter["status"] });
  };

  if (!activeNovelId) {
    return (
      <Empty title="No novel selected">
        Pick a project on the <a className="text-loom-500 underline" href="/novels">My Novels</a> page, or create one there, then return here to write.
      </Empty>
    );
  }

  const novel = chapters.length ? chapters[0] : null; // title fetched loosely; sidebar lists chapters
  void novel;

  const sidebarButton = (c: ChapterMeta, i: number) => (
    <div key={c.id} className={`group flex items-center gap-1 rounded-md px-2 py-1.5 ${activeId === c.id ? "bg-ink-800" : "hover:bg-ink-850"}`}>
      <button
        onClick={() => setActiveId(c.id)}
        className="flex-1 text-left min-w-0"
      >
        <div className="text-sm truncate">{c.title}</div>
        <div className="text-[10px] text-ink-400">{c.wordCount} words</div>
      </button>
      <div className="opacity-0 group-hover:opacity-100 flex flex-col leading-none">
        <button className="text-ink-400 hover:text-ink-200 text-[9px]" onClick={() => moveChapter(c.id, -1)}>▲</button>
        <button className="text-ink-400 hover:text-ink-200 text-[9px]" onClick={() => moveChapter(c.id, 1)}>▼</button>
      </div>
      <button className="text-ink-700 hover:text-red-400 hidden group-hover:block ml-1 text-xs" onClick={() => deleteChapter(c.id)}>×</button>
      <span className="text-[9px] text-ink-700 w-3 text-right">{i + 1}</span>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Chapter rail */}
      <aside className="w-60 shrink-0 border-r border-ink-800 bg-ink-900 flex flex-col">
        <div className="p-3 border-b border-ink-800 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-ink-400">Chapters</span>
          <Button onClick={() => setChapterModal({ mode: "new", name: "New Chapter" })} variant="subtle">+</Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">{chapters.map((c, i) => sidebarButton(c, i))}</div>
        <div className="p-3 border-t border-ink-800 flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-ink-400">
            <span>{saveState === "saved" ? "All changes saved" : saveState === "saving" ? (<span className="flex items-center gap-1"><Spinner /> saving…</span>) : saveState === "error" ? "Save failed" : "Unsaved edits"}</span>
            <span>{words.toLocaleString()} w</span>
          </div>
          <div className="flex gap-1 flex-wrap">
            <Button onClick={() => setShowSearch(true)}>Find</Button>
            <Button onClick={() => setShowVersions(!showVersions)}>History</Button>
            <Button onClick={() => setShowNotes(!showNotes)}>Notes</Button>
          </div>
        </div>
      </aside>

      {/* Editor column */}
      <section className="flex-1 flex flex-col min-w-0">
        {chapter ? (
          <>
            <header className="flex items-center justify-between px-6 h-12 border-b border-ink-800">
              <div className="flex items-center gap-3 min-w-0">
                <button className="font-serif text-lg truncate hover:text-loom-500" onClick={() => setChapterModal({ mode: "rename", name: chapter.title })}>
                  {chapter.title}
                </button>
                <Tag tone={STATUS_TONES[chapter.status]}>{chapter.status}</Tag>
              </div>
              <div className="flex items-center gap-2">
                {(["draft", "revision", "completed"] as const).map((s) => (
                  <button key={s} onClick={() => setStatus(s)} className={`text-xs px-2 py-1 rounded border ${chapter.status === s ? "border-loom-500 text-loom-500" : "border-ink-700 text-ink-400 hover:text-ink-200"}`}>
                    {s}
                  </button>
                ))}
                <Button variant="primary" onClick={saveVersion}>Save version</Button>
              </div>
            </header>
            {error && (
              <div className="px-6 py-2 bg-red-950/40 text-red-300 text-sm">{error}</div>
            )}
            <div className="flex-1 overflow-y-auto" style={{ background: "var(--color-ink-950)" }}>
              <div ref={setEditorNode} style={{ maxWidth: prefs?.ui.editorWidth ?? 720, margin: "0 auto" }} />
            </div>
          </>
        ) : (
          <Empty title={chapters.length ? "Select a chapter" : "No chapters yet"}>
            {chapters.length ? "Choose a chapter on the left." : 'Create a chapter with the "+" button to start writing.'}
          </Empty>
        )}
      </section>

      {/* Notes drawer */}
      {showNotes && chapter && (
        <aside className="w-72 shrink-0 border-l border-ink-800 bg-ink-900 flex flex-col">
          <div className="p-3 border-b border-ink-800 flex justify-between items-center">
            <span className="text-xs uppercase tracking-wider text-ink-400">Chapter notes</span>
            <button className="text-ink-400 hover:text-ink-200" onClick={() => setShowNotes(false)}>×</button>
          </div>
          <div className="p-3 flex-1 flex flex-col gap-3">
            <TextArea
              rows={8}
              value={chapter.notes}
              placeholder="Working notes for this chapter: what must happen, what to avoid…"
              onChange={(e) => setChapter({ ...chapter, notes: e.target.value })}
            />
            <Button variant="primary" onClick={() => persist({ notes: chapter.notes })}>Save notes</Button>
          </div>
        </aside>
      )}

      {/* Versions drawer */}
      {showVersions && (
        <aside className="w-72 shrink-0 border-l border-ink-800 bg-ink-900 flex flex-col">
          <div className="p-3 border-b border-ink-800 flex justify-between items-center">
            <span className="text-xs uppercase tracking-wider text-ink-400">Revision history</span>
            <button className="text-ink-400 hover:text-ink-200" onClick={() => setShowVersions(false)}>×</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
            {(versions ?? []).map((v) => (
              <Card key={v.id} className="p-3">
                <div className="text-xs text-ink-400">{v.createdAt} · {v.source}</div>
                <div className="flex gap-2 mt-2">
                  <Button onClick={() => restoreVersion(v.id)}>Restore</Button>
                  <Button variant="subtle" onClick={() => showVersionDiff(v)}>Diff</Button>
                </div>
              </Card>
            ))}
            {versions && versions.length === 0 && <p className="text-xs text-ink-400">No snapshots yet. They accrue as you write and before manual edits.</p>}
          </div>
        </aside>
      )}

      {/* AI panel */}
      {aiOpen && chapter && (
        <aside className="w-80 shrink-0 border-l border-ink-800 bg-ink-900 flex flex-col">
          <div className="p-3 border-b border-ink-800 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-ink-400">Writing assistant</span>
            <div className="flex items-center gap-2">
              {aiModel && <span className="text-[10px] text-ink-400">{aiModel}</span>}
              <button className="text-ink-400 hover:text-ink-200" onClick={() => setAiOpen(false)}>×</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-1.5">
              {WRITING_ACTIONS.map((a) => (
                <button
                  key={a.mode}
                  onClick={() => setAiMode(a.mode)}
                  title={a.blurb}
                  className={`text-left text-[11px] px-2 py-1.5 rounded border ${aiMode === a.mode ? "border-loom-500 text-loom-500" : "border-ink-750 text-ink-300 hover:border-ink-400"}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-ink-400">{WRITING_ACTIONS.find((a) => a.mode === aiMode)?.blurb}.</p>
            <div>
              <Label>Instructions / brief</Label>
              <TextArea
                rows={5}
                value={aiInstructions}
                onChange={(e) => setAiInstructions(e.target.value)}
                placeholder={"e.g. Prior claims the tower is watching him; keep the mood uneasy; end on Adda's realization."}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-400">
              <input type="checkbox" checked={aiSelection} onChange={(e) => setAiSelection(e.target.checked)} />
              Use selected text when there is one
            </label>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => runAi(aiMode)} disabled={aiBusy}>
                {aiBusy ? <> <Spinner /> Writing…</> : "Generate"}
              </Button>
              {aiBusy && (
                <Button variant="danger" onClick={() => abortRef.current?.abort()}>Cancel</Button>
              )}
            </div>
            {aiOutput && (
              <Card className="p-3">
                <div className="prose-stream text-sm whitespace-pre-wrap font-editor leading-relaxed">{aiOutput}</div>
                {!aiBusy && (
                  <div className="flex gap-2 mt-3">
                    <Button variant="primary" onClick={() => insertAtCursor(aiOutput)}>Insert</Button>
                    <Button onClick={() => replaceSelectionOrChapter(aiOutput)}>Replace</Button>
                    <Button variant="subtle" onClick={() => navigator.clipboard.writeText(aiOutput)}>Copy</Button>
                    <Button variant="subtle" onClick={() => setAiOutput("")}>Discard</Button>
                  </div>
                )}
              </Card>
            )}
            {aiOutput && aiBusy && (
              <p className="text-[11px] text-ink-400">Streaming from your local model… you can cancel at any time.</p>
            )}
            {aiFromSelection && aiOutput && !aiBusy && (
              <p className="text-[11px] text-ink-400">Generated from your selection. “Insert” places it after the selection; “Replace” swaps them.</p>
            )}
            {/* Fix & polish: grammar, better sentences, stronger wording… */}
            <div className="border-t border-ink-750 pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider text-ink-400">Fix &amp; polish</span>
                <span className="text-[10px] text-ink-400">{aiSelection ? "selection when active, else chapter" : "whole chapter"}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {POLISH_MODES.map((m) => (
                  <button
                    key={m.key}
                    title={m.blurb}
                    onClick={() =>
                      setPolishModes((ms) => (ms.includes(m.key) ? ms.filter((x) => x !== m.key) : [...ms, m.key]))
                    }
                    className={`text-[10px] px-2 py-1 rounded border ${
                      polishModes.includes(m.key)
                        ? "border-loom-500 text-loom-500"
                        : "border-ink-750 text-ink-300 hover:border-ink-400"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <Button variant="primary" onClick={runPolish} disabled={polishBusy || aiBusy}>
                {polishBusy ? <><Spinner /> Checking…</> : "Check grammar & sentences"}
              </Button>
              {polishError && <p className="text-[11px] text-red-400">{polishError}</p>}
              {polish && (
                <Card className="p-3 space-y-2">
                  <div className="text-[11px] text-ink-400">
                    {polish.changes.length === 0
                      ? "No problems found — this already reads clean."
                      : `${polish.changes.length} suggestion${polish.changes.length === 1 ? "" : "s"}`}
                    {" · "}{polish.model} · {polishFromSelection ? "your selection" : "whole chapter"}
                  </div>
                  {polish.changes.slice(0, 12).map((c, i) => (
                    <div key={i} className="text-[11px] leading-snug border-l-2 border-ink-700 pl-2">
                      <span className="text-ink-400 uppercase tracking-wide text-[9px]">{c.type}</span>
                      <div className="text-red-300/80 line-through">{c.original.slice(0, 160)}</div>
                      <div className="text-green-300">{c.suggestion.slice(0, 160)}</div>
                      {c.note && <div className="text-ink-400">{c.note}</div>}
                    </div>
                  ))}
                  {polish.changes.length > 12 && (
                    <div className="text-[10px] text-ink-400">
                      …and {polish.changes.length - 12} more change{polish.changes.length - 12 === 1 ? "" : "s"} — applying uses the full corrected text.
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    {/* Apply only when the model listed concrete changes, so a
                        cleaned-up no-op can never rewrite the chapter. */}
                    {polish.changes.length > 0 && (
                      <Button variant="primary" onClick={applyPolish} disabled={!polish.revised.trim()}>
                        {polishFromSelection ? "Replace selection" : "Apply & save"}
                      </Button>
                    )}
                    <Button variant="subtle" onClick={() => navigator.clipboard.writeText(polish.revised)}>Copy</Button>
                    <Button variant="subtle" onClick={() => setPolish(null)}>Discard</Button>
                  </div>
                  <p className="text-[10px] text-ink-400">A snapshot of the current text is saved first, so Apply is reversible from History.</p>
                </Card>
              )}
            </div>
            <div className="border-t border-ink-750 pt-2">
              <button
                className="flex items-center justify-between w-full text-[11px] uppercase tracking-wider text-ink-400 hover:text-ink-300"
                onClick={() => setShowDrafts((s) => !s)}
              >
                <span>Recent drafts ({drafts.length})</span>
                <span>{showDrafts ? "▾" : "▸"}</span>
              </button>
              {showDrafts && (
                <div className="mt-2 space-y-1.5 max-h-56 overflow-y-auto">
                  {drafts.length === 0 && (
                    <p className="text-[11px] text-ink-400">Every generation is saved here while it streams — recoverable even if the tab crashes.</p>
                  )}
                  {drafts.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 text-xs group">
                      <span className="flex-1 truncate text-ink-300" title={d.text.slice(0, 200)}>
                        {d.task} · {d.text.length.toLocaleString()} chars · {new Date(d.updatedAt + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <Button
                        variant="subtle"
                        onClick={() => {
                          setAiOutput(d.text);
                          setShowDrafts(false);
                        }}
                      >
                        Restore
                      </Button>
                      <Button
                        variant="subtle"
                        onClick={async () => {
                          await api.del(`/ai/drafts/${activeNovelId}/${d.id}`);
                          loadDrafts();
                        }}
                        title="Delete draft"
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>
      )}

      {aiOpen === false && (
        <button
          className="fixed right-4 bottom-4 z-20 bg-loom-500 text-ink-950 rounded-full px-4 py-2 text-sm shadow-lg"
          onClick={() => setAiOpen(true)}
        >
          AI ✦
        </button>
      )}

      {/* Search modal */}
      <Modal open={showSearch} onClose={() => setShowSearch(false)} title="Find across chapters" wide>
        <div className="flex gap-2">
          <Input className="flex-1" autoFocus value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search text or notes…" />
          <Button variant="primary" onClick={runSearch}>Search</Button>
        </div>
        <div className="mt-4 flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
          {hits?.map((h) => (
            <Card key={`${h.chapterId}-${h.excerpt}`} className="p-3">
              <button className="text-sm text-loom-500" onClick={() => { setActiveId(h.chapterId); setShowSearch(false); }}>
                {h.chapterTitle}
              </button>
              <p className="text-xs text-ink-400 mt-1">{h.excerpt || "(in notes)"}</p>
            </Card>
          ))}
          {hits && hits.length === 0 && <p className="text-sm text-ink-400">No matches.</p>}
        </div>
      </Modal>

      {/* Chapter dialog */}
      <Modal open={chapterModal != null} onClose={() => setChapterModal(null)} title={chapterModal?.mode === "new" ? "New chapter" : "Rename chapter"}>
        <Label>Title</Label>
        <Input
          autoFocus
          value={chapterModal?.name ?? ""}
          onChange={(e) => setChapterModal((m) => (m ? { ...m, name: e.target.value } : m))}
          onKeyDown={(e) => e.key === "Enter" && (chapterModal?.mode === "new" ? createChapter() : renameChapter())}
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button onClick={() => setChapterModal(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => (chapterModal?.mode === "new" ? createChapter() : renameChapter())}>
            {chapterModal?.mode === "new" ? "Create" : "Save"}
          </Button>
        </div>
      </Modal>

      {/* Version diff */}
      <Modal
        open={diffView != null}
        onClose={() => setDiffView(null)}
        title={`Diff: snapshot ${diffView?.meta.createdAt.slice(0, 16).replace("T", " ") ?? ""} → current draft`}
        wide
      >
        {diffView && (() => {
          const { added, removed } = diffStats(diffView.lines);
          return (
            <div>
              <p className="text-xs text-ink-400 mb-2">
                <span className="text-green-500">+{added} added</span> · <span className="text-red-500">−{removed} removed</span> · unchanged lines are dim. Reading order top to bottom.
              </p>
              <div className="max-h-[60vh] overflow-y-auto font-mono text-[12px] leading-relaxed border border-ink-750 rounded bg-ink-950">
                {diffView.lines.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.type === "add"
                        ? "bg-green-950/50 text-green-200 px-2"
                        : l.type === "del"
                          ? "bg-red-950/50 text-red-200 px-2 whitespace-pre-wrap"
                          : "text-ink-500 px-2 whitespace-pre-wrap"
                    }
                  >
                    {l.type !== "same" && <span className="select-none opacity-60">{l.type === "add" ? "+ " : "− "}</span>}
                    {l.text || (l.type === "same" ? "" : "␍")}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
};
