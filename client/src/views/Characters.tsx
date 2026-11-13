import React, { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type Character, type CharacterGraph, type CharacterSuggestion } from "../api.js";
import { Button, Card, Empty, Input, Label, Modal, Spinner, Tag, TextArea, useAppState } from "../ui.js";

interface FullCharacter extends Character {
  events: { id: number; description: string; chapterId: number | null }[];
  links: {
    id: number;
    kind: string;
    notes: string;
    certainty?: string;
    chapterId?: number | null;
    fromCharacterId: number;
    toCharacterId: number;
    fromName: string;
    toName: string;
  }[];
  appearances?: { id: number; kind: string; chapterId: number | null; chapterTitle: string; position: number }[];
  knowledge?: { id: number; kind: string; text: string; source: string; chapterId: number | null; chapterTitle: string | null }[];
}

const FIELDS: { key: keyof Character; label: string; multiline?: boolean }[] = [
  { key: "personality", label: "Personality", multiline: true },
  { key: "appearance", label: "Appearance", multiline: true },
  { key: "background", label: "Background", multiline: true },
  { key: "motivations", label: "Motivations", multiline: true },
  { key: "strengths", label: "Strengths" },
  { key: "weaknesses", label: "Weaknesses" },
  { key: "storyStatus", label: "Current story status" },
  { key: "devNotes", label: "Development arc", multiline: true },
  { key: "freeNotes", label: "Author notes", multiline: true },
];

const SUGGESTION_LABELS: Record<string, string> = {
  new_character: "New character",
  update: "Profile update",
  relationship: "Relationship",
  merge: "Possible duplicate",
};

function suggestionSummary(s: CharacterSuggestion): { title: string; detail: string } {
  const p = s.payload ?? {};
  if (s.kind === "new_character") return { title: `New character: ${p.newName ?? p.name ?? "?"}`, detail: s.reason };
  if (s.kind === "update" && p.characterId && p.field)
    return { title: `${p.field} change`, detail: `Now: "${p.existing}" — proposed: "${p.proposed}". ${s.reason}` };
  if (s.kind === "update" && p.item)
    return {
      title: `${p.item.kind} for ${p.unresolvedCharacter}`,
      detail: `${p.item.data?.text ?? p.item.data?.description ?? ""} — ${s.reason}`,
    };
  if (s.kind === "relationship") {
    const rel = p.rel ?? p;
    if (p.existingKind)
      return {
        title: `Relationship change: ${p.fromName} ↔ ${p.toName}`,
        detail: `Was "${p.existingKind}", chapter suggests "${rel.kind}". ${rel.notes ?? ""}`,
      };
    return { title: `Relationship: ${p.fromName} ↔ ${p.toName}`, detail: `Interpreted as "${rel.kind}". ${rel.notes ?? ""} ${s.reason}` };
  }
  if (s.kind === "merge") return { title: `Merge check: "${p.newName}"`, detail: s.reason };
  return { title: SUGGESTION_LABELS[s.kind] ?? s.kind, detail: s.reason };
}

const KNOWLEDGE_LABELS: Record<string, string> = {
  discovered: "discovered",
  met: "met",
  witnessed: "witnessed",
  secret: "secret",
  unaware: "does NOT know",
};

export const Characters: React.FC = () => {
  const { activeNovelId } = useAppState();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<FullCharacter | null>(null);
  const [pending, setPending] = useState<CharacterSuggestion[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAliases, setNewAliases] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [showWeb, setShowWeb] = useState(false);
  const [graph, setGraph] = useState<CharacterGraph | null>(null);
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!activeNovelId) return;
    api
      .get<Character[]>(`/novels/${activeNovelId}/characters`)
      .then(setCharacters)
      .catch((e) => setError(e.message));
  }, [activeNovelId]);

  const loadPending = useCallback(() => {
    if (!activeNovelId) return;
    api
      .get<CharacterSuggestion[]>(`/novels/${activeNovelId}/characters/pending`)
      .then(setPending)
      .catch(() => setPending([]));
  }, [activeNovelId]);

  const refreshAll = useCallback(() => {
    load();
    loadPending();
  }, [load, loadPending]);

  useEffect(refreshAll, [refreshAll]);
  useEffect(() => setSelected(null), [activeNovelId]);

  const open = async (id: number) => {
    const full = await api.get<FullCharacter>(`/novels/${activeNovelId}/characters/${id}`);
    setSelected(id);
    setDetail(full);
  };

  const save = async () => {
    if (!detail) return;
    const updated = await api.put<Character>(`/novels/${activeNovelId}/characters/${detail.id}`, detail);
    setDetail({ ...detail, ...updated, events: detail.events, links: detail.links });
    setCharacters((cs) => cs.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)));
  };

  const remove = async () => {
    if (!detail) return;
    if (!confirm(`Remove ${detail.name} from the cast?`)) return;
    await api.del(`/novels/${activeNovelId}/characters/${detail.id}`);
    setSelected(null);
    setDetail(null);
    refreshAll();
  };

  const create = async () => {
    if (!newName.trim()) return;
    const created = await api.post<Character>(`/novels/${activeNovelId}/characters`, {
      name: newName.trim(),
      aliases: newAliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    });
    setNewName("");
    setNewAliases("");
    setCreating(false);
    refreshAll();
    open(created.id);
  };

  const decide = async (s: CharacterSuggestion, decision: "approve" | "reject") => {
    await api.post(`/novels/${activeNovelId}/characters/pending/${s.id}/decision`, { decision });
    loadPending();
    // approving can create or change characters
    if (decision === "approve") {
      load();
      if (selected) open(selected);
    }
  };

  const scanNovel = async () => {
    setScanning(true);
    try {
      await api.post(`/ai/analyze-novel-characters`, { novelId: activeNovelId, force: true });
      refreshAll();
      if (selected) open(selected);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  };

  const openWeb = async () => {
    const g = await api.get<CharacterGraph>(`/novels/${activeNovelId}/characters/graph`);
    setGraph(g);
    setShowWeb(true);
  };

  const merge = async () => {
    if (!detail || !mergeTarget) return;
    if (
      !confirm(
        `Merge the selected character INTO ${detail.name}? The other profile's events, knowledge, appearances and aliases move here.`,
      )
    )
      return;
    await api.post(`/novels/${activeNovelId}/characters/${detail.id}/merge`, { otherId: mergeTarget });
    setMergeTarget(null);
    open(detail.id);
    refreshAll();
  };

  if (!activeNovelId)
    return (
      <Empty title="No novel selected">
        Pick a project in <b>My Novels</b> first.
      </Empty>
    );

  return (
    <div className="max-w-6xl mx-auto p-8 flex gap-6 h-full min-h-0">
      <aside className="w-64 shrink-0 flex flex-col">
        <header className="flex items-center justify-between mb-3">
          <h1 className="font-serif text-xl">Cast</h1>
          <Button variant="primary" onClick={() => setCreating(true)}>
            +
          </Button>
        </header>
        {error && <p className="mb-3 text-[11px] text-red-300 border border-red-900/60 rounded-md px-3 py-2">{error}</p>}
        {(pending?.length ?? 0) > 0 && (
          <button
            onClick={() => document.getElementById("pending-review")?.scrollIntoView({ behavior: "smooth" })}
            className="mb-3 text-left text-[11px] rounded-md border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-amber-300"
          >
            {pending!.length} item{pending!.length === 1 ? "" : "s"} need your review ↓
          </button>
        )}
        <div className="overflow-y-auto flex flex-col gap-1.5">
          {characters.length === 0 && (
            <p className="text-xs text-ink-400">
              No characters yet. Write a chapter — the engine reads it in the background and proposes the cast here. Or add someone
              manually.
            </p>
          )}
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={() => open(c.id)}
              className={`text-left rounded-md border px-3 py-2 ${selected === c.id ? "border-loom-500 bg-ink-850" : "border-ink-800 bg-ink-900 hover:border-ink-700"}`}
            >
              <div className="text-sm">{c.name}</div>
              {c.aliases.length > 0 && <div className="text-[10px] text-ink-400">{c.aliases.join(", ")}</div>}
            </button>
          ))}
        </div>
      </aside>

      <section className="flex-1 min-w-0 overflow-y-auto">
        {/* Automatic engine: scan + review queue */}
        <Card className="p-4 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-serif text-lg">Automatic character engine</h2>
              <p className="text-xs text-ink-400 mt-0.5">
                Chapters are read in the background on creation, manual saves and restores — new profiles, relationships, knowledge and
                uncertain items appear here.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" disabled={scanning} onClick={scanNovel}>
                {scanning ? (
                  <>
                    <Spinner /> Reading chapters…
                  </>
                ) : (
                  "Read all chapters"
                )}
              </Button>
              <Button variant="subtle" onClick={openWeb}>
                Relationship web
              </Button>
            </div>
          </div>

          {pending && pending.length > 0 && (
            <div id="pending-review" className="mt-4 flex flex-col gap-2">
              <h3 className="text-xs uppercase tracking-wider text-ink-400">Needs your decision</h3>
              {pending.map((s) => {
                const { title, detail: sum } = suggestionSummary(s);
                return (
                  <div key={s.id} className="rounded-md border border-ink-800 bg-ink-900 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Tag tone={s.kind === "merge" ? "amber" : "blue"}>{SUGGESTION_LABELS[s.kind] ?? s.kind}</Tag>
                        <span className="text-sm truncate">{title}</span>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button variant="primary" onClick={() => decide(s, "approve")}>
                          Approve
                        </Button>
                        <Button variant="subtle" onClick={() => decide(s, "reject")}>
                          Reject
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-ink-400 mt-1">{sum}</p>
                    {s.chapterTitle && <p className="text-[10px] text-ink-500 mt-1">from chapter: {s.chapterTitle}</p>}
                  </div>
                );
              })}
            </div>
          )}
          {pending?.length === 0 && (
            <p className="text-[11px] text-ink-400 mt-2">
              Nothing awaits review. Well-supported facts are filed automatically; uncertain ones land here.
            </p>
          )}
        </Card>

        {detail ? (
          <>
            <header className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-serif text-2xl">{detail.name}</h2>
                {detail.aliases.length > 0 && <p className="text-xs text-ink-400">Also known as: {detail.aliases.join(" · ")}</p>}
              </div>
              <div className="flex gap-2">
                <Button variant="primary" onClick={save}>
                  Save changes
                </Button>
                <Button onClick={() => setMergeTarget(-1)}>Merge…</Button>
                <Button variant="danger" onClick={remove}>
                  Remove
                </Button>
              </div>
            </header>
            <div className="grid md:grid-cols-2 gap-4">
              {FIELDS.map((f) => (
                <div key={f.key} className={f.multiline ? "md:col-span-2" : ""}>
                  <Label>{f.label}</Label>
                  {f.multiline ? (
                    <TextArea
                      rows={3}
                      className="w-full"
                      value={String(detail[f.key] ?? "")}
                      onChange={(e) => setDetail({ ...detail, [f.key]: e.target.value } as FullCharacter)}
                    />
                  ) : (
                    <Input
                      className="w-full"
                      value={String(detail[f.key] ?? "")}
                      onChange={(e) => setDetail({ ...detail, [f.key]: e.target.value } as FullCharacter)}
                    />
                  )}
                </div>
              ))}
            </div>

            {detail.appearances && detail.appearances.length > 0 && (
              <>
                <h3 className="text-sm uppercase tracking-wider text-ink-400 mt-8 mb-2">Chapters they appear in</h3>
                <div className="flex flex-wrap gap-1.5">
                  {detail.appearances.map((a) => (
                    <Tag key={a.id} tone={a.kind === "onscene" ? "blue" : "gold"}>
                      {a.chapterTitle}
                      {a.kind === "onscene" ? "" : " (mentioned)"}
                    </Tag>
                  ))}
                </div>
              </>
            )}

            {detail.knowledge && detail.knowledge.length > 0 && (
              <>
                <h3 className="text-sm uppercase tracking-wider text-ink-400 mt-8 mb-2">What they know</h3>
                <div className="flex flex-col gap-1.5">
                  {detail.knowledge.map((k) => (
                    <div key={k.id} className="text-sm flex gap-2 items-baseline">
                      <Tag tone={k.kind === "unaware" ? "amber" : k.kind === "secret" ? "gold" : "blue"}>
                        {KNOWLEDGE_LABELS[k.kind] ?? k.kind}
                      </Tag>
                      <span>{k.text}</span>
                      {k.chapterTitle && <span className="text-[10px] text-ink-500">· {k.chapterTitle}</span>}
                    </div>
                  ))}
                </div>
              </>
            )}

            <h3 className="text-sm uppercase tracking-wider text-ink-400 mt-8 mb-2">Events</h3>
            <div className="flex flex-col gap-2 mb-2">
              {detail.events.map((ev, i) => (
                <div key={ev.id ?? `new-${i}`} className="flex gap-2 items-center">
                  <Input
                    className="flex-1"
                    value={ev.description}
                    onChange={(e) => {
                      const events = [...detail.events];
                      events[i] = { ...ev, description: e.target.value };
                      setDetail({ ...detail, events });
                    }}
                  />
                  <Button variant="subtle" onClick={() => setDetail({ ...detail, events: detail.events.filter((_, j) => j !== i) })}>
                    ×
                  </Button>
                </div>
              ))}
            </div>
            <Button onClick={() => setDetail({ ...detail, events: [...detail.events, { id: 0, description: "", chapterId: null }] })}>
              + Add event
            </Button>

            <h3 className="text-sm uppercase tracking-wider text-ink-400 mt-8 mb-2">Relationships</h3>
            <div className="flex flex-col gap-2">
              {detail.links.length === 0 && (
                <p className="text-xs text-ink-400">
                  No recorded relationships yet. The engine adds confirmed ones automatically; plausible-but-unconfirmed ones wait for your
                  approval.
                </p>
              )}
              {detail.links.map((l) => {
                const other =
                  l.fromCharacterId === detail.id ? { name: l.toName, id: l.toCharacterId } : { name: l.fromName, id: l.fromCharacterId };
                return (
                  <div key={l.id} className="flex items-center gap-2 text-sm">
                    <Tag tone={l.certainty === "confirmed" ? "blue" : "amber"}>{l.kind || "related"}</Tag>
                    <span>
                      with <b>{other.name}</b>
                    </span>
                    {l.notes && <span className="text-xs text-ink-400">· {l.notes}</span>}
                    <Button variant="subtle" onClick={() => setDetail({ ...detail, links: detail.links.filter((x) => x.id !== l.id) })}>
                      ×
                    </Button>
                  </div>
                );
              })}
            </div>
            <Button
              className="mt-2"
              onClick={() =>
                setDetail({
                  ...detail,
                  links: [
                    ...detail.links,
                    {
                      id: Math.random(),
                      kind: "",
                      notes: "",
                      certainty: "proposed",
                      fromCharacterId: detail.id,
                      toCharacterId: 0,
                      fromName: detail.name,
                      toName: "",
                    },
                  ],
                })
              }
            >
              + Add relationship (then Save)
            </Button>
            <p className="text-[11px] text-ink-400 mt-1">
              Set the other character's id in the saved record — the app links by character names you both appear with.
            </p>
          </>
        ) : (
          <Empty title="Select a character">
            The engine maintains these records automatically from your chapters; you stay in charge of every review.
          </Empty>
        )}
      </section>

      {/* Merge modal */}
      <Modal open={mergeTarget !== null} onClose={() => setMergeTarget(null)} title={`Merge into ${detail?.name ?? ""}`}>
        <p className="text-xs text-ink-400 mb-3">
          Pick the duplicate profile to fold into <b>{detail?.name}</b>. Its aliases, events, knowledge, appearances and relationships move
          across; nothing is lost.
        </p>
        <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
          {characters
            .filter((c) => c.id !== detail?.id)
            .map((c) => (
              <button
                key={c.id}
                onClick={() => setMergeTarget(c.id)}
                className={`text-left rounded-md border px-3 py-2 ${mergeTarget === c.id ? "border-loom-500 bg-ink-850" : "border-ink-800 bg-ink-900 hover:border-ink-700"}`}
              >
                <div className="text-sm">{c.name}</div>
              </button>
            ))}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button onClick={() => setMergeTarget(null)}>Cancel</Button>
          <Button variant="primary" disabled={!mergeTarget || mergeTarget === -1} onClick={merge}>
            Merge
          </Button>
        </div>
      </Modal>

      {/* Relationship web */}
      <Modal open={showWeb} onClose={() => setShowWeb(false)} title="Relationship web" wide>
        {!graph || graph.nodes.length === 0 ? (
          <p className="text-sm text-ink-400">No characters yet.</p>
        ) : (
          <svg viewBox="0 0 600 400" className="w-full">
            {graph.links.map((l) => {
              const n = graph.nodes.length;
              const idxOf = (id: number) => graph.nodes.findIndex((x) => x.id === id);
              const a = graph.nodes[idxOf(l.fromCharacterId)];
              const b = graph.nodes[idxOf(l.toCharacterId)];
              if (!a || !b) return null;
              const angA = (idxOf(l.fromCharacterId) / n) * 2 * Math.PI - Math.PI / 2;
              const angB = (idxOf(l.toCharacterId) / n) * 2 * Math.PI - Math.PI / 2;
              const ax = 300 + 170 * Math.cos(angA),
                ay = 200 + 150 * Math.sin(angA);
              const bx = 300 + 170 * Math.cos(angB),
                by = 200 + 150 * Math.sin(angB);
              return (
                <g key={l.id}>
                  <line
                    x1={ax}
                    y1={ay}
                    x2={bx}
                    y2={by}
                    stroke={l.certainty === "confirmed" ? "var(--color-ink-600, #444)" : "#b45309"}
                    strokeWidth={1.5}
                    strokeDasharray={l.certainty === "confirmed" ? "" : "4 3"}
                  />
                  <text x={(ax + bx) / 2} y={(ay + by) / 2 - 4} fontSize="9" fill="#999" textAnchor="middle">
                    {l.kind}
                  </text>
                </g>
              );
            })}
            {graph.nodes.map((n, i) => {
              const ang = (i / graph.nodes.length) * 2 * Math.PI - Math.PI / 2;
              const x = 300 + 170 * Math.cos(ang);
              const y = 200 + 150 * Math.sin(ang);
              return (
                <g key={n.id}>
                  <circle cx={x} cy={y} r={16} fill="#1c1c22" stroke="#3f3f46" />
                  <text x={x} y={y + 3} fontSize="8" fill="#ddd" textAnchor="middle">
                    {n.name.slice(0, 3)}
                  </text>
                  <text x={x} y={y + 30} fontSize="10" fill="#aaa" textAnchor="middle">
                    {n.name}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        <p className="text-[11px] text-ink-400 mt-2">
          Solid lines: confirmed by the manuscript · dashed amber: suggested, awaiting your approval.
        </p>
      </Modal>

      {/* New character dialog */}
      <Modal open={creating} onClose={() => setCreating(false)} title="New character">
        <Label>Name</Label>
        <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
        <div className="mt-3">
          <Label>Aliases (comma separated)</Label>
          <Input value={newAliases} onChange={(e) => setNewAliases(e.target.value)} />
        </div>
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
