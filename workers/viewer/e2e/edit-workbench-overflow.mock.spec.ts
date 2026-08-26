import { expect, test } from "./fixtures/console-errors.js";

interface WidthSnapshot {
  documentContained: boolean;
  bodyContained: boolean;
  harnessContained: boolean;
  narrow: boolean;
  editorVisible: boolean;
  diffVisible: boolean;
}

async function widthSnapshot(): Promise<WidthSnapshot> {
  const workbench = document.querySelector<HTMLElement>(".zhs-edit-workbench");
  const harness = document.querySelector<HTMLElement>("#zhs-edit-overflow-harness");
  const editor = document.querySelector<HTMLElement>(".zhs-edit-workbench__pane--editor");
  const diff = document.querySelector<HTMLElement>(".zhs-edit-workbench__pane--diff");
  if (workbench === null || harness === null || editor === null || diff === null) {
    throw new Error("The edit workbench overflow harness is incomplete");
  }
  return {
    documentContained: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    bodyContained: document.body.scrollWidth <= document.body.clientWidth,
    harnessContained: harness.scrollWidth <= harness.clientWidth,
    narrow: workbench.dataset.narrow === "true",
    editorVisible: !editor.hidden,
    diffVisible: !diff.hidden,
  };
}

test("@smoke edit workbench contains page overflow at responsive widths", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.addInitScript(() => localStorage.setItem("zhs.diff.wrap", "false"));
  await page.goto("/login");
  await page.evaluate(async () => {
    const loadHarness = new Function(
      "return import('/e2e/fixtures/edit-workbench-overflow-harness.tsx')",
    ) as () => Promise<{ mountEditWorkbenchOverflowHarness: () => Promise<void> }>;
    const harness = await loadHarness();
    await harness.mountEditWorkbenchOverflowHarness();
  });

  await expect(page.getByRole("textbox", { name: "Draft body" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Split" })).toBeDisabled();
  await page.getByRole("button", { name: "Diff" }).click();
  await expect(page.getByRole("table", { name: "Unified diff" })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".zhs-diff-table-pane")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);

  // Expected: 360px and 768px use one semantic pane; 1280px shows both panes.
  // Forbidden: the long unwrapped diff grows the document, body, or harness horizontally.
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const expected =
      width <= 768
        ? {
            documentContained: true,
            bodyContained: true,
            harnessContained: true,
            narrow: true,
            editorVisible: false,
            diffVisible: true,
          }
        : {
            documentContained: true,
            bodyContained: true,
            harnessContained: true,
            narrow: false,
            editorVisible: true,
            diffVisible: true,
          };
    await expect.poll(() => page.evaluate(widthSnapshot)).toEqual(expected);
  }
});
