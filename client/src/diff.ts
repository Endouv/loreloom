/**
 * Line-level diff for the version history view: "what changed between the
 * last two drafts?" Pure and dependency-free — a longest-common-subsequence
 * over lines with fast prefix/suffix trimming, and a fade-to-summary fallback
 * for pathological inputs so the UI can never hang.
 */

export type DiffLine = { type: "same" | "add" | "del"; text: string };

const splitLines = (s: string): string[] => (s.length === 0 ? [] : s.split("\n"));

export function diffLines(a: string, b: string): DiffLine[] {
  const A = splitLines(a);
  const B = splitLines(b);

  // Trim identical head/tail — cheap and collapses noise for near-identical texts.
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length - 1;
  let endB = B.length - 1;
  while (endA >= start && endB >= start && A[endA] === B[endB]) {
    endA--;
    endB--;
  }
  const midA = A.slice(start, endA + 1);
  const midB = B.slice(start, endB + 1);

  const head = A.slice(0, start).map((text): DiffLine => ({ type: "same", text }));
  const tail = A.slice(endA + 1).map((text): DiffLine => ({ type: "same", text }));

  if (midA.length === 0) return [...head, ...midB.map((text): DiffLine => ({ type: "add", text })), ...tail];
  if (midB.length === 0) return [...head, ...midA.map((text): DiffLine => ({ type: "del", text })), ...tail];

  // LCS over cells; guard the quadratic cost — a changed novel is a *novel*,
  // not a spreadsheet, but a giant paste should degrade, not freeze the tab.
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000) {
    const mid: DiffLine[] = [
      ...(midA.length ? midA.map((text): DiffLine => ({ type: "del", text })) : []),
      ...(midB.length ? midB.map((text): DiffLine => ({ type: "add", text })) : []),
    ];
    return [...head, ...mid, ...tail];
  }

  const table = new Uint32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = midA[i] === midB[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }

  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ type: "same", text: midA[i] });
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      mid.push({ type: "del", text: midA[i] });
      i++;
    } else {
      mid.push({ type: "add", text: midB[j] });
      j++;
    }
  }
  while (i < n) mid.push({ type: "del", text: midA[i++] });
  while (j < m) mid.push({ type: "add", text: midB[j++] });

  return [...head, ...mid, ...tail];
}

export const diffStats = (lines: DiffLine[]): { added: number; removed: number } => ({
  added: lines.filter((l) => l.type === "add").length,
  removed: lines.filter((l) => l.type === "del").length,
});
