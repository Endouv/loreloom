import React, { useEffect, useRef, useState } from "react";
import { api, countWords, streamSse, type ProjectOverview } from "../api.js";
import { Button, Card, Empty, Input, Label, Tag, TextArea, useAppState } from "../ui.js";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const BRAINSTORM_CATEGORIES = [
  { key: "plot", label: "Plot" },
  { key: "character", label: "Character" },
  { key: "scene", label: "Scene ideas" },
  { key: "dialogue", label: "Dialogue" },
  { key: "conflict", label: "Conflict" },
  { key: "mystery", label: "Mystery" },
  { key: "alternatives", label: "Directions" },
  { key: "chapterplan", label: "Chapter plan" },
];

export const Assistant: React.FC = () => {
  const { activeNovelId } = useAppState();
  const [tab, setTab] = useState<"chat" | "brainstorm">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [bsCategory, setBsCategory] = useState("plot");
  const [bsTopic, setBsTopic] = useState("");
  const [bsDeep, setBsDeep] = useState(true);
  const [bsOutput, setBsOutput] = useState("");
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [showOverview, setShowOverview] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadOverview = async () => {
    const o = await api.post<ProjectOverview>("/ai/project-overview", { novelId: activeNovelId });
    setOverview(o);
    setShowOverview(true);
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (!activeNovelId) {
    return (
      <Empty title="No novel selected">
        Choose a project in <b>My Novels</b> first — the assistant reads only that novel's memory.
      </Empty>
    );
  }

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const history: Msg[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setDraft("");
    setBusy(true);
    setError("");
    try {
      await streamSse(
        "/ai/assistant/chat",
        { novelId: activeNovelId, messages: history },
        {
          onStart: (e) => setModel(e.model ?? ""),
          onDelta: (t) =>
            setMessages((ms) => {
              const copy = [...ms];
              copy[copy.length - 1] = { role: "assistant", content: copy[copy.length - 1].content + t };
              return copy;
            }),
          onEvent: (type, e) => {
            if (type === "error") setError(e.message || "The assistant could not respond.");
            if (type === "cancelled") setMessages((ms) => (ms[ms.length - 1].content ? ms : ms.slice(0, -1)));
          },
        },
        controller.signal,
      );
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const brainstorm = async () => {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBsOutput("");
    setBusy(true);
    setError("");
    try {
      await streamSse(
        "/ai/brainstorm",
        { novelId: activeNovelId, category: bsCategory, topic: bsTopic, depth: bsDeep ? "deep" : "quick" },
        {
          onStart: (e) => setModel(e.model ?? ""),
          onDelta: (t) => setBsOutput((o) => o + t),
          onEvent: (type, e) => {
            if (type === "error") setError(e.message || "Brainstorm failed.");
          },
        },
        controller.signal,
      );
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const saveIdea = async (text: string) => {
    await api.post(`/novels/${activeNovelId}/memory`, { text, bucket: "provisional", source: "author", category: "idea" });
    setError("");
    setBsOutput(bsOutput + "\n\n(idea saved to Story Memory → Temporary Notes)");
  };

  return (
    <div className="max-w-4xl mx-auto p-8 flex flex-col h-full">
      <header className="flex items-center justify-between mb-4">
        <h1 className="font-serif text-2xl">AI Assistant</h1>
        <div className="flex gap-2">
          <Button onClick={() => setTab("chat")} className={tab === "chat" ? "text-loom-500 border-loom-500" : ""}>
            Chat
          </Button>
          <Button onClick={() => setTab("brainstorm")} className={tab === "brainstorm" ? "text-loom-500 border-loom-500" : ""}>
            Brainstorm
          </Button>
          <Button variant="subtle" onClick={loadOverview}>
            What the AI sees
          </Button>
        </div>
      </header>
      {model && (
        <p className="text-[11px] text-ink-400 mb-2">
          Model: {model} · local Ollama · sees your full project: story, cast, world, timeline and canon
        </p>
      )}
      {error && <div className="mb-3 px-3 py-2 bg-red-950/40 text-red-300 text-sm rounded">{error}</div>}
      {showOverview && overview && (
        <Card className="mb-3 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs uppercase tracking-wider text-ink-400">
              Full project view ({overview.stats.chapters} chapters · {overview.stats.characters} characters · {overview.stats.world} world
              entries · {overview.stats.memories} memory items · {overview.stats.chars.toLocaleString()} chars)
            </h3>
            <Button variant="subtle" onClick={() => setShowOverview(false)}>
              ×
            </Button>
          </div>
          <pre className="text-[11px] whitespace-pre-wrap max-h-72 overflow-y-auto text-ink-300 font-mono">{overview.text}</pre>
        </Card>
      )}

      {tab === "chat" ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto flex flex-col gap-3 mb-4 pr-1">
            {messages.length === 0 && (
              <Card className="p-4 text-sm text-ink-400">
                Ask anything about your story: “What's a stronger motivation for Vayel?”, “Recap where the investigation stands”, “Which
                characters know about the vault — and when did each find out?”. The assistant reads your entire project — every chapter, the
                full cast with their knowledge, worldbuilding, timeline and canon — directly from the database.
              </Card>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-loom-500/15 border border-loom-600/40" : "bg-ink-900 border border-ink-800"}`}
                >
                  {m.content || (busy && i === messages.length - 1 ? <span className="text-ink-400">writing…</span> : "")}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div className="flex gap-2 items-end">
            <TextArea
              className="flex-1"
              rows={2}
              value={draft}
              placeholder="Ask, plan, or request prose… (Enter to send, Shift+Enter for newline)"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={busy}
            />
            {busy ? (
              <Button variant="danger" onClick={() => abortRef.current?.abort()}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" onClick={send} disabled={!draft.trim()}>
                Send
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {BRAINSTORM_CATEGORIES.map((c) => (
              <button
                key={c.key}
                onClick={() => setBsCategory(c.key)}
                className={`px-2.5 py-1.5 rounded text-xs border ${bsCategory === c.key ? "border-loom-500 text-loom-500" : "border-ink-750 text-ink-300"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center mb-3">
            <Input
              className="flex-1"
              value={bsTopic}
              onChange={(e) => setBsTopic(e.target.value)}
              placeholder="Optional prompt: e.g. secrets the archive could hide"
            />
            <label className="flex items-center gap-1 text-xs text-ink-400">
              <input type="checkbox" checked={bsDeep} onChange={() => setBsDeep(!bsDeep)} /> deep
            </label>
            {busy ? (
              <Button variant="danger" onClick={() => abortRef.current?.abort()}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" onClick={brainstorm}>
                Brainstorm
              </Button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {bsOutput && (
              <Card className="p-4">
                <div className="prose-stream text-sm whitespace-pre-wrap leading-relaxed">{bsOutput}</div>
                {!busy && (
                  <div className="flex gap-2 mt-3">
                    <Button variant="primary" onClick={() => saveIdea(bsOutput)}>
                      Save to Temporary Notes
                    </Button>
                    <Button variant="subtle" onClick={() => navigator.clipboard.writeText(bsOutput)}>
                      Copy
                    </Button>
                  </div>
                )}
              </Card>
            )}
            {!bsOutput && !busy && (
              <Card className="p-4 text-sm text-ink-400">
                Brainstormed ideas stay suggestions: anything you like, save it to Temporary Notes and promote to Canon from Story Memory.
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

void Tag;
void Label;
void countWords;
