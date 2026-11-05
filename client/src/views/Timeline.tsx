import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Character, type TimelineEvent } from "../api.js";
import { Button, Card, Empty, Input, Label, Modal, Select, TextArea, useAppState } from "../ui.js";

const KINDS = ["event", "chapter", "arrival", "departure", "revelation", "aftermath"] as const;

export const Timeline: React.FC = () => {
  const { activeNovelId } = useAppState();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [editing, setEditing] = useState<TimelineEvent | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!activeNovelId) return;
    api.get<TimelineEvent[]>(`/novels/${activeNovelId}/timeline`).then(setEvents).catch((e) => setError(e.message));
    api.get<Character[]>(`/novels/${activeNovelId}/characters`).then(setCharacters).catch(() => {});
  }, [activeNovelId]);
  useEffect(load, [load]);
  useEffect(() => setEditing(null), [activeNovelId]);

  // Events sorted by story time; a gap in the order scale is rendered as a visible band.
  const ordered = useMemo(() => [...events].sort((a, b) => a.storyDateOrder - b.storyDateOrder), [events]);

  const createBlank = () => {
    const next = ordered.length ? ordered[ordered.length - 1].storyDateOrder + 10 : 0;
    setCreating(true);
    setEditing({
      id: 0,
      novelId: activeNovelId!,
      chapterId: null,
      title: "",
      description: "",
      storyDateLabel: "",
      storyDateOrder: next,
      kind: "event",
      characterIds: [],
    });
  };

  const save = async () => {
    if (!editing || !editing.title.trim()) return;
    if (editing.id) {
      await api.put(`/novels/${activeNovelId}/timeline/${editing.id}`, editing);
    } else {
      await api.post(`/novels/${activeNovelId}/timeline`, editing);
      setCreating(false);
    }
    setEditing(null);
    load();
  };

  const remove = async () => {
    if (!editing?.id) return;
    if (!confirm(`Delete "${editing.title}" from the timeline?`)) return;
    await api.del(`/novels/${activeNovelId}/timeline/${editing.id}`);
    setEditing(null);
    load();
  };

  const shiftOrder = async (e: TimelineEvent, dir: -1 | 1) => {
    const idx = ordered.findIndex((o) => o.id === e.id);
    const neighbor = ordered[idx + dir];
    if (!neighbor) {
      // moving beyond the ends still nudges the numeric order
      const newOrder = dir === -1 ? e.storyDateOrder - 10 : e.storyDateOrder + 10;
      await api.put(`/novels/${activeNovelId}/timeline/${e.id}`, { ...e, storyDateOrder: newOrder });
      load();
      return;
    }
    const mid = (e.storyDateOrder + neighbor.storyDateOrder) / 2;
    await api.put(`/novels/${activeNovelId}/timeline/${e.id}`, { storyDateOrder: mid });
    load();
  };

  if (!activeNovelId) return <Empty title="No novel selected">Pick a project in <b>My Novels</b> first.</Empty>;

  // Detect gaps > 25 on the numeric story-time scale between consecutive events.
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].storyDateOrder - ordered[i - 1].storyDateOrder > 25) gaps.push(i);
  }

  return (
    <div className="max-w-6xl mx-auto p-8 flex flex-col h-full min-h-0">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-serif text-2xl">Timeline</h1>
          <p className="text-xs text-ink-400 mt-1">Story-time order (▲▼ buttons move events). Events are manual — the AI only proposes, you place them.</p>
        </div>
        <Button variant="primary" onClick={createBlank}>+ Add event</Button>
      </header>
      {error && <div className="mb-3 px-3 py-2 bg-red-950/40 text-red-300 text-sm rounded">{error}</div>}

      <div className="flex-1 overflow-y-auto min-h-0">
        {ordered.length === 0 ? (
          <Empty title="No events yet">Add the pivotal moments of your story in order: births of rivalries, deaths, discoveries, chapters' key beats.</Empty>
        ) : (
          <div className="relative pl-6">
            <div className="absolute left-2 top-0 bottom-0 w-px bg-ink-700" />
            {ordered.map((e, i) => (
              <React.Fragment key={e.id}>
                {gaps.includes(i) && (
                  <div className="relative my-3 flex items-center">
                    <span className="absolute -left-4 text-ink-700">‖</span>
                    <div className="text-[11px] text-ink-400 border border-dashed border-ink-700 rounded px-3 py-1 ml-4">time gap</div>
                  </div>
                )}
                <div className="relative group py-2 flex items-center gap-3">
                  <span className="absolute -left-1.5 w-3 h-3 rounded-full bg-loom-500/80 ring-2 ring-ink-950" />
                  <div className="ml-4 flex-1">
                    <Card className="p-3 hover:border-loom-600/60 cursor-pointer" onClick={() => { setCreating(false); setEditing(e); }}>
                      <div className="flex items-center gap-2">
                        {e.storyDateLabel && <span className="text-[11px] text-loom-500 font-mono">{e.storyDateLabel}</span>}
                        <span className="text-[10px] text-ink-700">{e.kind}</span>
                        {e.chapterId && <span className="text-[10px] text-ink-400">cha #{e.chapterId}</span>}
                      </div>
                      <div className="text-sm font-medium mt-0.5">{e.title}</div>
                      {e.description && <p className="text-xs text-ink-400 mt-1 line-clamp-2">{e.description}</p>}
                      {e.characterIds.length > 0 && (
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {e.characterIds.map((cid) => {
                            const c = characters.find((x) => x.id === cid);
                            return <span key={cid} className="text-[10px] text-sky-300 border border-sky-800/60 rounded px-1.5">{c?.name ?? `#${cid}`}</span>;
                          })}
                        </div>
                      )}
                    </Card>
                  </div>
                  <div className="flex flex-col opacity-40 group-hover:opacity-100">
                    <button className="text-ink-400 hover:text-ink-200 text-xs" onClick={() => shiftOrder(e, -1)}>▲</button>
                    <button className="text-ink-400 hover:text-ink-200 text-xs" onClick={() => shiftOrder(e, 1)}>▼</button>
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>

      <Modal open={editing != null} onClose={() => setEditing(null)} title={creating ? "New event" : "Edit event"} wide>
        {editing && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Title</Label>
                <Input value={editing.title} onChange={(ev) => setEditing({ ...editing, title: ev.target.value })} />
              </div>
              <div>
                <Label>Story date label</Label>
                <Input value={editing.storyDateLabel} onChange={(ev) => setEditing({ ...editing, storyDateLabel: ev.target.value })} placeholder="Year 3, midwinter" />
              </div>
              <div>
                <Label>Story-time order (number)</Label>
                <Input type="number" step="any" value={editing.storyDateOrder} onChange={(ev) => setEditing({ ...editing, storyDateOrder: Number(ev.target.value) })} />
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <TextArea rows={3} value={editing.description} onChange={(ev) => setEditing({ ...editing, description: ev.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Kind</Label>
                <Select value={editing.kind} onChange={(ev) => setEditing({ ...editing, kind: ev.target.value })}>
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </Select>
              </div>
              <div>
                <Label>Link to chapter number (optional)</Label>
                <Input type="number" value={editing.chapterId ?? ""} onChange={(ev) => setEditing({ ...editing, chapterId: ev.target.value ? Number(ev.target.value) : null })} />
              </div>
            </div>
            <div>
              <Label>Characters involved</Label>
              <div className="flex flex-wrap gap-1.5">
                {characters.map((c) => {
                  const on = editing.characterIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => setEditing({ ...editing, characterIds: on ? editing.characterIds.filter((x) => x !== c.id) : [...editing.characterIds, c.id] })}
                      className={`text-xs px-2 py-1 rounded border ${on ? "border-loom-500 text-loom-500" : "border-ink-750 text-ink-400"}`}
                    >
                      {c.name}
                    </button>
                  );
                })}
                {characters.length === 0 && <span className="text-[11px] text-ink-400">Create characters first to tag events.</span>}
              </div>
            </div>
            <div className="flex justify-between mt-2">
              {!editing.id ? (
                <Button onClick={() => setEditing(null)}>Cancel</Button>
              ) : (
                <Button variant="danger" onClick={remove}>Delete event</Button>
              )}
              <Button variant="primary" onClick={save} disabled={!editing.title.trim()}>{editing.id ? "Save" : "Create event"}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
