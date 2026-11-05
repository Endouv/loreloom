import React, { useCallback, useEffect, useState } from "react";
import { api, type Novel } from "../api.js";
import { Button, Card, Empty, Input, Label, Modal, Tag, TextArea, useAppState } from "../ui.js";

const BLANK = { title: "", genre: "", status: "draft", targetWords: 0, synopsis: "", tags: "" };

export const Novels: React.FC = () => {
  const { activeNovelId, setActiveNovel, reloadPrefs } = useAppState();
  const [novels, setNovels] = useState<Novel[]>([]);
  const [modal, setModal] = useState<"closed" | "new" | "edit">("closed");
  const [form, setForm] = useState(BLANK);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.get<Novel[]>("/novels").then(setNovels).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const openNew = () => {
    setForm(BLANK);
    setEditingId(null);
    setModal("new");
  };
  const openEdit = (n: Novel) => {
    setForm({ title: n.title, genre: n.genre, status: n.status, targetWords: n.targetWords, synopsis: n.synopsis, tags: n.tags.join(", ") });
    setEditingId(n.id);
    setModal("edit");
  };

  const save = async () => {
    if (!form.title.trim()) return setError("Give the novel a title.");
    const payload = {
      title: form.title.trim(),
      genre: form.genre,
      status: form.status,
      targetWords: Number(form.targetWords) || 0,
      synopsis: form.synopsis,
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
    };
    try {
      if (editingId) await api.put(`/novels/${editingId}`, payload);
      else {
        const created = await api.post<Novel>("/novels", payload);
        setActiveNovel(created.id);
      }
      setModal("closed");
      load();
      reloadPrefs();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (n: Novel) => {
    if (!confirm(`Delete "${n.title}" and all of its chapters, characters and memories? This cannot be undone.`)) return;
    await api.del(`/novels/${n.id}`);
    if (activeNovelId === n.id) setActiveNovel(null);
    load();
  };

  return (
    <div className="max-w-5xl mx-auto p-8">
      <header className="flex items-center justify-between mb-6">
        <h1 className="font-serif text-2xl">My Novels</h1>
        <Button variant="primary" onClick={openNew}>+ New novel</Button>
      </header>
      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {novels.length === 0 ? (
        <Empty title="Empty shelf">
          Start your first project. A novel groups chapters, characters, world entries, memory and the timeline.
        </Empty>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {novels.map((n) => (
            <Card key={n.id} className="p-5 hover:border-loom-600/50 transition-colors">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-serif text-xl">{n.title}</h2>
                  <div className="flex gap-2 mt-2 flex-wrap">
                    <Tag tone={n.status === "completed" ? "green" : n.status === "revision" ? "amber" : "gold"}>{n.status}</Tag>
                    {n.genre && <Tag tone="blue">{n.genre}</Tag>}
                  </div>
                </div>
                <div className="text-right text-xs text-ink-400">
                  {n.wordCount.toLocaleString()} words<div>{n.chapterCount} chapters</div>
                </div>
              </div>
              {n.synopsis && <p className="text-sm text-ink-400 mt-3 line-clamp-3">{n.synopsis}</p>}
              <div className="flex gap-2 mt-4">
                <a href="/editor" onClick={() => setActiveNovel(n.id)}>
                  <Button variant={activeNovelId === n.id ? "primary" : "ghost"}>Open editor</Button>
                </a>
                <Button onClick={() => openEdit(n)}>Details</Button>
                <Button variant="danger" onClick={() => remove(n)}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={modal !== "closed"} onClose={() => setModal("closed")} title={editingId ? "Novel details" : "New novel"}>
        <div className="flex flex-col gap-4">
          <div>
            <Label>Title</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="The Cartographer of Ash" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Genre</Label>
              <Input value={form.genre} onChange={(e) => setForm({ ...form, genre: e.target.value })} placeholder="Fantasy / Thriller / …" />
            </div>
            <div>
              <Label>Status</Label>
              <div className="flex gap-2 items-center">
                {["draft", "revision", "completed"].map((s) => (
                  <button
                    key={s}
                    onClick={() => setForm({ ...form, status: s })}
                    className={`px-2.5 py-1.5 rounded text-xs border ${form.status === s ? "border-loom-500 text-loom-500" : "border-ink-700 text-ink-400"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <Label>Target words (optional)</Label>
            <Input type="number" value={form.targetWords} onChange={(e) => setForm({ ...form, targetWords: Number(e.target.value) })} />
          </div>
          <div>
            <Label>Synopsis / premise</Label>
            <TextArea rows={4} value={form.synopsis} onChange={(e) => setForm({ ...form, synopsis: e.target.value })} />
          </div>
          <div>
            <Label>Tags (comma separated)</Label>
            <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="slow burn, heist, dual timeline" />
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setModal("closed")}>Cancel</Button>
            <Button variant="primary" onClick={save}>{editingId ? "Save" : "Create novel"}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
