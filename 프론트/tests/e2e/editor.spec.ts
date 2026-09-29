import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { authApi } from "../fixtures/auth-api";
import type { MapDefinition } from "../../src/generated/protocol";
import type {
  MapEditAction,
  MapEditEntity,
  MapEditOperationEvent,
} from "../../src/editor/client";
const original = JSON.parse(
  readFileSync(
    new URL(
      "../../../백엔드/contracts/fixtures/campus-map.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as MapDefinition;
function editTouches(actions: MapEditAction[]) {
  const touches = new Set<string>();
  for (const action of actions) {
    if (action.kind === "MAP_FIELD_SET") {
      touches.add("map:" + action.field);
      continue;
    }
    const id =
      "entity" in action
        ? action.entity.id
        : "entityId" in action
          ? action.entityId
          : "";
    touches.add("entity:" + id);
    if (
      action.kind === "ENTITY_REORDER" ||
      (action.kind === "ENTITY_ADD" && Object.hasOwn(action, "afterId"))
    ) {
      touches.add("order:" + action.collection);
      if (action.afterId) touches.add("ref:" + action.afterId);
    }
  }
  return touches;
}
function applyCollaborativeActions(
  source: MapDefinition,
  actions: MapEditAction[],
) {
  const map = structuredClone(source);
  for (const action of actions) {
    if (action.kind === "MAP_FIELD_SET") {
      if (action.field === "name") map.name = action.value;
      else if (action.field === "spawnX") map.spawnX = action.value;
      else map.spawnY = action.value;
      continue;
    }
    const items = map[action.collection] as MapEditEntity[];
    if (action.kind === "ENTITY_ADD") {
      const index =
        action.afterId === undefined
          ? items.length
          : action.afterId === null
            ? 0
            : items.findIndex((item) => item.id === action.afterId) + 1;
      items.splice(index, 0, structuredClone(action.entity));
    } else if (action.kind === "ENTITY_REPLACE") {
      const index = items.findIndex((item) => item.id === action.entity.id);
      items[index] = structuredClone(action.entity);
    } else if (action.kind === "ENTITY_DELETE") {
      const index = items.findIndex((item) => item.id === action.entityId);
      items.splice(index, 1);
    } else {
      const index = items.findIndex((item) => item.id === action.entityId);
      const [item] = items.splice(index, 1);
      const anchor =
        action.afterId === null
          ? -1
          : items.findIndex((candidate) => candidate.id === action.afterId);
      items.splice(anchor + 1, 0, item);
    }
  }
  return map;
}
function fixture(options: { collaborative?: boolean } = {}) {
  const space = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "우리의 오피스",
    description: "함께 만드는 공간",
    visibility: "PRIVATE",
    capacity: 100,
    templateId: "OFFICE",
    role: "OWNER",
  };
  type MapState = {
    map: MapDefinition;
    published: MapDefinition;
    version: number;
    fence: number;
    client: string;
    token: string;
    revisions: Array<Record<string, unknown>>;
    editMode: "LEGACY" | "COLLABORATIVE";
    editSequence: number;
    operations: MapEditOperationEvent[];
  };
  const makeState = (initialMap: MapDefinition): MapState => ({
    map: structuredClone(initialMap),
    published: structuredClone(initialMap),
    version: 1,
    fence: 0,
    client: "",
    token: "",
    editMode: options.collaborative ? "COLLABORATIVE" : "LEGACY",
    editSequence: 0,
    operations: [],
    revisions: [
      {
        id: initialMap.revision,
        sequence: 1,
        createdAt: new Date().toISOString(),
        name: initialMap.name,
        reason: "INITIAL",
        map: structuredClone(initialMap),
      },
    ],
  });
  const states = new Map<string, MapState>([[space.id, makeState(original)]]);
  const order = [space.id];
  let entryMapId = space.id;
  const mapState = (id = space.id) => states.get(id)!;
  let assetPending = false,
    assetApproved = false;
  const failedMapLoads = new Set<string>();
  let failDraftWrites = false;
  let failPublishRequests = false;
  let publicationRequests = 0;
  let deferredPageKey: string | undefined;
  let deferredStarted = Promise.resolve();
  let signalDeferredStarted: (() => void) | undefined;
  let releaseDeferredOperation: (() => void) | undefined;
  const syncSnapshots = new Map<
    string,
    { sequence: number; map: MapDefinition }
  >();
  const uploadedAsset = {
    id: "custom_11111111-1111-4111-8111-111111111111",
    name: "테스트 나무",
    category: "사용자 에셋",
    width: 1,
    height: 1,
    footprint: null,
    url: "/api/v1/spaces/00000000-0000-4000-8000-000000000001/assets/custom_11111111-1111-4111-8111-111111111111/content",
    thumbnailUrl:
      "/api/v1/spaces/00000000-0000-4000-8000-000000000001/assets/custom_11111111-1111-4111-8111-111111111111/thumbnail",
    source: "uploaded",
    layer: "OBJECT",
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDjsAAAAASUVORK5CYII=",
    "base64",
  );
  const editor = (mapId = space.id) => ({
    version: mapState(mapId).version,
    map: mapState(mapId).map,
    publishedRevision: mapState(mapId).published.revision,
    issues: [],
  });
  async function install(
    page: Page,
    pageKey = "default",
    userId = pageKey,
    language: "ko" | "en" = "ko",
  ) {
    await page.addInitScript((selectedLanguage) => {
      localStorage.setItem("hufs.language", selectedLanguage);
    }, language);
    await authApi(page, { signedIn: true, userId, displayName: userId });
    await page.route("**/api/v1/spaces**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname,
        method = req.method(),
        multipart =
          req.headers()["content-type"]?.startsWith("multipart/form-data") ??
          false;
      const body =
        method === "GET" || multipart || !req.postData()
          ? {}
          : req.postDataJSON();
      const mapId = path.match(/\/maps\/([^/]+)(?:\/|$)/)?.[1];
      const summary = (id: string, sortOrder: number) => ({
        mapId: id,
        name: mapState(id).map.name,
        sortOrder,
        entry: id === entryMapId,
        version: mapState(id).version,
        publishedRevision: mapState(id).published.revision,
        updatedAt: new Date().toISOString(),
      });
      let result: unknown = {},
        status = 200,
        contentType = "application/json",
        responseBody: string | Buffer | undefined;
      if (path.endsWith("/spaces"))
        result = {
          items: [space],
          page: 1,
          pageSize: 12,
          totalItems: 1,
          totalPages: 1,
        };
      else if (path.endsWith("/maps") && method === "GET")
        result = order.map((id, index) => summary(id, index));
      else if (path.endsWith("/maps") && method === "POST") {
        const id = randomUUID();
        const map = structuredClone(original);
        map.id = id;
        map.revision = randomUUID();
        map.name = body.name;
        states.set(id, makeState(map));
        order.push(id);
        result = summary(id, order.length - 1);
      } else if (path.endsWith("/clone") && method === "POST" && mapId) {
        const id = randomUUID();
        const map = structuredClone(mapState(mapId).map);
        map.id = id;
        map.revision = randomUUID();
        map.name = body.name;
        states.set(id, makeState(map));
        order.push(id);
        result = summary(id, order.length - 1);
      } else if (path.endsWith("/entry") && method === "PUT" && mapId) {
        entryMapId = mapId;
        result = order.map((id, index) => summary(id, index));
      } else if (method === "DELETE" && /\/maps\/[^/]+$/.test(path) && mapId) {
        states.delete(mapId);
        order.splice(order.indexOf(mapId), 1);
        result = { deleted: true };
      } else if (path.endsWith("/maps/order") && method === "PUT") {
        order.splice(0, order.length, ...body.mapIds);
        result = order.map((id, index) => summary(id, index));
      } else if (path.endsWith("/assets/review"))
        result = assetPending
          ? [
              {
                id: uploadedAsset.id,
                name: uploadedAsset.name,
                uploadedBy: "외대 친구",
                width: uploadedAsset.width,
                height: uploadedAsset.height,
                uploadedAt: Date.now(),
                reviewContentUrl: `${uploadedAsset.url.replace("/content", "/review-content")}`,
              },
            ]
          : [];
      else if (
        path.endsWith("/review-content") ||
        path.endsWith("/thumbnail") ||
        path.endsWith("/content")
      ) {
        contentType = "image/png";
        responseBody = png;
      } else if (path.endsWith("/approve")) {
        assetPending = false;
        assetApproved = true;
        result = { ...uploadedAsset, status: "READY" };
      } else if (path.endsWith("/reject")) {
        assetPending = false;
        result = { rejected: true };
      } else if (path.endsWith("/assets") && method === "POST") {
        assetPending = true;
        result = { ...uploadedAsset, status: "PENDING" };
      } else if (path.endsWith("/assets") && method === "GET")
        result = assetApproved ? [{ ...uploadedAsset, status: "READY" }] : [];
      else if (path.endsWith("/map")) result = mapState().published;
      else if (path.endsWith("/published") && mapId)
        result = mapState(mapId).published;
      else if (path.includes("/publication/") && mapId) {
        publicationRequests++;
        const state = mapState(mapId);
        result = {
          revisionId: path.split("/").at(-1),
          sequence: state.revisions.length,
          state: "APPLIED",
          targetNodes: 1,
          appliedNodes: 1,
          pendingNodes: 0,
          offlineNodes: 0,
        };
      } else if (path.endsWith("/edit/mode") && mapId) {
        const state = mapState(mapId);
        result = {
          mode: state.editMode,
          sequence: state.editSequence,
          version: state.version,
        };
      } else if (path.endsWith("/edit/presence") && method === "GET") {
        result = { participants: [] };
      } else if (path.endsWith("/edit/presence") && method === "POST") {
        result = { updated: true };
      } else if (path.endsWith("/edit/presence") && method === "DELETE") {
        result = { removed: true };
      } else if (path.endsWith("/edit") && method === "GET" && mapId) {
        const state = mapState(mapId);
        const afterSequence = Number(
          new URL(req.url()).searchParams.get("afterSequence") ?? 0,
        );
        syncSnapshots.set(pageKey, {
          sequence: state.editSequence,
          map: structuredClone(state.map),
        });
        result = {
          editor: editor(mapId),
          sequence: state.editSequence,
          operations: state.operations.filter(
            (operation) => operation.sequence > afterSequence,
          ),
          hasMore: false,
        };
      } else if (
        path.endsWith("/edit/operations") &&
        method === "POST" &&
        mapId
      ) {
        if (pageKey === deferredPageKey) {
          deferredPageKey = undefined;
          await new Promise<void>((resolve) => {
            releaseDeferredOperation = resolve;
            signalDeferredStarted?.();
          });
        }
        const state = mapState(mapId);
        const actions = body.actions as MapEditAction[];
        const prior = state.operations.find(
          (operation) => operation.operationId === body.operationId,
        );
        if (prior) {
          result = {
            editor: editor(mapId),
            sequence: state.editSequence,
            operation: prior,
            duplicate: true,
          };
        } else if (
          state.operations.some(
            (operation) =>
              operation.sequence > Number(body.baseSequence) &&
              [...editTouches(operation.actions)].some((touch) =>
                editTouches(actions).has(touch),
              ),
          )
        ) {
          status = 409;
          result = {
            code: "MAP_EDIT_CONFLICT",
            message: "같은 맵 요소가 동시에 수정됐어요.",
            sequence: state.editSequence,
            editor: editor(mapId),
          };
        } else {
          state.map = applyCollaborativeActions(state.map, actions);
          state.editSequence++;
          state.version++;
          const operation: MapEditOperationEvent = {
            mapId,
            sequence: state.editSequence,
            actorId: userId,
            actorName: userId,
            clientId: body.clientId,
            operationId: body.operationId,
            baseSequence: body.baseSequence,
            undoOfSequence: null,
            actions,
            createdAt: new Date().toISOString(),
          };
          state.operations.push(operation);
          syncSnapshots.set(pageKey, {
            sequence: state.editSequence,
            map: structuredClone(state.map),
          });
          result = {
            editor: editor(mapId),
            sequence: state.editSequence,
            operation,
            duplicate: false,
          };
        }
      } else if (path.endsWith("/edit/publish") && method === "POST" && mapId) {
        const state = mapState(mapId);
        if (
          body.baseSequence !== state.editSequence ||
          body.baseVersion !== state.version
        ) {
          status = 409;
          result = {
            code: "MAP_EDIT_CONFLICT",
            message: "최신 상태를 확인해 주세요.",
          };
        } else {
          state.map.revision = "revision-" + (state.version + 1);
          state.version++;
          state.published = structuredClone(state.map);
          state.revisions.push({
            id: state.published.revision,
            sequence: state.revisions.length + 1,
            createdAt: new Date().toISOString(),
            name: state.map.name,
            reason: "PUBLISH",
            map: structuredClone(state.published),
          });
          result = {
            editor: editor(mapId),
            editSequence: state.editSequence,
            publishedEditSequence: state.editSequence,
            duplicate: false,
          };
        }
      } else if (
        mapId &&
        failedMapLoads.has(mapId) &&
        (path.endsWith("/lease") || path.endsWith("/editor"))
      ) {
        status = 503;
        result = {
          message: "맵 서버에 연결할 수 없어요.",
          code: "MAP_UNAVAILABLE",
        };
      } else if (path.endsWith("/editor") && mapId) result = editor(mapId);
      else if (path.endsWith("/history") && mapId)
        result = [...mapState(mapId).revisions].reverse();
      else if (path.endsWith("/lease") && mapId) {
        const state = mapState(mapId);
        if (state.client && body.clientId !== state.client && !body.takeover) {
          status = 409;
          result = {
            message: "다른 탭에서 편집 중이에요.",
            code: "MAP_EDITOR_BUSY",
          };
        } else {
          if (state.client !== body.clientId) {
            state.fence++;
            state.token = `token-${state.fence}`;
          }
          state.client = body.clientId;
          result = {
            token: state.token,
            fence: state.fence,
            expiresAt: new Date(Date.now() + 45_000).toISOString(),
            editor: editor(mapId),
          };
        }
      } else if (mapId && path.includes(`/maps/${mapId}/`)) {
        const state = mapState(mapId);
        const c = body.lease ?? body;
        if (
          c.token !== state.token ||
          c.fence !== state.fence ||
          c.clientId !== state.client
        ) {
          status = 409;
          result = {
            message: "편집 권한이 다른 탭으로 넘어갔어요.",
            code: "MAP_LEASE_LOST",
          };
        } else if (path.endsWith("/renew"))
          result = { expiresAt: new Date(Date.now() + 45_000).toISOString() };
        else if (path.endsWith("/release")) {
          state.client = "";
          result = { released: true };
        } else if (path.endsWith("/draft") && failDraftWrites) {
          status = 503;
          result = {
            message: "초안 서버에 연결할 수 없어요.",
            code: "MAP_UNAVAILABLE",
          };
        } else if (body.baseVersion !== state.version) {
          status = 409;
          result = { message: "초안 버전이 달라요." };
        } else if (path.endsWith("/draft")) {
          state.map = structuredClone(body.map);
          state.version++;
          result = editor(mapId);
        } else if (path.endsWith("/publish") && failPublishRequests) {
          status = 503;
          result = {
            message: "게시 서버에 연결할 수 없어요.",
            code: "MAP_UNAVAILABLE",
          };
        } else if (path.endsWith("/publish") || path.endsWith("/restore")) {
          if (body.revisionId)
            state.map = structuredClone(
              state.revisions.find((r) => r.id === body.revisionId)!
                .map as MapDefinition,
            );
          state.map.revision = `revision-${state.version}`;
          state.version++;
          state.published = structuredClone(state.map);
          state.revisions.push({
            id: state.map.revision,
            sequence: state.revisions.length + 1,
            createdAt: new Date().toISOString(),
            name: state.map.name,
            reason: body.revisionId ? "ROLLBACK" : "PUBLISH",
            map: structuredClone(state.map),
          });
          result = {
            ...editor(mapId),
            publication: {
              revisionId: state.published.revision,
              sequence: state.revisions.length,
              state: "APPLYING",
              targetNodes: 1,
              appliedNodes: 0,
              pendingNodes: 1,
              offlineNodes: 0,
            },
          };
        }
      } else result = space;
      await route.fulfill({
        status,
        contentType,
        body: responseBody ?? JSON.stringify(result),
      });
    });
    await page.goto("/");
    await page
      .getByRole("button", {
        name:
          language === "ko"
            ? "우리의 오피스 맵 편집"
            : `Edit the map for ${space.name}`,
      })
      .click();
    await expect(page.getByTestId("map-editor-canvas")).toBeVisible();
  }
  function deferOperationsFrom(pageKey: string) {
    deferredPageKey = pageKey;
    deferredStarted = new Promise<void>((resolve) => {
      signalDeferredStarted = resolve;
    });
  }
  function releaseDeferred() {
    releaseDeferredOperation?.();
    releaseDeferredOperation = undefined;
  }
  return {
    install,
    draft: () => mapState().map,
    draftVersion: () => mapState().version,
    published: () => mapState().published,
    names: () => order.map((id) => mapState(id).map.name),
    publicationRequests: () => publicationRequests,
    editSequence: () => mapState().editSequence,
    syncSnapshot: (pageKey: string) => syncSnapshots.get(pageKey),
    deferOperationsFrom,
    waitForDeferredOperation: () => deferredStarted,
    releaseDeferred,
    failMapLoad: (mapId: string, fail: boolean) => {
      if (fail) failedMapLoads.add(mapId);
      else failedMapLoads.delete(mapId);
    },
    failDraftWrites: (fail: boolean) => {
      failDraftWrites = fail;
    },
    failPublishRequests: (fail: boolean) => {
      failPublishRequests = fail;
    },
  };
}

for (const language of ["ko", "en"] as const) {
  test(`${language} map import errors explain the validation failure`, async ({
    page,
  }) => {
    const server = fixture();
    await server.install(
      page,
      `map-import-${language}`,
      `map-import-${language}`,
      language,
    );
    await page
      .locator('input[type="file"][accept=".json,application/json"]')
      .setInputFiles({
        name: "invalid-map.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({ ...original, width: 99_999 }),
          "utf8",
        ),
      });

    const expectedMessage =
      language === "ko"
        ? "맵 크기나 시작 위치가 편집 범위를 벗어났어요."
        : "The map dimensions or starting point are outside the editor limits.";
    await expect(page.getByRole("alert")).toContainText(expectedMessage);
    expect(server.draft().width).toBe(original.width);
  });
}

test("map editor controls pass WCAG 2.1 A/AA checks", async ({ page }) => {
  const server = fixture();
  await server.install(page);

  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      summary: node.failureSummary,
    })),
  }));
  expect(violations, "맵 편집기 접근성 위반").toEqual([]);

  await page
    .getByRole("button", { name: "배치: 책상 화분", exact: true })
    .click();
  const canvas = page.getByTestId("map-editor-canvas");
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({
    position: {
      x: (bounds.width * 23) / original.width,
      y: (bounds.height * 20) / original.height,
    },
  });
  await expect(page.getByText("74/500 가구", { exact: false })).toBeVisible();
  const selectedObjectResult = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    selectedObjectResult.violations.map((violation) => violation.id),
    "선택한 오브젝트 속성의 접근성 위반",
  ).toEqual([]);

  await page.getByRole("button", { name: "게시 이력", exact: true }).click();
  const historyDialog = page.getByRole("dialog", { name: "게시 이력" });
  await expect(historyDialog).toBeVisible();
  const historyResult = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    historyResult.violations.map((violation) => violation.id),
    "게시 이력 대화상자의 접근성 위반",
  ).toEqual([]);
});

async function answerEditorPrompt(page: Page, value: string) {
  const dialog = page.getByRole("dialog", {
    name: /지도 이름을 입력해 주세요\.|Enter a name for the new map\.|복제할 지도의 이름을 입력해 주세요\.|Enter a name for the copied map\./,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("textbox", { name: /^(지도 이름|Map name)$/ })
    .fill(value);
  await dialog.getByRole("button", { name: /^(확인|Confirm)$/ }).click();
}

async function answerEditorConfirmation(page: Page, accept = true) {
  const dialog = page.getByRole("dialog", {
    name: /^(작업을 확인해 주세요|Confirm this action)$/,
  });
  await expect(dialog).toBeVisible();
  if (accept)
    await dialog.getByRole("button", { name: /^(확인|Confirm)$/ }).click();
  else await dialog.locator(".editor-dialog-secondary").click();
}

test("two browser editors rebase disjoint offline edits and reconnect to the same map", async ({
  page,
  browser,
}) => {
  const server = fixture({ collaborative: true });
  await server.install(page, "browser-a", "editor-a");
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  try {
    await server.install(second, "browser-b", "editor-b");
    const initialLabelCount = server.draft().labels.length;
    server.deferOperationsFrom("browser-b");
    await second.getByRole("button", { name: "안내 도구" }).click();
    const secondCanvas = second.getByTestId("map-editor-canvas");
    await secondCanvas.focus();
    await secondCanvas.press("ArrowLeft");
    await secondCanvas.press("Enter");
    await second.getByRole("button", { name: "저장", exact: true }).click();
    await server.waitForDeferredOperation();

    await page
      .getByRole("textbox", { name: "맵 이름" })
      .fill("브라우저 A 변경");
    const saveButton = page.getByRole("button", {
      name: "저장",
      exact: true,
    });
    if (await saveButton.isEnabled()) await saveButton.click();
    await expect.poll(() => server.editSequence()).toBe(1);
    expect(server.draft().name).toBe("브라우저 A 변경");

    server.releaseDeferred();
    await expect.poll(() => server.editSequence()).toBe(2);
    await expect
      .poll(() => server.draft().labels.length)
      .toBe(initialLabelCount + 1);
    await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
      "브라우저 A 변경",
    );
    await expect(second.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
      "브라우저 A 변경",
    );
    await expect.poll(() => server.syncSnapshot("browser-a")?.sequence).toBe(2);
    expect(server.syncSnapshot("browser-a")?.map).toEqual(
      server.syncSnapshot("browser-b")?.map,
    );

    await second.close();
    const reconnectContext = await browser.newContext();
    try {
      const reconnect = await reconnectContext.newPage();
      await server.install(reconnect, "browser-b-reconnected", "editor-b");
      await expect(
        reconnect.getByRole("textbox", { name: "맵 이름" }),
      ).toHaveValue("브라우저 A 변경");
      expect(server.syncSnapshot("browser-b-reconnected")?.sequence).toBe(2);
      expect(server.syncSnapshot("browser-b-reconnected")?.map).toEqual(
        server.syncSnapshot("browser-a")?.map,
      );
    } finally {
      await reconnectContext.close();
    }
  } finally {
    server.releaseDeferred();
    await secondContext.close();
  }
});
test("places furniture, undoes, saves, publishes, reloads and restores a map", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const server = fixture();
  await server.install(page);
  await page
    .getByRole("button", { name: "배치: 책상 화분", exact: true })
    .click();
  const canvas = page.getByTestId("map-editor-canvas");
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({
    position: {
      x: (bounds.width * 23) / original.width,
      y: (bounds.height * 20) / original.height,
    },
  });
  await expect(page.getByText("74/500 가구", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(page.getByText("73/500 가구", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "다시 실행", exact: true }).click();
  await page.getByRole("textbox", { name: "맵 이름" }).fill("우리 팀의 오피스");
  await expect.poll(() => server.draft().name).toBe("우리 팀의 오피스");
  expect(server.published().name).toBe(original.name);
  await page.getByRole("button", { name: "맵 게시", exact: true }).click();
  await expect.poll(() => server.published().objects.length).toBe(74);
  await expect(
    page.getByText("맵이 게시됐고 연결된 월드에 반영됐어요."),
  ).toBeVisible();
  expect(server.publicationRequests()).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/map-editor-desktop.png" });
  await page.getByRole("button", { name: "공간 목록으로" }).click();
  await page.getByRole("button", { name: "우리의 오피스 맵 편집" }).click();
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    "우리 팀의 오피스",
  );
  await page.getByRole("button", { name: "게시 이력", exact: true }).click();
  await page.getByRole("button", { name: "복원", exact: true }).click();
  await answerEditorConfirmation(page);
  await expect.poll(() => server.published().name).toBe(original.name);
  await expect(page.getByText("73/500 가구", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test("grid display and pointer snapping can be controlled independently", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const gridToggle = page.getByRole("button", { name: "그리드", exact: true });
  await expect(gridToggle).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "그리드 스냅 끄기" }).click();
  await expect(
    page.getByRole("button", { name: "그리드 스냅 켜기" }),
  ).toHaveAttribute("aria-pressed", "false");
  await gridToggle.click();
  await expect(gridToggle).toHaveAttribute("aria-pressed", "false");

  await page
    .getByRole("button", { name: "배치: 책상 화분", exact: true })
    .click();
  const canvas = page.getByTestId("map-editor-canvas");
  const bounds = (await canvas.boundingBox())!;
  const clickAt = (x: number, y: number) =>
    canvas.click({
      position: {
        x: (bounds.width * x) / original.width,
        y: (bounds.height * y) / original.height,
      },
    });
  await clickAt(23.31, 20.17);
  await expect
    .poll(() => server.draft().objects.length)
    .toBe(original.objects.length + 1);
  const preciseObject = server.draft().objects.at(-1)!;
  expect(preciseObject.x).toBeCloseTo(23.31, 1);
  expect(preciseObject.y).toBeCloseTo(20.17, 1);

  await page.getByRole("button", { name: "그리드 스냅 켜기" }).click();
  await clickAt(23.31, 20.17);
  await expect
    .poll(() => server.draft().objects.length)
    .toBe(original.objects.length + 2);
  const snappedObject = server.draft().objects.at(-1)!;
  expect(snappedObject.x).toBe(23.5);
  expect(snappedObject.y).toBe(20);
  await expect(gridToggle).toHaveAttribute("aria-pressed", "false");
});

test("floor brush and fill preserve the shared half-tile map grid", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const canvas = page.getByTestId("map-editor-canvas");
  const bounds = (await canvas.boundingBox())!;
  const screenPoint = (x: number, y: number) => ({
    x: bounds.x + (bounds.width * x) / original.width,
    y: bounds.y + (bounds.height * y) / original.height,
  });
  const initialFloorCount = server.draft().floors.length;

  await page.getByRole("button", { name: "브러시 도구" }).click();
  await page.getByLabel("바닥 재질").selectOption("PAVERS");
  const start = screenPoint(5.1, 4.1);
  const end = screenPoint(6.1, 4.1);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect
    .poll(() => server.draft().floors.length)
    .toBeGreaterThan(initialFloorCount);

  const brushFloors = server.draft().floors.slice(initialFloorCount);
  expect(brushFloors).toContainEqual({
    id: expect.any(String),
    material: "PAVERS",
    bounds: { x: 5, y: 4, width: 1.5, height: 0.5 },
  });

  const afterBrushCount = server.draft().floors.length;
  await page.getByRole("button", { name: "채우기 도구" }).click();
  await page.getByLabel("바닥 재질").selectOption("CONCRETE");
  const fillPoint = screenPoint(10, 5);
  await page.mouse.click(fillPoint.x, fillPoint.y);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect
    .poll(() => server.draft().floors.length)
    .toBeGreaterThan(afterBrushCount);

  const filledFloors = server.draft().floors.slice(afterBrushCount);
  expect(filledFloors.length).toBeGreaterThan(0);
  for (const floor of filledFloors) {
    for (const value of [
      floor.bounds.x,
      floor.bounds.y,
      floor.bounds.width,
      floor.bounds.height,
    ])
      expect(value * 2).toBeCloseTo(Math.round(value * 2), 8);
  }
});

test("moving a selected object keeps its collision footprint aligned to the half-tile grid", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const target = server
    .draft()
    .objects.find((object) => object.asset === "whiteboard")!;
  const items = page.locator("details.editor-items-list");
  await items.locator("summary").click();
  await items.getByRole("button", { name: /가구: 화이트보드/ }).click();
  const canvas = page.getByTestId("map-editor-canvas");
  await canvas.focus();
  await canvas.press("ArrowRight");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect
    .poll(
      () => server.draft().objects.find((object) => object.id === target.id)?.x,
    )
    .toBe(target.x + 0.5);
  expect(server.draft().collisions).toContainEqual({
    x: 6.625,
    y: 3.6,
    width: 3.75,
    height: 0.4,
  });
});

test("rotates a selected object and saves the matching collision footprint", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const target = server
    .draft()
    .objects.find((object) => object.asset === "whiteboard")!;
  const items = page.locator("details.editor-items-list");
  await items.locator("summary").click();
  await items.getByRole("button", { name: /가구: 화이트보드/ }).click();
  await page
    .getByRole("combobox", { name: "오브젝트 방향" })
    .selectOption("right");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect
    .poll(
      () =>
        server.draft().objects.find((object) => object.id === target.id)
          ?.direction,
    )
    .toBe("right");
  const footprint = server
    .draft()
    .collisions.find(
      (rect) =>
        Math.abs(rect.width - 0.4) < 0.01 &&
        Math.abs(rect.height - 3.75) < 0.01,
    )!;
  expect(footprint.x).toBeCloseTo(6.5, 6);
  expect(footprint.y).toBeCloseTo(0.625, 6);
  expect(footprint.width).toBeCloseTo(0.4, 6);
  expect(footprint.height).toBeCloseTo(3.75, 6);
});

test("keyboard duplicate, undo and redo each apply one editor operation", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const initial = server.draft();
  const originalIds = new Set(initial.objects.map((object) => object.id));
  const target = initial.objects.find(
    (object) => object.asset === "whiteboard",
  )!;
  const items = page.locator("details.editor-items-list");
  await items.locator("summary").click();
  await items.getByRole("button", { name: /가구: 화이트보드/ }).click();
  const canvas = page.getByTestId("map-editor-canvas");
  await canvas.focus();
  await canvas.press("Control+c");
  await canvas.press("Control+v");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect
    .poll(() => server.draft().objects.length)
    .toBe(initial.objects.length + 1);
  const duplicates = server
    .draft()
    .objects.filter((object) => !originalIds.has(object.id));
  expect(duplicates).toHaveLength(1);
  expect(duplicates[0]).toMatchObject({
    asset: target.asset,
    x: target.x + 0.5,
    y: target.y + 0.5,
  });
  expect(new Set(server.draft().objects.map((object) => object.id)).size).toBe(
    server.draft().objects.length,
  );

  await canvas.press("Control+z");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect
    .poll(() => server.draft().objects.length)
    .toBe(initial.objects.length);
  await canvas.press("Control+Shift+z");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect
    .poll(() => server.draft().objects.length)
    .toBe(initial.objects.length + 1);
  expect(
    server.draft().objects.find((object) => !originalIds.has(object.id)),
  ).toEqual(duplicates[0]);
});

test("places a private meeting zone with keyboard-only controls", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const originalZoneCount = server.draft().zones.length;
  await page.getByRole("button", { name: "구역 도구" }).click();
  const canvas = page.getByTestId("map-editor-canvas");
  await canvas.focus();

  const announcement = page.locator(
    ".editor-canvas-wrap [role='status'][aria-live='polite']",
  );
  await canvas.press("Enter");
  await expect(announcement).toContainText("구역 시작점");
  await canvas.press("ArrowRight");
  await canvas.press("ArrowDown");
  await expect(announcement).toContainText("구역 끝점");
  await canvas.press("Enter");
  await expect(announcement).toContainText("대화 구역을");

  const save = page.getByRole("button", { name: "저장", exact: true });
  await save.click();
  await expect
    .poll(() => server.draft().zones.length)
    .toBe(originalZoneCount + 1);
  expect(server.draft().zones.at(-1)).toMatchObject({
    name: "새 회의 구역",
    kind: "PRIVATE",
    bounds: { width: 0.5, height: 0.5 },
  });
});

test("keyboard-only editor places floors, walls, portals and labels, then erases", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const canvas = page.getByTestId("map-editor-canvas");
  const announcement = page.locator(
    ".editor-canvas-wrap [role='status'][aria-live='polite']",
  );
  const save = async (persisted: () => boolean) => {
    await expect.poll(persisted).toBe(true);
  };

  const initialFloorCount = server.draft().floors.length;
  await page.getByRole("button", { name: "바닥 도구" }).click();
  await canvas.focus();
  await canvas.press("Enter");
  await canvas.press("ArrowRight");
  await canvas.press("ArrowDown");
  await canvas.press("Enter");
  await expect(announcement).toContainText("바닥을");
  await save(() => server.draft().floors.length === initialFloorCount + 1);
  expect(server.draft().floors).toHaveLength(initialFloorCount + 1);

  const initialWallCount = server.draft().walls.length;
  await page.getByRole("button", { name: "벽 도구" }).click();
  await canvas.focus();
  await canvas.press("Enter");
  await canvas.press("ArrowDown");
  await canvas.press("Enter");
  await expect(announcement).toContainText("벽을");
  await save(() => server.draft().walls.length === initialWallCount + 1);
  expect(server.draft().walls).toHaveLength(initialWallCount + 1);

  await page.getByRole("button", { name: "포털 도구" }).click();
  await canvas.focus();
  await canvas.press("Enter");
  await expect(announcement).toContainText("포털 시작점");
  await canvas.press("Escape");
  await expect(announcement).toContainText("포털 배치를 취소했습니다.");
  expect(server.draft().portals ?? []).toHaveLength(0);
  await page.getByRole("button", { name: "포털 도구" }).click();
  await canvas.focus();
  await canvas.press("Enter");
  await canvas.press("ArrowRight");
  await canvas.press("ArrowDown");
  await canvas.press("Enter");
  await expect(announcement).toContainText("포털을");
  await save(() => server.draft().portals?.length === 1);
  expect(server.draft().portals).toHaveLength(1);

  const initialLabelCount = server.draft().labels.length;
  await page.getByRole("button", { name: "안내 도구" }).click();
  await canvas.focus();
  await canvas.press("ArrowLeft");
  await canvas.press("Enter");
  await expect(announcement).toContainText("새 안내 문구를");
  await save(() => server.draft().labels.length === initialLabelCount + 1);
  expect(server.draft().labels).toHaveLength(initialLabelCount + 1);

  await page.getByRole("button", { name: "지우기 도구" }).click();
  await canvas.focus();
  await canvas.press("Enter");
  await expect(announcement).toContainText("을(를) 지웠습니다.");
  await save(() => server.draft().labels.length === initialLabelCount);
  expect(server.draft().labels).toHaveLength(initialLabelCount);
});

test("configures and publishes the private meeting-room capacity", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const items = page.locator("details.editor-items-list");
  await items.locator("summary").click();
  await items.getByRole("button", { name: /구역: 회의실 A/ }).click();
  const capacity = page.getByRole("spinbutton", { name: /회의실 정원/ });
  await expect(capacity).toHaveValue("12");
  await capacity.fill("24");
  await expect
    .poll(
      () =>
        server.draft().zones.find((zone) => zone.id === "meeting-a")?.capacity,
    )
    .toBe(24);
  await page.getByRole("button", { name: "맵 게시", exact: true }).click();
  await expect
    .poll(
      () =>
        server.published().zones.find((zone) => zone.id === "meeting-a")
          ?.capacity,
    )
    .toBe(24);
});
test("marks an event stage and explains its speaker policy", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const items = page.locator("details.editor-items-list");
  await items.locator("summary").click();
  await items.getByRole("button", { name: /구역: 카페 라운지/ }).click();
  await page.getByRole("combobox", { name: "구역 종류" }).selectOption("STAGE");
  await expect(
    page.getByText(
      "발표 중에는 지정된 발표자만 이 무대 안에서 송출할 수 있고, 참가자는 발표를 듣습니다.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: /회의실 정원/ }),
  ).toHaveCount(0);
  await expect
    .poll(() => server.draft().zones.find((zone) => zone.id === "lounge")?.kind)
    .toBe("STAGE");
  await page.getByRole("button", { name: "맵 게시", exact: true }).click();
  await expect
    .poll(
      () => server.published().zones.find((zone) => zone.id === "lounge")?.kind,
    )
    .toBe("STAGE");
});
test("configures and publishes proximity based ambient sound", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const objectId = server.draft().objects[0].id;
  const items = page.locator("details.editor-items-list");
  await items.locator("summary").click();
  await items
    .getByRole("button", { name: /^가구:/ })
    .first()
    .click();
  await page
    .getByRole("combobox", { name: "클릭 상호작용" })
    .selectOption("SOUND");
  await page.getByRole("textbox", { name: "제목" }).fill("라운지 환경음");
  await page
    .getByRole("textbox", { name: "URL" })
    .fill("https://cdn.example.test/lounge.ogg");
  await page.getByRole("slider").nth(0).fill("10");
  await page.getByRole("slider").nth(1).fill("65");
  await expect
    .poll(
      () =>
        server.draft().objects.find((object) => object.id === objectId)
          ?.interaction,
    )
    .toMatchObject({
      kind: "SOUND",
      title: "라운지 환경음",
      url: "https://cdn.example.test/lounge.ogg",
      radius: 10,
      volume: 65,
    });
  await page.getByRole("button", { name: "맵 게시", exact: true }).click();
  await expect
    .poll(
      () =>
        server.published().objects.find((object) => object.id === objectId)
          ?.interaction,
    )
    .toMatchObject({
      kind: "SOUND",
      title: "라운지 환경음",
      radius: 10,
      volume: 65,
    });
});
test("a second editor is read only until takeover and the old editor retains a recovery copy", async ({
  page,
  context,
}) => {
  const server = fixture();
  await server.install(page);
  const second = await context.newPage();
  await server.install(second);
  await expect(second.getByText("읽기 모드 ·", { exact: false })).toBeVisible();
  await expect(second.getByRole("textbox", { name: "맵 이름" })).toBeDisabled();
  await page
    .getByRole("textbox", { name: "맵 이름" })
    .fill("저장되지 않은 복구본");
  await expect(
    page.getByRole("button", { name: "저장", exact: true }),
  ).toBeEnabled();
  await second.getByRole("button", { name: "편집 권한 가져오기" }).click();
  await expect(second.getByRole("textbox", { name: "맵 이름" })).toBeEnabled();
  await expect(page.getByText("읽기 모드 ·", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toBeDisabled();
  const recovery = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith("hufs.map-recovery."))
      .map((k) => localStorage.getItem(k))
      .join(""),
  );
  expect(recovery).toContain("저장되지 않은 복구본");
  expect(server.draft().name).toBe(original.name);
  await second.close();
});

test("a failed save survives closing and reopening the editor as a recoverable draft", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  await page
    .getByRole("textbox", { name: "맵 이름" })
    .fill("오프라인 복구 초안");
  server.failDraftWrites(true);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "초안 서버에 연결할 수 없어요.",
  );
  expect(server.draft().name).toBe(original.name);

  await page.getByRole("button", { name: "공간 목록으로" }).click();
  await answerEditorConfirmation(page);
  await expect(
    page.getByRole("button", { name: "우리의 오피스 맵 편집" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "우리의 오피스 맵 편집" }).click();
  await expect(
    page.getByText("이 브라우저에 저장하지 못한 복구본이 있어요."),
  ).toBeVisible();
  await page.getByRole("button", { name: "복구본 불러오기" }).click();
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    "오프라인 복구 초안",
  );

  server.failDraftWrites(false);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => server.draft().name).toBe("오프라인 복구 초안");
  await expect(
    page.getByText("이 브라우저에 저장하지 못한 복구본이 있어요."),
  ).toHaveCount(0);
});

test("saving a newer draft clears the stale recovery copy from the reopened editor", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  await page
    .getByRole("textbox", { name: "맵 이름" })
    .fill("오래된 로컬 복구본");
  server.failDraftWrites(true);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "초안 서버에 연결할 수 없어요.",
  );

  await page.getByRole("button", { name: "공간 목록으로" }).click();
  await answerEditorConfirmation(page);
  await page.getByRole("button", { name: "우리의 오피스 맵 편집" }).click();
  await expect(
    page.getByText("이 브라우저에 저장하지 못한 복구본이 있어요."),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "맵 이름" }).fill("새 서버 초안");

  server.failDraftWrites(false);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => server.draft().name).toBe("새 서버 초안");
  await expect(
    page.getByText("이 브라우저에 저장하지 못한 복구본이 있어요."),
  ).toHaveCount(0);
  const recoveryKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) =>
      key.startsWith("hufs.map-recovery."),
    ),
  );
  expect(recoveryKeys).toEqual([]);
});

test("a failed publish keeps the saved draft and published map safe after reopening", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  await page.getByRole("textbox", { name: "맵 이름" }).fill("게시 재시도 초안");
  server.failPublishRequests(true);
  await page.getByRole("button", { name: "맵 게시", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "게시 서버에 연결할 수 없어요.",
  );
  await expect.poll(() => server.draft().name).toBe("게시 재시도 초안");
  expect(server.published().name).toBe(original.name);

  await page.getByRole("button", { name: "공간 목록으로" }).click();
  await page.getByRole("button", { name: "우리의 오피스 맵 편집" }).click();
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    "게시 재시도 초안",
  );
  expect(server.published().name).toBe(original.name);

  server.failPublishRequests(false);
  await page.getByRole("button", { name: "맵 게시", exact: true }).click();
  await expect.poll(() => server.published().name).toBe("게시 재시도 초안");
});

test("uploaded images stay out of the map until the owner approves them", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  await page
    .locator('input[type="file"][accept="image/png,image/jpeg"]')
    .setInputFiles({
      name: "test-sprite.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDjsAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await expect(page.locator(".editor-asset-notice")).toContainText(
    "공간 소유자의 승인이",
  );
  const queue = page.getByRole("region", { name: "에셋 승인 대기" });
  await expect(queue).toContainText("테스트 나무");
  await queue.getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.locator(".editor-asset-notice")).toContainText(
    "맵에 배치할 수 있어요",
  );
  await expect(queue).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "배치: 테스트 나무", exact: true }),
  ).toBeVisible();
});

test("editor action dialogs fit on mobile and restore hidden input", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /새 지도/ }).click();
  const createDialog = page.getByRole("dialog", {
    name: "새 지도 이름을 입력해 주세요.",
  });
  await expect(createDialog).toBeVisible();
  const bounds = await createDialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await createDialog.getByRole("textbox", { name: "지도 이름" }).fill("회의실");
  await createDialog.getByRole("button", { name: "창 숨기기" }).click();
  await expect(createDialog).not.toBeVisible();
  const restoreDialog = page.getByRole("button", {
    name: "새 지도 이름을 입력해 주세요. 다시 열기",
  });
  await expect(restoreDialog).toBeVisible();
  await restoreDialog.click();
  await expect(createDialog).toBeVisible();
  await expect(
    createDialog.getByRole("textbox", { name: "지도 이름" }),
  ).toHaveValue("회의실");
  await createDialog.locator(".editor-dialog-secondary").click();
  expect(server.names()).toEqual([original.name]);
});

test("editor action confirmations use the selected language", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page, "english-dialog", "english-dialog", "en");
  const mapName = page.getByRole("textbox", { name: "Map name" });
  await mapName.fill("Unsaved map");
  await page.getByRole("button", { name: "New map" }).click();
  await answerEditorPrompt(page, "Extra map");

  const confirmation = page.getByRole("dialog", {
    name: "Confirm this action",
  });
  await expect(confirmation).toContainText(
    "Save the current map changes before creating a new map?",
  );
  await confirmation.locator(".editor-dialog-secondary").click();
  await expect(page.getByRole("textbox", { name: "Map name" })).toHaveValue(
    "Unsaved map",
  );
  expect(server.names()).toHaveLength(1);
});

test("creates another map and keeps its saved draft separate from the entry map", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  await page.getByRole("button", { name: /새 지도/ }).click();
  await answerEditorPrompt(page, "회의실");
  const picker = page.getByRole("combobox", { name: "편집할 지도" });
  await expect(picker).not.toHaveValue("00000000-0000-4000-8000-000000000001");
  const meetingRoomId = await picker.inputValue();
  expect(meetingRoomId).not.toBe("00000000-0000-4000-8000-000000000001");
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    "회의실",
  );
  await page.getByRole("textbox", { name: "맵 이름" }).fill("회의실 초안");
  await picker.selectOption("00000000-0000-4000-8000-000000000001");
  await answerEditorConfirmation(page);
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    original.name,
  );
  expect(server.names()).toEqual([original.name, "회의실 초안"]);
  await picker.selectOption(meetingRoomId);
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    "회의실 초안",
  );
  await page.getByRole("button", { name: "입장 지도로 설정" }).click();
  await expect(picker.locator("option:checked")).toContainText("입장 지도");
  await page.getByRole("button", { name: "지도 복제" }).click();
  await answerEditorPrompt(page, "회의실 복제");
  await expect(picker).not.toHaveValue(meetingRoomId);
  const cloneId = await picker.inputValue();
  expect(cloneId).not.toBe(meetingRoomId);
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    "회의실 복제",
  );
  await page.getByRole("button", { name: "지도 삭제" }).click();
  await answerEditorConfirmation(page);
  await expect(picker).toHaveValue(meetingRoomId);
  expect(server.names()).toEqual([original.name, "회의실 초안"]);
});

test("saves the current draft before creating another map", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  await page.getByRole("textbox", { name: "맵 이름" }).fill("먼저 저장할 초안");
  await page.getByRole("button", { name: /새 지도/ }).click();
  await answerEditorPrompt(page, "추가 지도");
  await answerEditorConfirmation(page);
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    "추가 지도",
  );
  expect(server.draft().name).toBe("먼저 저장할 초안");
});

test("clears the previous map while another map is loading", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  await page.route("**/api/v1/spaces/*/maps/*/lease", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fallback();
  });
  await page.getByRole("button", { name: /새 지도/ }).click();
  await answerEditorPrompt(page, "느린 지도");
  await expect(page.locator(".editor-loading")).toHaveText(
    "선택한 지도를 불러오는 중…",
  );
  await expect(page.getByTestId("map-editor-canvas")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveCount(0);
  await expect(page.getByTestId("map-editor-canvas")).toBeVisible();
});

test("shows an empty-map hint and recovers from a map load error", async ({
  page,
}) => {
  const server = fixture();
  await server.install(page);
  const emptyMap = structuredClone(original);
  emptyMap.objects = [];
  emptyMap.walls = [];
  emptyMap.zones = [];
  emptyMap.labels = [];
  emptyMap.portals = [];
  await page.getByLabel("맵 JSON 가져오기").setInputFiles({
    name: "empty-map.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(emptyMap)),
  });
  await answerEditorConfirmation(page);
  await expect(page.getByText(/아직 배치한 오브젝트가 없어요/)).toBeVisible();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".editor-status")).toContainText("초안 저장됨");
  const picker = page.getByRole("combobox", { name: "편집할 지도" });
  await expect(picker).toBeEnabled();

  await page.getByRole("button", { name: /새 지도/ }).click();
  await answerEditorPrompt(page, "복구 검사 지도");
  await expect(picker).not.toHaveValue("00000000-0000-4000-8000-000000000001");
  const failingMapId = await picker.inputValue();
  await expect(picker).toBeEnabled();
  await picker.selectOption("00000000-0000-4000-8000-000000000001");
  await expect(picker).toHaveValue("00000000-0000-4000-8000-000000000001");
  await expect(page.getByRole("textbox", { name: "맵 이름" })).toHaveValue(
    original.name,
  );
  await expect(picker).toBeEnabled();
  server.failMapLoad(failingMapId, true);
  await picker.selectOption(failingMapId);
  await expect(picker).toHaveValue(failingMapId);
  await expect(
    page.getByRole("group", { name: "지도 불러오기 오류" }),
  ).toBeVisible();
  await expect(page.getByTestId("map-editor-canvas")).toHaveCount(0);
  server.failMapLoad(failingMapId, false);
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("map-editor-canvas")).toBeVisible();
});
