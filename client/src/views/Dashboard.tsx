import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Button, Card, Empty, Tag, useAppState } from "../ui.js";

interface Dash {
  novels: { id: number; title: string; genre: string; chapterCount: number; wordCount: number; targetWords: number; updatedAt: string }[];
  recentChapters: { id: number; title: string; novel_id: number; novel_title: string; word_count: number; status: string; updated_at: string }[];
  stats: { totalWords: number; totalChapters: number; novelCount: number; characterCount: number; pendingSuggestions: number; openQuestions: number };
  recentNotes: { id: number; title: string; notes: string; novel_title: string }[];
  recentActivity: { task: string; model: string | null; ok: number; created_at: string; detail: string }[];
}

export const Dashboard: React.FC = () => {
  const { activeNovelId, setActiveNovel } = useAppState();
  const [dash, setDash] = useState<Dash | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    api
      .get<Dash>("/dashboard")
      .then(setDash)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (error) return <Empty title="Server unreachable">{error}</Empty>;
  if (!dash) return <div className="p-10 text-ink-400 text-sm">Looming…</div>;

  const hasProjects = dash.novels.length > 0;

  return (
    <div className="max-w-6xl mx-auto p-8">
      <header className="flex items-end justify-between mb-8">
        <div>
          <h1 className="font-serif text-3xl">The Writing Desk</h1>
          <p className="text-ink-400 text-sm mt-1">Your novels, threads and progress — all local.</p>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: "Novels", value: dash.stats.novelCount },
          { label: "Chapters", value: dash.stats.totalChapters },
          { label: "Words written", value: dash.stats.totalWords.toLocaleString() },
          { label: "Characters", value: dash.stats.characterCount },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <div className="text-2xl font-serif text-loom-500">{s.value}</div>
            <div className="text-xs text-ink-400 mt-1">{s.label}</div>
          </Card>
        ))}
      </div>

      {dash.stats.pendingSuggestions > 0 && (
        <Card className="p-4 mb-8 border-loom-600/50">
          <span className="text-sm">
            <Tag tone="amber">{dash.stats.pendingSuggestions} AI suggestions</Tag> are waiting in Story Memory for your review.{" "}
            <a className="text-loom-500 underline" href="/memory">Review them</a>
          </span>
        </Card>
      )}

      {!hasProjects ? (
        <Empty title="No novels yet">
          Create your first novel in <b>My Novels</b>, then open the <b>Chapter Editor</b> to start writing. The AI waits
          for you in <b>AI Assistant</b>.
        </Empty>
      ) : (
        <div className="grid md:grid-cols-3 gap-6">
          <section className="md:col-span-2">
            <h2 className="text-sm uppercase tracking-wider text-ink-400 mb-3">Recent projects</h2>
            <div className="flex flex-col gap-3">
              {dash.novels.map((n) => (
                <Card key={n.id} className="p-4 flex items-center justify-between hover:border-loom-600/50 cursor-pointer" onClick={() => setActiveNovel(n.id)}>
                  <div>
                    <div className="font-serif text-lg">{n.title}</div>
                    <div className="text-xs text-ink-400">
                      {n.genre || "unfiled"} · {n.chapterCount} chapters · {n.wordCount.toLocaleString()} words
                      {n.targetWords > 0 ? ` of ${n.targetWords.toLocaleString()}` : ""}
                    </div>
                  </div>
                  <a href="/editor" onClick={(e) => { e.stopPropagation(); setActiveNovel(n.id); }} className="text-sm text-loom-500 hover:underline">
                    Edit →
                  </a>
                </Card>
              ))}
            </div>
          </section>
          <section>
            <h2 className="text-sm uppercase tracking-wider text-ink-400 mb-3">Recently edited chapters</h2>
            <div className="flex flex-col gap-2 mb-6">
              {dash.recentChapters.map((c) => (
                <Card key={c.id} className="p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">{c.title}</span>
                    <span className="text-[11px] text-ink-400">{c.word_count} w</span>
                  </div>
                  <div className="text-[11px] text-ink-400 mt-0.5">{c.novel_title} · {c.status}</div>
                </Card>
              ))}
            </div>
            <h2 className="text-sm uppercase tracking-wider text-ink-400 mb-3">Recent notes</h2>
            <div className="flex flex-col gap-2">
              {dash.recentNotes.length === 0 && <p className="text-xs text-ink-400">No chapter notes yet.</p>}
              {dash.recentNotes.map((c) => (
                <Card key={c.id} className="p-3">
                  <div className="text-sm">{c.title}</div>
                  <p className="text-[11px] text-ink-400 mt-1 line-clamp-2">{c.notes}</p>
                </Card>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
