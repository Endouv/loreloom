import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Database } from "better-sqlite3";
import { db } from "./db/database.js";

export function countWords(text: string): number {
  const matches = text.trim().match(/[\p{L}\p{N}'’-]+/gu);
  return matches ? matches.length : 0;
}

/**
 * Parse a JSON column. The caller names the expected shape, which keeps the
 * parsed value usable without `any`: a malformed or empty column yields the
 * fallback, so every reader gets a well-typed value.
 */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function touchNovel(novelId: number | undefined | null) {
  if (!novelId) return;
  db.prepare("UPDATE novels SET updated_at = datetime('now') WHERE id = ?").run(novelId);
}

export const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next: NextFunction) => {
    try {
      const result = fn(req, res);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };

export function badRequest(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 400;
  throw err;
}

export function notFound(message = "Not found"): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 404;
  throw err;
}

export function database(): Database {
  return db;
}
