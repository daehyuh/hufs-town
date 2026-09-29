import { expect, type Page } from "@playwright/test";
// UI contract tests use a mock auth API; Java integration tests exercise the real session and world servers.
export async function authApi(
  page: Page,
  options: {
    signedIn?: boolean;
    exchangeFails?: boolean;
    exchangeFailureCode?: string;
    logoutEverywhereFails?: boolean;
    ownedSpaces?: { id: string; name: string }[];
    userId?: string;
    displayName?: string;
  } = {},
) {
  let signedIn = options.signedIn ?? false;
  let exchanges = 0;
  let deletions = 0;
  let logouts = 0;
  let everywhereLogouts = 0;
  let account = {
    userId: options.userId ?? "local-test-user",
    displayName: options.displayName ?? "외대 친구",
    avatar: 1,
    skin: "light",
    clothing: "casual_white",
    hair: "hair_short_black",
    bio: "",
    links: [] as string[],
    allowPokes: true,
  };
  await page.route("**/api/v1/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split("/").at(-1);
    let status = 200;
    let body: object = {};
    if (path === "config")
      body = { mode: "sso", configured: true, provider: "GDG HUFS SSO" };
    if (path === "csrf")
      body = { headerName: "X-CSRF-TOKEN", token: "test-csrf" };
    if (request.method() !== "GET")
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");
    if (path === "me") {
      status = signedIn ? 200 : 401;
      body = signedIn ? account : { message: "로그인이 필요해요." };
    }
    if (path === "start")
      body = {
        authorizationUrl:
          "https://sso.example.invalid/authorize?client_id=test&state=test-state",
      };
    if (path === "exchange") {
      exchanges++;
      expect(request.postDataJSON()).toEqual({
        code: "test-code",
        state: "test-state",
      });
      signedIn = !options.exchangeFails;
      status = signedIn ? 200 : 400;
      body = signedIn
        ? account
        : {
            code: options.exchangeFailureCode ?? "SSO_LOGIN_FAILED",
            message:
              "로그인 코드가 만료되었거나 유효하지 않아요. 다시 로그인해 주세요.",
          };
    }
    if (path === "profile") {
      account = { ...account, ...request.postDataJSON() };
      body = account;
    }
    if (path === "logout") {
      logouts++;
      signedIn = false;
      body = { loggedOut: true };
    }
    if (path === "sessions" && request.method() === "DELETE") {
      everywhereLogouts++;
      if (options.logoutEverywhereFails) {
        status = 503;
        body = {
          message: "모든 기기에서 로그아웃할 수 없어요. 다시 시도해 주세요.",
        };
      } else {
        signedIn = false;
        body = { loggedOut: true };
      }
    }
    if (path === "deletion-impact")
      body = { ownedSpaces: options.ownedSpaces ?? [] };
    if (path === "account" && request.method() === "DELETE") {
      deletions++;
      signedIn = false;
      body = { deleted: true };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/api/v1/spaces**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const space = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "GDG HUFS 캠퍼스",
      description: "함께 만나는 광장",
      visibility: "PUBLIC",
      capacity: 100,
      templateId: "CAMPUS_SQUARE",
      role: "",
    };
    const body = path.endsWith("admission")
      ? { ticket: "ui-fixture-ticket", expiresInSeconds: 30 }
      : path.endsWith("/spaces")
        ? {
            items: [space],
            page: 1,
            pageSize: 12,
            totalItems: 1,
            totalPages: 1,
          }
        : space;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return {
    exchanges: () => exchanges,
    deletions: () => deletions,
    logouts: () => logouts,
    everywhereLogouts: () => everywhereLogouts,
    signedIn: () => signedIn,
  };
}
