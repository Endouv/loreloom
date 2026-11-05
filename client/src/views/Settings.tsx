import React, { useCallback, useEffect, useState } from "react";
import { api, type Preferences } from "../api.js";
import { Button, Card, Input, Label, Select, Tag, useAppState } from "../ui.js";

interface OllamaStatus {
  ollamaUrl: string;
  running: boolean;
  version: string | null;
  models: { name: string; sizeGb: number; parameterSize: string; quantization: string; family: string }[];
  error?: string;
}

interface Hardware {
  platform: string;
  cpuModel: string;
  cpuCores: number;
  ramTotalMb: number;
  ramFreeMb: number;
  diskFreeGb: number;
  gpu: string;
  inference: string;
  verdict: string;
}

interface PullState {
  id: number;
  name: string;
  done: boolean;
  ok: boolean;
  events: { type: string; status?: string; percent?: number; message?: string }[];
}

const SUGGESTED_MODELS = ["qwen3:4b", "qwen3:1.7b", "nomic-embed-text", "llama3.2:3b", "gemma4:e2b"];

export const Settings: React.FC = () => {
  const { prefs, reloadPrefs } = useAppState();
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [routing, setRouting] = useState<any>(null);
  const [pulls, setPulls] = useState<Map<number, PullState>>(new Map());
  const [pullName, setPullName] = useState("");
  const [health, setHealth] = useState<{ ok: boolean; reply?: string; error?: string; ms?: number; model?: string } | null>(null);
  const [backups, setBackups] = useState<{ files: { filename: string; bytes: number; createdAt: string }[]; dbPath: string } | null>(null);
  const [activity, setActivity] = useState<{ task: string; model: string | null; tier: string | null; ok: number; detail: string; created_at: string }[]>([]);
  const [error, setError] = useState("");

  const loadStatus = useCallback(() => {
    api.get<OllamaStatus>("/ollama/status").then(setStatus).catch((e) => setError(e.message));
    api.get<Hardware>("/ollama/hardware").then(setHardware).catch(() => {});
    api.get<any>("/ollama/routing").then(setRouting).catch(() => {});
    api.get<any>("/backups").then(setBackups).catch(() => {});
    api
      .get<any>("/dashboard")
      .then((d) => setActivity(d.recentActivity ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 10000);
    return () => clearInterval(t);
  }, [loadStatus]);

  useEffect(() => {
    const t = setInterval(() => {
      setPulls((ps) => {
        let changed = false;
        const next = new Map(ps);
        for (const [id, p] of ps) {
          if (!p.done) {
            api
              .get<PullState>(`/ollama/pull/${id}`)
              .then((u) => {
                if (!u) return;
                next.set(id, u);
                if (u.done) loadStatus();
              })
              .catch(() => {});
            changed = true;
          }
        }
        return changed ? next : ps;
      });
    }, 1200);
    return () => clearInterval(t);
  }, []);

  const savePrefs = async (patch: Partial<Preferences> | ((p: Preferences) => Partial<Preferences>)) => {
    if (!prefs) return;
    const body = typeof patch === "function" ? patch(prefs) : patch;
    await api.put("/preferences", body);
    reloadPrefs();
  };

  const startPull = async (name: string) => {
    if (!name.trim()) return;
    try {
      const created = await api.post<{ id: number; name: string }>("/ollama/pull", { name: name.trim() });
      setPulls((ps) => new Map(ps).set(created.id, { ...created, done: false, ok: false, events: [] }));
      setPullName("");
    } catch (e: any) {
      setError(e.message);
    }
  };

  const cancelPull = async (id: number) => {
    await api.del(`/ollama/pull/${id}`);
    loadStatus();
  };

  const runHealth = async () => {
    setHealth(null);
    const r = await api.post<any>("/ollama/test");
    setHealth(r);
  };

  const backupNow = async () => {
    await api.post("/backups");
    loadStatus();
  };

  const restore = async (filename: string) => {
    if (!confirm(`Restore database from ${filename}? Current state is replaced. Restart Loreloom afterwards.`)) return;
    await api.post("/backups/restore", { filename });
    alert("Restored. Restart Loreloom to reload the database.");
  };

  if (!prefs) return <div className="p-10 text-ink-400 text-sm">Loading settings…</div>;

  const modelOptions = status?.models ?? [];

  return (
    <div className="max-w-4xl mx-auto p-8 flex flex-col gap-6">
      <h1 className="font-serif text-2xl">Settings</h1>
      {error && <div className="px-3 py-2 bg-red-950/40 text-red-300 text-sm rounded">{error}</div>}

      {/* Ollama */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-serif text-lg">Ollama engine</h2>
          {status && (
            status.running ? (
              <Tag tone="green">connected · v{status.version}</Tag>
            ) : (
              <Tag tone="red">not reachable</Tag>
            )
          )}
        </div>
        {status?.running ? (
          <>
            <p className="text-xs text-ink-400 mb-3">{status.ollamaUrl} · {modelOptions.length} model(s) installed</p>
            {health && (
              <p className="text-xs mb-3">
                {health.ok ? (
                  <Tag tone="green">test passed</Tag>
                ) : (
                  <Tag tone="red">test failed</Tag>
                )}{" "}
                {health.model ? <span className="text-ink-400">via {health.model} in {health.ms}ms — “{health.reply}”</span> : <span className="text-red-300">{health.error}</span>}
              </p>
            )}
            <div className="flex items-center gap-2 mb-4">
              <Button variant="primary" onClick={runHealth}>Test generation</Button>
            </div>
            <div className="flex flex-wrap gap-2 mb-4">
              {modelOptions.map((m) => (
                <span key={m.name} className="border border-ink-700 rounded px-2 py-1 text-xs">
                  <b>{m.name}</b> <span className="text-ink-400">{m.parameterSize} · {m.sizeGb} GB · {m.quantization}</span>
                </span>
              ))}
              {modelOptions.length === 0 && <p className="text-sm text-ink-400">No models installed — download one below.</p>}
            </div>
            <div className="flex gap-2 mb-2">
              <Input className="flex-1" value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder="model name, e.g. qwen3:4b" onKeyDown={(e) => e.key === "Enter" && startPull(pullName)} />
              <Button onClick={() => startPull(pullName)}>Download</Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {SUGGESTED_MODELS.filter((s) => !modelOptions.some((m) => m.name === s)).map((s) => (
                <button key={s} onClick={() => startPull(s)} className="text-xs border border-ink-750 rounded px-2 py-1 text-ink-300 hover:border-loom-500 hover:text-loom-500">
                  + {s}
                </button>
              ))}
            </div>
            {pulls.size > 0 && (
              <div className="flex flex-col gap-2">
                {[...pulls.values()].map((p) => {
                  const lastProgress = [...p.events].reverse().find((e) => e.percent != null);
                  const lastMsg = [...p.events].reverse().find((e) => e.message)?.message;
                  return (
                    <div key={p.id} className="border border-ink-800 rounded p-2 text-xs">
                      <div className="flex items-center justify-between">
                        <b>{p.name}</b>
                        {p.done ? (
                          <Tag tone={p.ok ? "green" : "red"}>{p.ok ? "installed" : "failed"}</Tag>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-ink-400">{lastProgress?.percent != null ? `${lastProgress.percent}%` : lastMsg || "starting…"}</span>
                            <Button variant="subtle" onClick={() => cancelPull(p.id)}>cancel</Button>
                          </div>
                        )}
                      </div>
                      {lastProgress?.percent != null && !p.done && (
                        <div className="h-1 bg-ink-800 rounded mt-1.5 overflow-hidden">
                          <div className="h-full bg-loom-500" style={{ width: `${lastProgress.percent}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-300">
            Ollama isn't reachable at <code className="text-loom-500">{status?.ollamaUrl ?? "http://localhost:11434"}</code>. Start it with{" "}
            <code>ollama serve</code> or the desktop app, then reload this page. Until then all AI features stay offline — your manuscripts remain fully usable.
          </p>
        )}
      </Card>

      {/* Hardware */}
      {hardware && (
        <Card className="p-5">
          <h2 className="font-serif text-lg mb-2">Detected hardware</h2>
          <p className="text-sm text-ink-300">{hardware.verdict}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs text-ink-400">
            <div>Platform: <b className="text-ink-200">{hardware.platform}</b></div>
            <div>CPU: <b className="text-ink-200">{hardware.cpuCores} cores</b></div>
            <div>RAM: <b className="text-ink-200">{(hardware.ramTotalMb / 1024).toFixed(1)} GB</b></div>
            <div>Inference: <b className="text-ink-200">{hardware.inference}</b></div>
          </div>
        </Card>
      )}

      {/* Model routing */}
      <Card className="p-5">
        <h2 className="font-serif text-lg mb-1">Model routing</h2>
        <p className="text-xs text-ink-400 mb-3">
          Choose which installed model serves each task tier. Leave a slot empty to let Loreloom pick the best installed fit
          {routing?.main?.reason ? ` — currently: main ${routing.main.model ?? "—"} (${routing.main.reason}), light ${routing.light.model ?? "—"}, embeddings ${routing.embedding.model ?? "—"}.` : "."}
        </p>
        <div className="grid md:grid-cols-3 gap-4">
          {(
            [
              { key: "main", label: "Main tier", hint: "Prose writing, editing, continuity, brainstorming" },
              { key: "light", label: "Light tier", hint: "Summaries, memory extraction, quick checks" },
              { key: "embedding", label: "Embeddings", hint: "Semantic story-memory search" },
            ] as const
          ).map((slot) => (
            <div key={slot.key}>
              <Label>{slot.label}</Label>
              <Select
                value={(prefs.models as any)[slot.key] ?? ""}
                onChange={(e) => savePrefs({ models: { ...prefs.models, [slot.key]: e.target.value } })}
              >
                <option value="">(auto — best installed)</option>
                {slot.key === "embedding" && <option value="nomic-embed-text">nomic-embed-text</option>}
                {modelOptions
                  .filter((m) => !(slot.key === "embedding" ? false : /embed/i.test(m.name)))
                  .map((m) => (
                    <option key={m.name} value={m.name}>{m.name} ({m.parameterSize})</option>
                  ))}
              </Select>
              <p className="text-[10px] text-ink-400 mt-1">{slot.hint}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div>
            <Label>Max concurrent heavy tasks</Label>
            <Input type="number" min={1} value={prefs.performance.maxHeavyTasks} onChange={(e) => savePrefs((p) => ({ performance: { ...p.performance, maxHeavyTasks: Number(e.target.value) || 1 } }))} />
          </div>
          <div>
            <Label>Max concurrent light tasks</Label>
            <Input type="number" min={1} value={prefs.performance.maxLightTasks} onChange={(e) => savePrefs((p) => ({ performance: { ...p.performance, maxLightTasks: Number(e.target.value) || 2 } }))} />
          </div>
          <div>
            <Label>Model context window (tokens)</Label>
            <Input type="number" min={512} step={512} value={prefs.performance.modelContextTokens ?? 8192} onChange={(e) => savePrefs((p) => ({ performance: { ...p.performance, modelContextTokens: Number(e.target.value) || 8192 } }))} />
            <p className="text-[10px] text-ink-400 mt-1">Window for the assistant's full project view and long analyses. Raise if your model supports more (llama3.2:3b: up to 131k).</p>
          </div>
        </div>
      </Card>

      {/* Writing prefs */}
      <Card className="p-5">
        <h2 className="font-serif text-lg mb-3">Writing &amp; AI behaviour</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Writing language</Label>
            <Input value={prefs.writing.language} onChange={(e) => savePrefs((p) => ({ writing: { ...p.writing, language: e.target.value } }))} />
          </div>
          <div>
            <Label>AI creative freedom</Label>
            <Select value={prefs.writing.creativeFreedom} onChange={(e) => savePrefs((p) => ({ writing: { ...p.writing, creativeFreedom: e.target.value } }))}>
              <option value="strict">strict — only fulfill my explicit asks</option>
              <option value="balanced">balanced — helpful, restrained</option>
              <option value="adventurous">adventurous — propose bold directions</option>
            </Select>
          </div>
          <div className="md:col-span-2">
            <Label>Style guide the AI follows (Hinglish notes? exact tone? chapter conventions?)</Label>
            <Input value={prefs.writing.style} onChange={(e) => savePrefs((p) => ({ writing: { ...p.writing, style: e.target.value } }))} />
          </div>
          <div>
            <Label>Generation temperature ({prefs.writing.temperature})</Label>
            <Input type="number" step="0.05" min={0} max={2} value={prefs.writing.temperature} onChange={(e) => savePrefs((p) => ({ writing: { ...p.writing, temperature: Number(e.target.value) } }))} />
          </div>
          <div>
            <Label>Autosave delay (ms)</Label>
            <Input type="number" min={300} value={prefs.autosaveIntervalMs} onChange={(e) => savePrefs({ autosaveIntervalMs: Number(e.target.value) || 1200 })} />
          </div>
          <div>
            <Label>Editor font size (px)</Label>
            <Input type="number" min={13} max={32} value={prefs.ui.fontSize} onChange={(e) => savePrefs((p) => ({ ui: { ...p.ui, fontSize: Number(e.target.value) || 19 } }))} />
          </div>
          <div>
            <Label>Editor line height</Label>
            <Input type="number" step="0.1" min={1.2} max={2.6} value={prefs.ui.lineHeight} onChange={(e) => savePrefs((p) => ({ ui: { ...p.ui, lineHeight: Number(e.target.value) } }))} />
          </div>
          <div>
            <Label>Editor column width (px)</Label>
            <Input type="number" min={480} max={1100} value={prefs.ui.editorWidth} onChange={(e) => savePrefs((p) => ({ ui: { ...p.ui, editorWidth: Number(e.target.value) || 720 } }))} />
          </div>
          <div>
            <Label>Memory retrieval depth (semantic chunks per request)</Label>
            <Input type="number" min={3} max={30} value={prefs.memory.retrievalChunks} onChange={(e) => savePrefs((p) => ({ memory: { ...p.memory, retrievalChunks: Number(e.target.value) || 8 } }))} />
          </div>
          <div>
            <Label>Context budget (characters sent to the model)</Label>
            <Input type="number" min={1500} max={40000} value={prefs.memory.contextBudgetChars} onChange={(e) => savePrefs((p) => ({ memory: { ...p.memory, contextBudgetChars: Number(e.target.value) || 6000 } }))} />
          </div>
        </div>
      </Card>

      {/* Backups */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-serif text-lg">Backups</h2>
          <Button variant="primary" onClick={backupNow}>Back up now</Button>
        </div>
        <p className="text-xs text-ink-400 mb-3">
          Database file: <code className="text-loom-500">{backups?.dbPath ?? "server/data/loreloom.db"}</code>. A rolling snapshot is also taken at every server start (last 10 kept).
        </p>
        <div className="flex flex-col gap-1.5">
          {backups?.files.map((f) => (
            <div key={f.filename} className="flex items-center justify-between border border-ink-800 rounded px-3 py-1.5 text-xs">
              <span>{f.filename}</span>
              <span className="flex items-center gap-3 text-ink-400">
                {(f.bytes / 1024).toFixed(0)} KB · {new Date(f.createdAt).toLocaleString()}
                <Button variant="subtle" onClick={() => restore(f.filename)}>restore</Button>
              </span>
            </div>
          ))}
          {backups && backups.files.length === 0 && <p className="text-xs text-ink-400">No backups yet.</p>}
        </div>
      </Card>

      {/* Activity */}
      <Card className="p-5">
        <h2 className="font-serif text-lg mb-3">Agent activity</h2>
        <div className="flex flex-col gap-1 text-xs">
          {activity.length === 0 && <p className="text-ink-400">No AI tasks run yet.</p>}
          {activity.map((a, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-ink-850 pb-1">
              <Tag tone={a.ok ? "green" : "red"}>{a.task}</Tag>
              <span className="text-ink-400">{a.model ?? "—"}</span>
              <span className="text-ink-700">{a.created_at}</span>
              <span className="ml-auto text-ink-700 truncate max-w-[40%]">{a.detail}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};
