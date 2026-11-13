import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, type WorldEntry } from "../api.js";
import { Button, Card, Empty, Input, Label, Modal, TextArea, useAppState } from "../ui.js";

export const WORLD_CATEGORIES = [
  "Region / Country",
  "City / Location",
  "Historical Event",
  "Organization",
  "Culture / Society",
  "Technology",
  "Magic / Supernatural System",
  "Science",
  "Rule / Limitation",
  "Mystery",
  "Historical Record",
] as const;

export const World: React.FC = () => {
  const { activeNovelId } = useAppState();
  const [entries, setEntries] = useState<WorldEntry[]>([]);
  const [selected, setSelected] = useState<WorldEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ category: string; title: string; body: string }>({
    category: WORLD_CATEGORIES[0] as string,
    title: "",
    body: "",
  });
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!activeNovelId) return;
    api
      .get<WorldEntry[]>(`/novels/${activeNovelId}/world`)
      .then(setEntries)
      .catch((e) => setError(e.message));
  }, [activeNovelId]);
  useEffect(load, [load]);
  useEffect(() => setSelected(null), [activeNovelId]);

  const grouped = useMemo(() => {
    const g: Record<string, WorldEntry[]> = {};
    for (const e of entries) (g[e.category] ??= []).push(e);
    return g;
  }, [entries]);

  const save = async () => {
    if (!selected) return;
    const updated = await api.put<WorldEntry>(`/novels/${activeNovelId}/world/${selected.id}`, selected);
    setEntries((es) => es.map((e) => (e.id === updated.id ? updated : e)));
    setSelected(updated);
  };

  const remove = async () => {
    if (!selected) return;
    if (!confirm(`Delete world entry "${selected.title}"?`)) return;
    await api.del(`/novels/${activeNovelId}/world/${selected.id}`);
    setSelected(null);
    load();
  };

  const create = async () => {
    if (!form.title.trim()) return;
    const created = await api.post<WorldEntry>(`/novels/${activeNovelId}/world`, form);
    setCreating(false);
    setForm({ category: WORLD_CATEGORIES[0], title: "", body: "" });
    load();
    setSelected(created);
  };

  if (!activeNovelId)
    return (
      <Empty title="No novel selected">
        Pick a project in <b>My Novels</b> first.
      </Empty>
    );

  return (
    <div className="max-w-6xl mx-auto p-8 flex gap-6 h-full min-h-0">
      <aside className="w-72 shrink-0 overflow-y-auto">
        <header className="flex items-center justify-between mb-3">
          <h1 className="font-serif text-xl">Worldbuilding</h1>
          <Button variant="primary" onClick={() => setCreating(true)}>
            +
          </Button>
        </header>
        {error && <p className="mb-3 text-[11px] text-red-300 border border-red-900/60 rounded-md px-3 py-2">{error}</p>}
        {entries.length === 0 && (
          <p className="text-xs text-ink-400">
            Nothing yet. Define regions, factions, rules and mysteries — the AI borrows them when writing your scenes and checks continuity
            against them.
          </p>
        )}
        {Object.entries(grouped).map(([cat, list]) => (
          <div key={cat} className="mb-4">
            <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">{cat}</div>
            <div className="flex flex-col gap-1">
              {list.map((e) => (
                <button
                  key={e.id}
                  onClick={() => setSelected(e)}
                  className={`text-left text-sm rounded px-3 py-1.5 border ${selected?.id === e.id ? "border-loom-500 bg-ink-850" : "border-transparent hover:border-ink-700 bg-ink-900"}`}
                >
                  {e.title}
                </button>
              ))}
            </div>
          </div>
        ))}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        {selected ? (
          <>
            <header className="flex items-center justify-between mb-4">
              <h2 className="font-serif text-2xl">{selected.title}</h2>
              <div className="flex gap-2">
                <Button variant="primary" onClick={save}>
                  Save
                </Button>
                <Button variant="danger" onClick={remove}>
                  Delete
                </Button>
              </div>
            </header>
            <Card className="p-5 flex-1 flex flex-col gap-4 overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Title</Label>
                  <Input value={selected.title} onChange={(e) => setSelected({ ...selected, title: e.target.value })} />
                </div>
                <div>
                  <Label>Category</Label>
                  <select
                    className="w-full bg-ink-850 border border-ink-700 rounded-md px-3 py-2 text-sm"
                    value={selected.category}
                    onChange={(e) => setSelected({ ...selected, category: e.target.value })}
                  >
                    {WORLD_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <Label>Description / rules / history</Label>
                <TextArea rows={14} value={selected.body} onChange={(e) => setSelected({ ...selected, body: e.target.value })} />
              </div>
              <p className="text-[11px] text-ink-400">
                Store world rules and limitations precisely — the continuity checker compares your chapters against this text.
              </p>
            </Card>
          </>
        ) : (
          <Empty title="Select an entry">
            Or create the first: a place, a faction, a rule of your world. The AI weaves them into scenes when they're relevant.
          </Empty>
        )}
      </section>

      <Modal open={creating} onClose={() => setCreating(false)} title="New world entry">
        <Label>Category</Label>
        <select
          className="w-full bg-ink-850 border border-ink-700 rounded-md px-3 py-2 text-sm mb-3"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        >
          {WORLD_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <Label>Title</Label>
        <Input
          autoFocus
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button onClick={() => setCreating(false)}>Cancel</Button>
          <Button variant="primary" onClick={create}>
            Create
          </Button>
        </div>
      </Modal>
    </div>
  );
};
