import { test, expect } from "@playwright/test";
import { authApi } from "../fixtures/auth-api";

test("create a private space, manage invites, change visibility and find it again", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  const spaces: Array<Record<string, unknown>> = [];
  const edits: Array<Record<string, unknown>> = [];
  const invites: Array<{
    id: string;
    expiresAt: string;
    maxUses: number;
    useCount: number;
    revoked: boolean;
  }> = [];
  const spacePage = (request: import("@playwright/test").Request) => {
    const url = new URL(request.url());
    const query = (url.searchParams.get("q") ?? "").toLocaleLowerCase();
    const items = spaces.filter(
      (space) =>
        !query ||
        `${space.name ?? ""} ${space.description ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
    );
    return {
      items,
      page: 1,
      pageSize: 12,
      totalItems: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / 12)),
    };
  };
  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");
    let body: unknown = spacePage(request);
    let status = 200;
    if (path.endsWith("/spaces") && method === "POST") {
      const space = {
        ...request.postDataJSON(),
        id: "private-space",
        role: "OWNER",
      };
      spaces.push(space);
      body = space;
    } else if (path.endsWith("/private-space") && method === "GET") {
      body = spaces[0];
    } else if (path.endsWith("/private-space") && method === "PATCH") {
      const edit = request.postDataJSON();
      edits.push(edit);
      Object.assign(spaces[0], edit);
      body = spaces[0];
    } else if (path.endsWith("/invites") && method === "POST") {
      const draft = request.postDataJSON();
      const invite = {
        id: "invite-one",
        expiresAt: new Date(Date.now() + draft.hours * 3600000).toISOString(),
        maxUses: draft.maxUses,
        useCount: 0,
        revoked: false,
      };
      invites.push(invite);
      body = { invite, code: "local-invitation-123456" };
    } else if (path.endsWith("/invites")) body = invites;
    else if (path.endsWith("/revoke")) {
      invites[0].revoked = true;
      body = { revoked: true };
    } else if (path.endsWith("/redeem")) {
      status = 400;
      body = { message: "유효하지 않거나 만료·취소된 초대예요." };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "새 공간 만들기", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("공간 이름", { exact: true }).fill("GDG 스터디 라운지");
  await page
    .getByLabel("한 줄 소개", { exact: true })
    .fill("함께 배우는 도트 캠퍼스");
  await page.getByLabel("동시 접속 인원", { exact: false }).fill("12");
  await page.getByRole("button", { name: "공간 만들기", exact: true }).click();
  const card = page.getByRole("article");
  await expect(card).toContainText("비공개");
  await expect(card).toContainText("최대 12명");
  await page
    .getByRole("button", { name: "GDG 스터디 라운지 초대 관리" })
    .click();
  await page.getByLabel("수락 가능 인원").fill("3");
  await page.getByRole("button", { name: "초대 코드 만들기" }).click();
  await expect(page.getByLabel("새 초대 코드", { exact: true })).toHaveValue(
    "local-invitation-123456",
  );
  await expect(page.getByText("사용 가능 · 0/3명")).toBeVisible();
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByText("취소됨 · 0/3명")).toBeVisible();
  await page.getByRole("button", { name: "닫기" }).click();
  await page.getByRole("button", { name: "GDG 스터디 라운지 설정" }).click();
  await page.getByRole("radio", { name: /^공개 모든/ }).check();
  await page
    .getByRole("checkbox", { name: /로그인 없이 게스트 입장 허용/ })
    .check();
  await page.getByRole("button", { name: "설정 저장" }).click();
  await expect.poll(() => spaces[0]?.guestEntryEnabled).toBe(true);
  expect(spaces[0].guestEntryEnabled).toBe(true);
  expect(spaces[0].allowedEmailDomains).toEqual([]);
  await expect(card.locator(".visibility-badge")).toHaveText("공개");
  await page.getByRole("button", { name: "GDG 스터디 라운지 설정" }).click();
  await page.getByLabel("허용할 이메일 도메인").fill("HUFS.AC.KR, example.edu");
  await expect(
    page.getByRole("checkbox", { name: /로그인 없이 게스트 입장 허용/ }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "설정 저장" }).click();
  await expect.poll(() => spaces[0]?.guestEntryEnabled).toBe(false);
  expect(edits.at(-1)?.guestEntryEnabled).toBe(false);
  expect(edits.at(-1)?.allowedEmailDomains).toEqual([
    "hufs.ac.kr",
    "example.edu",
  ]);
  expect(spaces[0].guestEntryEnabled).toBe(false);
  expect(spaces[0].allowedEmailDomains).toEqual(["hufs.ac.kr", "example.edu"]);
  await page.reload();
  await expect(card).toContainText("GDG 스터디 라운지");
  await page.getByLabel("공간 검색").fill("없는 공간");
  await expect(page.getByText("검색한 공간이 없어요")).toBeVisible();
  await page.getByLabel("공간 검색").fill("");
  await page.getByRole("button", { name: "내 공간", exact: true }).click();
  await expect(card).toHaveCount(1);
  await page.getByLabel("초대받으셨나요?").fill("invalid");
  await page.getByRole("button", { name: "초대 수락" }).click();
  await expect(page.getByRole("alert")).toContainText("만료·취소");
  await page.screenshot({
    path: "test-results/spaces-desktop.png",
    fullPage: true,
  });
});

test("invite link survives the login callback and opens the invited space on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authApi(page);
  await page.goto("/#invite=local-invitation-123456");
  await expect(page).toHaveURL(`${test.info().project.use.baseURL}/`);
  await page.goto("/auth/callback?code=test-code&state=test-state");
  await expect(page.getByLabel("초대받으셨나요?")).toHaveValue(
    "local-invitation-123456",
  );
  await page.route("**/api/v1/spaces/redeem", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      code: "local-invitation-123456",
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "invited",
        name: "친구의 비밀 정원",
        description: "초대받은 공간",
        visibility: "PRIVATE",
        capacity: 8,
        role: "MEMBER",
      }),
    });
  });
  await page.getByRole("button", { name: "초대 수락" }).click();
  await expect(page.getByRole("dialog")).toContainText("친구의 비밀 정원");
  await expect(page.getByLabel("초대받으셨나요?")).toHaveValue("");
  await page.getByRole("button", { name: "닫기" }).click();
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflowingElements: Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )
      .map((element) => ({
        name: element.tagName.toLowerCase(),
        className:
          typeof element.className === "string" ? element.className : "",
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width),
      }))
      .filter((element) => element.left < -1 || element.right > innerWidth + 1)
      .slice(0, 8),
  }));
  expect(
    mobileLayout.documentWidth,
    JSON.stringify(mobileLayout.overflowingElements),
  ).toBeLessThanOrEqual(mobileLayout.viewportWidth);
  await page.screenshot({
    path: "test-results/spaces-mobile.png",
    fullPage: true,
  });
});

test("space apps require approval and pass context through a sandboxed bridge", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  const spaceId = "extension-space";
  const extensionId = "extension-app-one";
  const apps: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");
    let status = 200;
    let body: unknown = [];
    if (path === "/api/v1/spaces" && method === "GET") {
      const space = {
        id: spaceId,
        name: "Extension test space",
        description: "Members can try approved apps.",
        visibility: "PUBLIC",
        capacity: 100,
        templateId: "OFFICE",
        role: "OWNER",
        approvalRequired: false,
        guestEntryEnabled: false,
        allowedEmailDomains: [],
        joinRequestStatus: "",
        favorite: false,
        archived: false,
      };
      body = {
        items: [space],
        page: 1,
        pageSize: 12,
        totalItems: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      };
    } else if (
      path === `/api/v1/spaces/${spaceId}/extensions` &&
      method === "GET"
    ) {
      body = apps;
    } else if (
      path === `/api/v1/spaces/${spaceId}/extensions` &&
      method === "POST"
    ) {
      const draft = request.postDataJSON();
      const app = {
        id: extensionId,
        name: draft.name,
        launchUrl: draft.launchUrl,
        origin: "https://apps.example.org",
        requestedPermissions: draft.requestedPermissions,
        approvedPermissions: [],
        enabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      apps.push(app);
      body = app;
    } else if (
      path.endsWith(`/${extensionId}/permissions`) &&
      method === "PUT"
    ) {
      const app = apps[0];
      app.approvedPermissions = request.postDataJSON().approvedPermissions;
      body = app;
    } else if (path.endsWith(`/${extensionId}/enable`) && method === "POST") {
      apps[0].enabled = true;
      body = apps[0];
    } else if (path.endsWith(`/${extensionId}/context`) && method === "GET") {
      body = {
        extensionId,
        space: {
          id: spaceId,
          name: "Extension test space",
          description: "Members can try approved apps.",
          visibility: "PUBLIC",
          capacity: 100,
          templateId: "OFFICE",
        },
        permissions: ["SPACE_SUMMARY_READ"],
      };
    } else if (path.startsWith(`/api/v1/spaces/${spaceId}/extensions/`)) {
      status = 404;
      body = { message: "확장 앱을 찾을 수 없어요." };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("https://apps.example.org/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><script>
        window.addEventListener('message', event => {
          const message = event.data;
          if (message?.channel !== 'HUFS_TOWN_EXTENSION') return;
          if (message.type === 'INITIALIZE') {
            parent.postMessage({ channel: message.channel, version: 1, type: 'CONTEXT_REQUEST', nonce: message.nonce, requestId: 'summary-1' }, '*');
          } else if (message.type === 'CONTEXT_RESPONSE') {
            document.body.textContent = JSON.stringify(message.context);
          }
        });
      </script></body></html>`,
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Extension test space 확장 앱" })
    .click();
  await page.getByLabel("앱 이름").fill("Space helper");
  await page
    .getByLabel("HTTPS 앱 주소")
    .fill("https://apps.example.org/space-helper");
  await page.getByRole("button", { name: "앱 등록" }).click();
  await expect(page.getByText("Space helper", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "요청 권한 승인" }).click();
  await page.getByRole("button", { name: "Space helper 앱 켜기" }).click();
  await page.getByRole("button", { name: "열기" }).click();
  const extensionFrame = page.locator("iframe");
  await expect(extensionFrame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(extensionFrame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(extensionFrame.contentFrame().locator("body")).toContainText(
    "Extension test space",
  );
});

test("accept an incoming ownership transfer from the space lobby", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  let accepted = false;
  const space = {
    id: "transfer-space",
    name: "GDG 운영 공간",
    description: "함께 관리하는 캠퍼스",
    visibility: "PUBLIC",
    capacity: 100,
    role: "MEMBER",
  };
  const transfer = {
    spaceId: space.id,
    spaceName: space.name,
    ownerDisplayName: "현재 소유자",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };

  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");

    let body: unknown = {};
    if (path.endsWith("/ownership-transfers/incoming")) {
      body = accepted ? [] : [transfer];
    } else if (path.endsWith("/ownership-transfer/respond")) {
      expect(request.postDataJSON()).toEqual({ decision: "ACCEPT" });
      accepted = true;
      body = { status: "ACCEPTED" };
    } else if (path.endsWith("/spaces")) {
      body = {
        items: [{ ...space, role: accepted ? "OWNER" : "MEMBER" }],
        page: 1,
        pageSize: 12,
        totalItems: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      };
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto("/");

  const inbox = page.getByRole("region", { name: "공간 소유권 이전 요청" });
  await expect(inbox).toContainText("GDG 운영 공간");
  await inbox.getByRole("button", { name: "수락", exact: true }).click();
  const confirmation = page.getByRole("dialog", {
    name: "작업을 확인해 주세요",
  });
  await confirmation.getByRole("button", { name: "확인" }).click();
  await expect(
    page.getByText("GDG 운영 공간의 소유권을 받았어요.", { exact: true }),
  ).toBeVisible();
  await expect(inbox).toHaveCount(0);
  await expect(page.getByRole("article")).toContainText("GDG 운영 공간");
});

test("recent visits only show spaces the signed-in account can still read", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  const checkedIds: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem(
      "hufs-town.recent-spaces.v1.local-test-user",
      JSON.stringify([
        { spaceId: "readable-space", visitedAt: 200 },
        { spaceId: "revoked-space", visitedAt: 100 },
      ]),
    );
  });
  await page.route("**/api/v1/spaces**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/spaces") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          page: 1,
          pageSize: 12,
          totalItems: 0,
          totalPages: 0,
          hasNext: false,
          hasPrevious: false,
        }),
      });
      return;
    }
    if (path.endsWith("/ownership-transfers/incoming")) {
      await route.fulfill({ contentType: "application/json", body: "[]" });
      return;
    }
    const id = path.split("/").at(-1) ?? "";
    checkedIds.push(id);
    if (id === "revoked-space") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ message: "공간을 찾을 수 없어요." }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "readable-space",
        name: "다시 만나는 공개 라운지",
        description: "읽기 권한이 남아 있는 공간",
        visibility: "PUBLIC",
        capacity: 100,
        templateId: "CAMPUS_SQUARE",
        role: "",
        approvalRequired: false,
        joinRequestStatus: "",
        favorite: false,
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "최근 방문", exact: true }).click();
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("다시 만나는 공개 라운지");
  await expect(cards).not.toContainText("revoked-space");
  await expect
    .poll(() => checkedIds)
    .toEqual(expect.arrayContaining(["readable-space", "revoked-space"]));

  await page.getByLabel("공간 검색").fill("없는 공간");
  await expect(page.getByText("검색한 최근 방문 공간이 없어요")).toBeVisible();
});

test("space operations summary reflects management scope and closes when access changes", async ({
  page,
}) => {
  await authApi(page, { signedIn: true });
  let currentRole: "OWNER" | "ADMIN" | "MEMBER" = "OWNER";
  const spaceId = "operations-space";
  const currentSpace = () => ({
    id: spaceId,
    name: "GDG 운영 오피스",
    description: "운영 상태를 확인하는 공간",
    visibility: "PUBLIC",
    capacity: 100,
    templateId: "MEETUP_HALL",
    role: currentRole,
    approvalRequired: true,
    allowedEmailDomains: ["hufs.ac.kr"],
    guestEntryEnabled: false,
    joinRequestStatus: "",
    favorite: false,
    archived: false,
  });
  const members = [
    {
      userId: "owner",
      displayName: "공간 소유자",
      role: "OWNER",
      joinedAt: Date.now(),
      lastVisitedAt: Date.now(),
    },
    {
      userId: "admin",
      displayName: "공간 관리자",
      role: "ADMIN",
      joinedAt: Date.now(),
      lastVisitedAt: Date.now(),
    },
    {
      userId: "member",
      displayName: "참가자",
      role: "MEMBER",
      joinedAt: Date.now(),
      lastVisitedAt: null,
    },
  ];
  const invites = [
    {
      id: "active-invite",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxUses: 3,
      useCount: 1,
      revoked: false,
      targetUserId: null,
      targetDisplayName: null,
    },
    {
      id: "expired-invite",
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
      maxUses: 3,
      useCount: 0,
      revoked: false,
      targetUserId: null,
      targetDisplayName: null,
    },
  ];
  await page.route("**/api/v1/spaces**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path.endsWith("/ownership-transfers/incoming")) body = [];
    else if (path === "/api/v1/spaces")
      body = {
        items: [currentSpace()],
        page: 1,
        pageSize: 12,
        totalItems: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      };
    else if (path === `/api/v1/spaces/${spaceId}`) body = currentSpace();
    else if (path.endsWith(`/${spaceId}/members`)) body = members;
    else if (path.endsWith(`/${spaceId}/join-requests`))
      body = [
        {
          id: "request-one",
          userId: "pending-one",
          displayName: "가입 대기자 1",
          requestedAt: Date.now(),
        },
        {
          id: "request-two",
          userId: "pending-two",
          displayName: "가입 대기자 2",
          requestedAt: Date.now(),
        },
      ];
    else if (path.endsWith(`/${spaceId}/invites`)) body = invites;
    else if (path.endsWith(`/${spaceId}/access-blocks`))
      body = [
        {
          userId: "blocked-one",
          displayName: "제한 계정 1",
          blockedAt: Date.now(),
        },
        {
          userId: "blocked-two",
          displayName: "제한 계정 2",
          blockedAt: Date.now(),
        },
      ];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "GDG 운영 오피스 운영 현황" }).click();
  let dialog = page.getByRole("dialog", { name: "운영 현황" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("dd")).toHaveText([
    "소유자",
    "공개",
    "최대 100명",
    "3명",
    "1명",
    "2건",
    "1개",
    "2명",
  ]);
  await expect(dialog).toContainText("입장 승인 사용");
  await expect(dialog.getByRole("button", { name: "공간 설정" })).toBeVisible();

  await page.getByRole("button", { name: "닫기" }).click();
  currentRole = "ADMIN";
  await page.reload();
  await page.getByRole("button", { name: "GDG 운영 오피스 운영 현황" }).click();
  dialog = page.getByRole("dialog", { name: "운영 현황" });
  await expect(dialog.locator("dd").first()).toHaveText("관리자");
  await expect(dialog.getByRole("button", { name: "멤버 관리" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "초대 관리" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "공간 설정" })).toHaveCount(
    0,
  );

  currentRole = "MEMBER";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "GDG 운영 오피스 운영 현황" }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("운영 권한이 변경");
});

test("English space creation and management dialogs follow the saved language", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("hufs.language", "en"));
  await authApi(page, { signedIn: true });

  let space: Record<string, unknown> | undefined;
  let invitations: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/spaces**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (method !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");

    let body: unknown = {};
    if (pathname === "/api/v1/spaces" && method === "POST") {
      space = {
        ...request.postDataJSON(),
        id: "english-space",
        role: "OWNER",
      };
      body = space;
    } else if (pathname === "/api/v1/spaces" && method === "GET") {
      const items = space ? [space] : [];
      body = {
        items,
        page: 1,
        pageSize: 12,
        totalItems: items.length,
        totalPages: items.length ? 1 : 0,
        hasNext: false,
        hasPrevious: false,
      };
    } else if (pathname.endsWith("/ownership-transfers/incoming")) {
      body = [];
    } else if (pathname.endsWith("/invitations/incoming")) {
      body = [];
    } else if (pathname.endsWith("/invites") && method === "POST") {
      const draft = request.postDataJSON();
      const invite = {
        id: "english-invite",
        expiresAt: new Date(Date.now() + draft.hours * 3_600_000).toISOString(),
        maxUses: draft.maxUses,
        useCount: 0,
        revoked: false,
        targetUserId: null,
        targetDisplayName: null,
      };
      invitations = [invite];
      body = { invite, code: "english-invite-code" };
    } else if (pathname.endsWith("/invites")) {
      body = invitations;
    } else if (pathname.endsWith("/members")) {
      body = [
        {
          userId: "english-owner",
          displayName: "Owner",
          role: "OWNER",
          joinedAt: Date.now(),
          lastVisitedAt: Date.now(),
        },
        {
          userId: "english-member",
          displayName: "Member",
          role: "MEMBER",
          joinedAt: Date.now(),
          lastVisitedAt: null,
        },
      ];
    } else if (pathname.endsWith("/join-requests")) {
      body = [];
    } else if (pathname.endsWith("/access-blocks")) {
      body = [];
    } else if (pathname === "/api/v1/spaces/english-space") {
      body = space;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/api/v1/spaces/english-space/extensions", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "확장 앱을 불러오지 못했어요." }),
    }),
  );

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".space-hero h1")).toHaveText("Spaces");
  await expect(page.locator(".space-hero .eyebrow")).toHaveCount(0);
  await expect(page.locator(".space-hero > div > p").nth(0)).toHaveText(
    "View your spaces and public spaces, or create a new space.",
  );
  await page
    .getByRole("button", { name: "Create a space", exact: true })
    .click();
  const createDialog = page.getByRole("dialog", { name: "Create a space" });
  await expect(createDialog).toContainText("Choose a starting layout");
  await expect(createDialog).toContainText("Study lounge");
  await createDialog.getByLabel("Space name").fill("English Lounge");
  await createDialog
    .getByLabel("Short description")
    .fill("A space for the English UI check");
  await createDialog.getByRole("button", { name: "Create space" }).click();

  const card = page.getByRole("article").filter({ hasText: "English Lounge" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Private");
  await card.getByRole("button", { name: "English Lounge Apps" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not load space apps.",
  );
  await expect(page.getByRole("alert")).not.toContainText(/[가-힣]/);
  await page.getByRole("button", { name: "Close" }).click();
  await card
    .getByRole("button", { name: "Manage invitations for English Lounge" })
    .click();
  const inviteDialog = page.getByRole("dialog", { name: "Invite friends" });
  await expect(inviteDialog).toContainText("Issued invitations");
  await inviteDialog.getByLabel("Number of people who can accept").fill("2");
  await inviteDialog
    .getByRole("button", { name: "Create invitation code" })
    .click();
  await expect(inviteDialog.getByLabel("New invitation code")).toHaveValue(
    "english-invite-code",
  );
  await page.getByRole("button", { name: "Close" }).click();

  await card
    .getByRole("button", { name: "Open the English Lounge overview" })
    .click();
  const overview = page.getByRole("dialog", { name: "Space overview" });
  await expect(overview).toContainText("Your role");
  await expect(overview).toContainText("Join approval off");
  await overview.getByRole("button", { name: "Manage members" }).click();
  const members = page.getByRole("dialog", { name: "Manage members" });
  await expect(members).toContainText("Current members · 2");
  await expect(members).toContainText("Restricted accounts · 0");
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Profile and avatar" });
  await expect(profile.getByLabel("Skin tone")).toBeVisible();
  await expect(profile.getByLabel("Clothing")).toBeVisible();
  await expect(profile.getByLabel("Hair")).toBeVisible();
  await expect(profile.getByLabel("Display name")).toBeVisible();
  await expect(
    profile.getByRole("button", { name: "Save profile" }),
  ).toBeVisible();
});
