import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, type MemoryHit, type MemoryItem } from "../api.js";
import { Button, Card, Empty, Input, Label, useAppState } from "../ui.js";

const BUCKETS: { key: MemoryItem["bucket"]; label: string; hint: string; tone: string }[] = [
  { key: "canon", label: "Confirmed Canon", hint: "Hard facts the AI must respect", tone: "green" },
  { key: "provisional", label: "Temporary Notes", hint: "Working beliefs, not yet canon", tone: "gold" },
  { key: "ai_suggestion", label: "AI Suggestions", hint: "Extracted facts, awaiting your review", tone: "amber" },
  { key: "question", label: "Unresolved Questions", hint: "Open threads and mysteries", tone: "blue" },
  { key: "rejected", label: "Rejected Ideas", hint: "Reviewed and declined", tone: "red" },
];

export const Memory: React.FC = () => {
  const { activeNovelId } = useAppState();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [tab, setTab] = useState<MemoryItem["bucket"]>("canon");
  const [newText, setNewText] = useState("");
  const [query, setQuery] = useState("");
  const [semResults, setSemResults] = useState<MemoryHit[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!activeNovelId) return;
    api
      .get<MemoryItem[]>(`/novels/${activeNovelId}/memory`)
      .then(setItems)
      .catch((e) => setError(e.message));
  }, [activeNovelId]);
  useEffect(load, [load]);
  useEffect(() => {
    setSemResults(null);
    setTab("canon");
  }, [activeNovelId]);

  const inTab = useMemo(() => items.filter((i) => i.bucket === tab), [items, tab]);

  const setBucket = async (id: number, bucket: MemoryItem["bucket"], items2: MemoryItem[] = items) => {
    const item = items2.find((i) => i.id === id);
    if (!item) return;
    await api.put(`/novels/${activeNovelId}/memory/${id}`, { bucket });
    load();
  };

  const bulk = async (action: "approve" | "reject" | "delete") => {
    const ids = inTab.map((i) => i.id);
    if (!ids.length) return;
    await api.post(`/novels/${activeNovelId}/memory/bulk`, { ids, action });
    load();
  };

  const add = async () => {
    if (!newText.trim()) return;
    await api.post(`/novels/${activeNovelId}/memory`, {
      text: newText.trim(),
      bucket: tab === "rejected" ? "provisional" : tab,
      source: "author",
    });
    setNewText("");
    load();
  };

  const semanticSearch = async () => {
    if (!query.trim()) return;
    const data = await api.post<{ results: MemoryHit[] }>("/ai/memory-search", { novelId: activeNovelId, query });
    setSemResults(data.results);
  };

  if (!activeNovelId)
    return (
      <Empty title="No novel selected">
        Pick a project in <b>My Novels</b> first.
      </Empty>
    );

  return (
    <div className="max-w-6xl mx-auto p-8 flex flex-col h-full min-h-0">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-serif text-2xl">Story Memory</h1>
          <p className="text-xs text-ink-400 mt-1">
            Only items you move into <b>Confirmed Canon</b> harden into rules the AI must obey. AI suggestions never promote themselves.
          </p>
        </div>
        <Button
          onClick={async () => {
            await api.post("/ai/reindex", { novelId: activeNovelId });
            setError("");
            load();
          }}
        >
          Rebuild semantic index
        </Button>
      </header>
      {error && <div className="mb-3 px-3 py-2 bg-red-950/40 text-red-300 text-sm rounded">{error}</div>}

      <div className="flex gap-2 mb-4 flex-wrap">
        {BUCKETS.map((b) => {
          const n = items.filter((i) => i.bucket === b.key).length;
          return (
            <button
              key={b.key}
              onClick={() => setTab(b.key)}
              className={`px-3 py-1.5 rounded-md border text-sm flex items-center gap-2 ${tab === b.key ? "border-loom-500 text-loom-500" : "border-ink-750 text-ink-300 hover:border-ink-400"}`}
            >
              {b.label}
              <span className="text-[10px] bg-ink-800 rounded-full px-1.5 py-0.5">{n}</span>
            </button>
          );
        })}
      </div>

      <Card className="p-3 mb-4">
        <p className="text-[11px] text-ink-400 mb-2">{BUCKETS.find((b) => b.key === tab)?.hint}.</p>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder={`Add a ${tab === "canon" ? "confirmed fact" : "note"}…`}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Button variant="primary" onClick={add}>
            Add
          </Button>
        </div>
      </Card>

      <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-1">
        {inTab.length === 0 && (
          <p className="text-sm text-ink-400 text-center py-8">
            Nothing in this bucket. Chapter analysis (Editor → Analyze) fills “AI Suggestions” for you to review.
          </p>
        )}
        {inTab.map((i) => (
          <Card key={i.id} className="p-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {i.source === "ai" && <span className="text-[10px] text-amber-300 border border-amber-700/50 rounded px-1.5">AI</span>}
                {i.category && <span className="text-[10px] text-ink-400">{i.category}</span>}
                {i.chapterId && <span className="text-[10px] text-ink-400">chapter #{i.chapterId}</span>}
                {i.decidedAt && <span className="text-[10px] text-ink-700">{i.decidedAt}</span>}
              </div>
              <EditableText
                key={i.text}
                text={i.text}
                onSave={async (t) => {
                  await api.put(`/novels/${activeNovelId}/memory/${i.id}`, { text: t });
                  load();
                }}
              />
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              {i.bucket === "ai_suggestion" && (
                <>
                  <Button variant="primary" onClick={() => setBucket(i.id, "canon")}>
                    Approve
                  </Button>
                  <Button onClick={() => setBucket(i.id, "provisional")}>Not sure</Button>
                  <Button variant="danger" onClick={() => setBucket(i.id, "rejected")}>
                    Reject
                  </Button>
                </>
              )}
              {i.bucket === "provisional" && (
                <Button variant="primary" onClick={() => setBucket(i.id, "canon")}>
                  Promote to canon
                </Button>
              )}
              {i.bucket === "canon" && <Button onClick={() => setBucket(i.id, "provisional")}>Demote</Button>}
              {(i.bucket === "question" || i.bucket === "rejected") && (
                <>
                  <Button onClick={() => setBucket(i.id, "canon")}>Promote to canon</Button>
                  {i.bucket === "question" && (
                    <Button variant="danger" onClick={() => setBucket(i.id, "rejected")}>
                      Reject
                    </Button>
                  )}
                </>
              )}
              <Button
                variant="subtle"
                onClick={async () => {
                  await api.del(`/novels/${activeNovelId}/memory/${i.id}`);
                  load();
                }}
              >
                Delete
              </Button>
            </div>
          </Card>
        ))}
        {tab === "ai_suggestion" && inTab.length > 1 && (
          <div className="flex gap-2 justify-end">
            <Button variant="primary" onClick={() => bulk("approve")}>
              Approve all
            </Button>
            <Button variant="danger" onClick={() => bulk("reject")}>
              Reject all
            </Button>
          </div>
        )}
      </div>

      {/* semantic recall tester */}
      <Card className="p-3 mt-3">
        <Label>Semantic recall test</Label>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "what is known about the eastern vault?"'
            onKeyDown={(e) => e.key === "Enter" && semanticSearch()}
          />
          <Button onClick={semanticSearch}>Recall</Button>
        </div>
        {semResults && (
          <div className="mt-2 flex flex-col gap-1">
            {semResults.length === 0 && <p className="text-xs text-ink-400">No relevant memory retrieved.</p>}
            {semResults.map((r, idx) => (
              <div key={idx} className="text-xs text-ink-300 flex gap-2">
                <span className="text-loom-500 w-12">{(r.score * 100).toFixed(0)}%</span>
                <span className="text-ink-400 w-16">{r.kind}</span>
                <span className="truncate">{r.text.slice(0, 160)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

const EditableText: React.FC<{ text: string; onSave: (text: string) => Promise<void> }> = ({ text, onSave }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  return editing ? (
    <div className="flex gap-2">
      <Input
        className="flex-1"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setEditing(false);
            onSave(value);
          }
        }}
      />
      <Button
        variant="primary"
        onClick={() => {
          setEditing(false);
          onSave(value);
        }}
      >
        ✓
      </Button>
    </div>
  ) : (
    <p className="text-sm cursor-text" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
      {value}
    </p>
  );
};

void Empty;
