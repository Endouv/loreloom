import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Chapter version history: writing twice leaves a snapshot behind, and the
 * History panel puts one back — while snapshotting the text it replaces, so a
 * restore is itself reversible.
 */
test.describe.configure({ mode: "serial" });

interface Version {
  id: number;
  source: string;
  createdAt: string;
}

/** Create a novel with one chapter through the public API. */
async function seedChapter(request: APIRequestContext, title: string) {
  const novel = await request.post("/api/novels", { data: { title } });
  expect(novel.ok(), "novel creation should succeed").toBeTruthy();
  const { id: novelId } = (await novel.json()) as { id: number };

  const chapter = await request.post(`/api/novels/${novelId}/chapters`, { data: { title: "Chapter One" } });
  expect(chapter.ok(), "chapter creation should succeed").toBeTruthy();
  const { id: chapterId } = (await chapter.json()) as { id: number };

  return { novelId, chapterId };
}

/** Manual saves snapshot the text they replace, which is what seeds history. */
async function saveManually(request: APIRequestContext, chapterId: number, body: string) {
  const res = await request.put(`/api/chapters/${chapterId}?source=manual`, { data: { body } });
  expect(res.ok(), `manual save of "${body}" should succeed`).toBeTruthy();
}

const versionsOf = async (request: APIRequestContext, chapterId: number) =>
  (await (await request.get(`/api/chapters/${chapterId}/versions`)).json()) as Version[];

test("history: a snapshot is restored from the History panel and the replaced text is kept", async ({ page, request }) => {
  const { novelId, chapterId } = await seedChapter(request, "E2E History");

  const older = "The older draft opened on the pier at dawn.";
  const newer = "The newer draft opens aboard the ferry, engines cold.";
  await saveManually(request, chapterId, older);
  await saveManually(request, chapterId, newer);

  // Two manual saves => one snapshot each, the newest holding `older`.
  const seeded = await versionsOf(request, chapterId);
  expect(seeded).toHaveLength(2);
  expect(seeded[0].source).toBe("pre-edit");

  await page.addInitScript((id: number) => localStorage.setItem("loreloom.novel", String(id)), novelId);
  await page.goto("/editor");
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("aboard the ferry");

  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "History", exact: true }).click();

  const panel = page.locator("aside").filter({ hasText: "Revision history" });
  await expect(panel).toBeVisible();
  // Cards are newest-first, so the first Restore is the `older` snapshot.
  await panel.getByRole("button", { name: "Restore", exact: true }).first().click();

  // The editor shows the restored text, and it is saved as such — not dirty.
  await expect(editor).toContainText("opened on the pier at dawn");
  await expect(editor).not.toContainText("engines cold");
  await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 20_000 });

  const chapter = (await (await request.get(`/api/chapters/${chapterId}`)).json()) as { body: string };
  expect(chapter.body).toBe(older);

  // Reversible: restoring snapshotted the text it replaced.
  const after = await versionsOf(request, chapterId);
  expect(after).toHaveLength(3);
  const newest = (await (await request.get(`/api/chapters/${chapterId}/versions/${after[0].id}`)).json()) as { body: string };
  expect(newest.body).toBe(newer);

  // And the restored text survives a reload, so it came from the database.
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("opened on the pier at dawn");
});
