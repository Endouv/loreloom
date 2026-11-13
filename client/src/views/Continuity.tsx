import React, { useEffect, useState } from "react";
import { api, errorMessage, type ChapterMeta } from "../api.js";
import { api as apiBase } from "../api.js";
import { Button, Card, Empty, Select, Spinner, Tag, useAppState } from "../ui.js";

interface Issue {
  type: string;
  location: string;
  evidence: string;
  why: string;
  options: string[];
}

export const Continuity: React.FC = () => {
  const { activeNovelId } = useAppState();
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [scope, setScope] = useState<string>(""); // empty = whole manuscript
  const [running, setRunning] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [model, setModel] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!activeNovelId) return;
    api
      .get<ChapterMeta[]>(`/novels/${activeNovelId}/chapters`)
      .then(setChapters)
      .catch(() => {});
    setIssues(null);
    setScope("");
  }, [activeNovelId]);

  const run = async () => {
    if (!activeNovelId || running) return;
    setRunning(true);
    setIssues(null);
    setError("");
    setCheckedAt(new Date().toLocaleTimeString());
    try {
      const data = await apiBase.post<{ issues: Issue[]; model: string }>("/ai/continuity", {
        novelId: activeNovelId,
        chapterId: scope ? Number(scope) : null,
      });
      setIssues(data.issues);
      setModel(data.model);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  if (!activeNovelId)
    return (
      <Empty title="No novel selected">
        Pick a project in <b>My Novels</b> first.
      </Empty>
    );

  const toneFor = (t: string): "red" | "amber" | "blue" => {
    if (/timeline|chronolog/i.test(t)) return "amber";
    if (/knowledge|memory|forgot/i.test(t)) return "blue";
    return "red";
  };

  return (
    <div className="max-w-4xl mx-auto p-8 flex flex-col h-full min-h-0">
      <header className="flex items-center justify-between mb-2">
        <div>
          <h1 className="font-serif text-2xl">Continuity Checker</h1>
          <p className="text-xs text-ink-400 mt-1">
            Compares your chapters against confirmed story memory, character records, world rules and the timeline. Never rewrites anything
            — every issue needs your decision.
          </p>
        </div>
      </header>

      <Card className="p-4 mb-4 flex items-center gap-3">
        <Select value={scope} onChange={(e) => setScope(e.target.value)} className="flex-1">
          <option value="">Whole manuscript (may take a while)</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              Chapter: {c.title}
            </option>
          ))}
        </Select>
        <Button variant="primary" onClick={run} disabled={running}>
          {running ? (
            <>
              <Spinner /> Checking…
            </>
          ) : (
            "Run check"
          )}
        </Button>
      </Card>
      {error && <div className="mb-3 px-3 py-2 bg-red-950/40 text-red-300 text-sm rounded">{error}</div>}

      <div className="flex-1 overflow-y-auto flex flex-col gap-3">
        {issues && (
          <p className="text-[11px] text-ink-400">
            {checkedAt} · model: {model || "—"} · {issues.length} issue{issues.length === 1 ? "" : "s"} found
          </p>
        )}
        {issues?.length === 0 && (
          <Card className="p-6 text-center text-sm text-ink-300">
            No inconsistencies found in the checked scope. This checks against your canon memory — the more you approve in Story Memory, the
            sharper it gets.
          </Card>
        )}
        {issues?.map((issue, i) => (
          <Card key={i} className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Tag tone={toneFor(issue.type)}>{issue.type}</Tag>
              <span className="text-[11px] text-ink-400">{issue.location}</span>
            </div>
            <p className="text-sm text-ink-300">
              <b>Problem:</b> {issue.why}
            </p>
            {issue.evidence && (
              <p className="text-xs text-ink-400 mt-1">
                <b>Evidence:</b> {issue.evidence}
              </p>
            )}
            {issue.options?.length > 0 && (
              <div className="mt-2">
                <p className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">Possible fixes</p>
                <ul className="text-sm text-ink-300 list-disc pl-5">
                  {issue.options.map((o, j) => (
                    <li key={j}>{o}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        ))}
        {!issues && !running && (
          <Empty title="Ready when you are">
            Run a check per chapter after finishing a draft pass, or over the whole manuscript before a final lap. Results are advisory:
            nothing is changed without you.
          </Empty>
        )}
      </div>
    </div>
  );
};
