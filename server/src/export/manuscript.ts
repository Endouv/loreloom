import { Router } from "express";
import { db } from "../db/database.js";
import { asyncHandler, badRequest } from "../util.js";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import PDFDocument from "pdfkit";

export const exportRouter = Router();

interface ExportChapter {
  id: number;
  title: string;
  body: string;
  status: string;
  position: number;
  word_count: number;
}

function getManuscript(novelId: number, statuses: string[] | null, includeTitlePageComments: boolean) {
  const novel = db.prepare("SELECT * FROM novels WHERE id = ?").get(novelId) as
    { id: number; title: string; genre: string; synopsis: string } | undefined;
  if (!novel) badRequest("Novel not found");
  let chapters = db
    .prepare("SELECT id, title, body, status, position, word_count FROM chapters WHERE novel_id = ? ORDER BY position, id")
    .all(novelId) as ExportChapter[];
  if (statuses?.length) chapters = chapters.filter((c) => statuses.includes(c.status));
  void includeTitlePageComments;
  return { novel: novel!, chapters };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "manuscript";

function buildDocx(novel: { title: string; genre: string; synopsis: string }, chapters: ExportChapter[]): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun(novel.title)],
    }),
  ];
  for (const ch of chapters) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(ch.title)], spacing: { before: 360, after: 200 } }),
    );
    for (const para of ch.body.split(/\n\s*\n/).filter((p) => p.trim())) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { line: 360 },
          indent: { firstLine: 448 },
          children: [new TextRun(para.trim())],
        }),
      );
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function buildPdf(novel: { title: string; genre: string }, chapters: ExportChapter[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // docx library writes to Node buffers via Packer; PDFKit is the same pattern.
    const doc = new PDFDocument({ size: "A4", margins: { top: 72, bottom: 72, left: 72, right: 72 }, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Times-Roman").fontSize(26).text(novel.title, { align: "center" });
    if (novel.genre) doc.fontSize(13).text(novel.genre, { align: "center" }).moveDown(1.5);
    for (const ch of chapters) {
      doc.addPage().font("Times-Bold").fontSize(17).text(ch.title, { align: "left" }).moveDown(0.7);
      doc.font("Times-Roman").fontSize(11.5).lineGap(5.5);
      for (const para of ch.body.split(/\n\s*\n/).filter((p) => p.trim())) {
        doc.text(para.trim(), { align: "justify", indent: 24, paragraphGap: 6 });
      }
    }
    doc.end();
  });
}

exportRouter.get(
  "/novels/:novelId/export",
  asyncHandler(async (req, res) => {
    const novelId = Number(req.params.novelId);
    const format = String(req.query.format ?? "docx").toLowerCase();
    const statusesParam = String(req.query.statuses ?? "");
    const statuses = statusesParam ? statusesParam.split(",").filter((s) => ["draft", "revision", "completed"].includes(s)) : null;
    const { novel, chapters } = getManuscript(novelId, statuses, false);
    const base = slug(novel.title);

    if (format === "txt") {
      let text = `${novel.title}\n${"=".repeat(Math.max(novel.title.length, 8))}\n\n`;
      for (const ch of chapters) {
        text += `\n\n${ch.title}\n${"-".repeat(Math.max(ch.title.length, 4))}\n\n${ch.body.trim()}\n`;
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.txt"`);
      return res.send(text);
    }

    if (format === "markdown" || format === "md") {
      // Markdown keeps the manuscript portable: title, optional premise, then
      // each chapter as a heading followed by its prose, in manuscript order.
      let md = `# ${novel.title}\n`;
      if (novel.genre) md += `\n*${novel.genre}*\n`;
      if (novel.synopsis.trim()) {
        const quote = novel.synopsis
          .trim()
          .split(/\r?\n/)
          .map((line) => `> ${line}`.trimEnd())
          .join("\n");
        md += `\n${quote}\n`;
      }
      for (const ch of chapters) {
        md += `\n## ${ch.title}\n\n${ch.body.trim()}\n`;
      }
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.md"`);
      return res.send(md);
    }

    if (format === "docx") {
      const buffer = await buildDocx(novel, chapters);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.docx"`);
      return res.send(buffer);
    }

    if (format === "pdf") {
      const buffer = await buildPdf(novel, chapters);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
      return res.send(buffer);
    }

    badRequest("format must be one of docx, pdf, txt, markdown");
  }),
);

exportRouter.get(
  "/novels/:novelId/report",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    const novel = db.prepare("SELECT id, title, genre, status, target_words FROM novels WHERE id = ?").get(novelId) as
      { id: number; title: string; genre: string; status: string; target_words: number } | undefined;
    if (!novel) badRequest("Novel not found");
    const chapters = db
      .prepare("SELECT id, title, status, word_count, position FROM chapters WHERE novel_id = ? ORDER BY position, id")
      .all(novelId) as { id: number; title: string; status: string; word_count: number; position: number }[];
    const total = chapters.reduce((s, c) => s + c.word_count, 0);
    const byStatus = { draft: 0, revision: 0, completed: 0 } as Record<string, number>;
    const wordsByStatus = { draft: 0, revision: 0, completed: 0 } as Record<string, number>;
    for (const c of chapters) {
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      wordsByStatus[c.status] = (wordsByStatus[c.status] ?? 0) + c.word_count;
    }
    res.json({
      novel,
      totalWords: total,
      targetWords: novel.target_words,
      percent: novel.target_words ? Math.round((total / novel.target_words) * 100) : null,
      chapters,
      byStatus,
      wordsByStatus,
    });
  }),
);
