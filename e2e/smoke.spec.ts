import { expect, test, type APIRequestContext } from "@playwright/test";

/** One shared server and database: keep the two flows sequential. */
test.describe.configure({ mode: "serial" });

interface MemoryRow {
  id: number;
  bucket: string;
  decidedAt: string | null;
  text: string;
}

/** Create a novel with one chapter through the public API. */
async function seedProject(request: APIRequestContext, title: string) {
  const novel = await request.post("/api/novels", { data: { title } });
  expect(novel.ok(), "novel creation should succeed").toBeTruthy();
  const { id: novelId } = (await novel.json()) as { id: number };

  const chapter = await request.post(`/api/novels/${novelId}/chapters`, { data: { title: "Chapter One" } });
  expect(chapter.ok(), "chapter creation should succeed").toBeTruthy();
  const { id: chapterId } = (await chapter.json()) as { id: number };

  return { novelId, chapterId };
}

test("editor: typing autosaves to the database and survives a reload", async ({ page, request }) => {
  const { novelId, chapterId } = await seedProject(request, "E2E Draft");
  await page.addInitScript((id: number) => localStorage.setItem("loreloom.novel", String(id)), novelId);

  await page.goto("/editor");
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();

  await editor.click();
  await page.keyboard.type("The tide came in quietly and the harbour lights went out.", { delay: 5 });

  // The chip is the author-facing save contract: dirty first, then saved.
  await expect(page.getByText("Unsaved edits")).toBeVisible();
  await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 20_000 });

  const saved = await request.get(`/api/chapters/${chapterId}`);
  expect(saved.ok()).toBeTruthy();
  const chapter = (await saved.json()) as { body: string };
  expect(chapter.body).toContain("harbour lights");

  // A reload must come back from the database, not from in-memory state.
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("harbour lights");
});

test("approval: an AI suggestion is promoted to canon from the review UI", async ({ page, request }) => {
  const { novelId } = await seedProject(request, "E2E Approval");

  const created = await request.post(`/api/novels/${novelId}/memory`, {
    data: { text: "The beacon is older than the town.", bucket: "ai_suggestion", source: "ai" },
  });
  expect(created.ok(), "suggestion seeding should succeed").toBeTruthy();
  const suggestion = (await created.json()) as MemoryRow;
  expect(suggestion.bucket).toBe("ai_suggestion");

  await page.addInitScript((id: number) => localStorage.setItem("loreloom.novel", String(id)), novelId);
  await page.goto("/memory");

  // AI suggestions stay in their own bucket until the author decides.
  await page.getByRole("button", { name: "AI Suggestions" }).click();
  const card = page.locator("div.rounded-xl").filter({ hasText: "The beacon is older than the town." });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Approve", exact: true }).click();

  // The decision must reach the database, not just the screen.
  await expect
    .poll(
      async () => {
        const list = await request.get(`/api/novels/${novelId}/memory`);
        const items = (await list.json()) as MemoryRow[];
        return items.find((i) => i.id === suggestion.id)?.bucket;
      },
      { timeout: 20_000 },
    )
    .toBe("canon");

  const after = await request.get(`/api/novels/${novelId}/memory`);
  const items = (await after.json()) as MemoryRow[];
  expect(items.find((i) => i.id === suggestion.id)?.decidedAt).toBeTruthy();

  // And the approved item leaves the review bucket.
  await expect(page.getByText("Nothing in this bucket.")).toBeVisible();
});
