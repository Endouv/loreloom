import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Manuscript-wide search: the editor's Find panel searches every chapter's
 * prose and notes, shows where each hit came from, and jumps to it.
 */
test.describe.configure({ mode: "serial" });

interface SearchHit {
  chapterId: number;
  chapterTitle: string;
  position: number;
  excerpt: string;
}

/** Create a novel whose chapters each hold the search term in a different place. */
async function seedNovel(request: APIRequestContext, title: string) {
  const novel = await request.post("/api/novels", { data: { title } });
  expect(novel.ok(), "novel creation should succeed").toBeTruthy();
  const { id: novelId } = (await novel.json()) as { id: number };

  const chapters: { title: string; body: string; notes?: string }[] = [
    { title: "The Beacon", body: "The lantern keeper lit the beacon at dusk." },
    { title: "The Crossing", body: "The ferry passed the lantern keeper without a word." },
    { title: "The Ledger", body: "Columns of numbers, nothing more.", notes: "Refers back to the lantern keeper's ledger." },
  ];

  for (const ch of chapters) {
    const created = await request.post(`/api/novels/${novelId}/chapters`, { data: { title: ch.title } });
    expect(created.ok(), "chapter creation should succeed").toBeTruthy();
    const { id: chapterId } = (await created.json()) as { id: number };
    const saved = await request.put(`/api/chapters/${chapterId}?source=manual`, {
      data: { body: ch.body, notes: ch.notes ?? "" },
    });
    expect(saved.ok(), "chapter save should succeed").toBeTruthy();
  }

  return { novelId };
}

test("search: hits span chapter prose and notes, and open the chapter", async ({ page, request }) => {
  const { novelId } = await seedNovel(request, "E2E Search");

  // The API the panel calls: prose in two chapters, notes in the third.
  const api = (await (await request.get(`/api/novels/${novelId}/search?q=${encodeURIComponent("lantern keeper")}`)).json()) as {
    results: SearchHit[];
  };
  expect(api.results.map((r) => r.chapterTitle)).toEqual(["The Beacon", "The Crossing", "The Ledger"]);

  await page.addInitScript((id: number) => localStorage.setItem("loreloom.novel", String(id)), novelId);
  await page.goto("/editor");
  await expect(page.locator(".cm-content")).toContainText("lit the beacon at dusk");

  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText("Find across chapters")).toBeVisible();

  const input = page.getByPlaceholder("Search text or notes…");
  await input.fill("lantern keeper");
  await page.getByRole("button", { name: "Search", exact: true }).click();

  // Three chapters match, each with the line that matched. `p-3` is the result
  // card's own padding: the modal container is a rounded-xl div too.
  const results = page.locator("div.rounded-xl.p-3").filter({ hasText: "lantern keeper" });
  await expect(results).toHaveCount(3);
  await expect(results.nth(0)).toContainText("The Beacon");
  await expect(results.nth(0)).toContainText("lit the beacon at dusk");
  // The third only mentions it in its notes: the excerpt comes from there.
  await expect(results.nth(2)).toContainText("The Ledger");
  await expect(results.nth(2)).toContainText("keeper's ledger");

  // Clicking a hit closes the panel and opens that chapter.
  await results.nth(1).getByRole("button", { name: "The Crossing" }).click();
  await expect(page.getByText("Find across chapters")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("passed the lantern keeper without a word");

  // A term that appears nowhere says so, rather than showing stale hits.
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByPlaceholder("Search text or notes…").fill("zeppelin");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No matches.")).toBeVisible();
});
