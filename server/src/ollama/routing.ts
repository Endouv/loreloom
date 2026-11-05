/**
 * Model routing: maps task tiers to installed Ollama models without hardcoding
 * a single model. Preference slots win; sensible fallbacks keep the app usable.
 */
import { db } from "../db/database.js";
import { parseJson } from "../util.js";
import { listModels, type OllamaModel } from "./client.js";

export type Tier = "main" | "light" | "embedding";

export interface RoutingDecision {
  model: string | null;
  requested: string | null;
  fallback: boolean;
  reason: string;
}

function prefsModels(): { main: string; light: string; embedding: string } {
  const row = db.prepare("SELECT json FROM preferences WHERE id = 1").get() as { json: string };
  const models = parseJson(row.json, {}).models ?? {};
  return {
    main: typeof models.main === "string" ? models.main : "",
    light: typeof models.light === "string" ? models.light : "",
    embedding: typeof models.embedding === "string" ? models.embedding : "",
  };
}

/**
 * Context window (tokens) the author lets generation/analysis use. Live-read
 * so settings changes apply without a restart. Returns null when unset or
 * implausible, meaning "let Ollama defaults decide".
 */
export function numCtxTokens(): number | null {
  const row = db.prepare("SELECT json FROM preferences WHERE id = 1").get() as { json: string };
  const perf = parseJson(row.json, {}).performance ?? {};
  const n = Number(perf.modelContextTokens);
  return Number.isFinite(n) && n >= 512 ? n : null;
}

function parseBillions(parameterSize: string): number {
  const n = parseFloat(parameterSize);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Decide which installed model serves a tier.
 *  - main: 7–8B ideal, 3.5–13B acceptable; prefers the preference slot.
 *  - light: the smallest usable instruct model (≤4B).
 *  - embedding: a model whose name signals embeddings (nomic-embed-text etc).
 */
export async function routeModel(tier: Tier): Promise<RoutingDecision> {
  const prefs = prefsModels();
  let installed: OllamaModel[] = [];
  try {
    installed = await listModels();
  } catch (err) {
    return { model: null, requested: prefs[tier] || null, fallback: false, reason: "ollama_unreachable" };
  }

  const requestedName = prefs[tier];
  const requested = requestedName
    ? installed.find((m) => m.name === requestedName || m.name.startsWith(requestedName))
    : undefined;
  if (requested) return { model: requested.name, requested: requested.name, fallback: false, reason: "preference" };

  if (tier === "embedding") {
    const embedModel = installed.find((m) => /embed|bge|e5|minilm/i.test(m.name));
    return embedModel
      ? { model: embedModel.name, requested: requestedName || null, fallback: true, reason: "no preference set; embedding-capable model found" }
      : { model: null, requested: null, fallback: false, reason: "no embedding model installed" };
  }

  const instruct = installed.filter((m) => !/embed/i.test(m.name) && m.billions > 0);
  if (tier === "light") {
    const small = instruct
      .filter((m) => m.billions <= 4)
      .sort((a, b) => a.billions - b.billions)[0];
    if (small) return { model: small.name, requested: requestedName || null, fallback: true, reason: "smallest installed instruct model" };
  }
  const anywhere = instruct.sort((a, b) => a.billions - b.billions)[0];
  if (anywhere) {
    const reason =
      tier === "main"
        ? anywhere.billions >= 3.5
          ? "preference unset; best installed model"
          : "preference unset; falling back to smallest installed model — install a 4B+ model for better quality"
        : "falling back to smallest installed model";
    return { model: anywhere.name, requested: requestedName || null, fallback: true, reason };
  }
  return { model: null, requested: null, fallback: false, reason: "no instruct model installed" };
}
