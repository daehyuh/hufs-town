export interface AuthConfig {
  mode: "preview" | "sso";
  configured: boolean;
  provider: string;
}
import type { AvatarAppearance } from "../components/Avatar";
import type { TranslationKey } from "../i18n/language";

export interface Account extends AvatarAppearance {
  userId: string;
  displayName: string;
  avatar: number;
  bio: string;
  links: string[];
  allowPokes: boolean;
}
export interface AuthState {
  config: AuthConfig;
  account?: Account;
  error: string;
  errorKey?: TranslationKey;
}
export interface AccountDeletionImpact {
  ownedSpaces: Array<{ id: string; name: string }>;
}
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
async function read<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new AuthError(
      response.status,
      body.message ??
        "로그인 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.",
      body.code,
    );
  }
  return response.json();
}
export async function apiGet<T>(path: string): Promise<T> {
  return read<T>(
    await fetch(`/api/v1/${path}`, {
      credentials: "same-origin",
      cache: "no-store",
    }),
  );
}
function get<T>(path: string) {
  return apiGet<T>(`auth/${path}`);
}
export async function apiMutate<T>(
  path: string,
  body?: object,
  method = "POST",
): Promise<T> {
  // Fetch after every session rotation; never persist session or CSRF tokens in localStorage.
  const csrf = await get<{ headerName: string; token: string }>("csrf");
  return read<T>(
    await fetch(`/api/v1/${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        [csrf.headerName]: csrf.token,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
export async function apiUpload<T>(path: string, body: FormData): Promise<T> {
  const csrf = await get<{ headerName: string; token: string }>("csrf");
  return read<T>(
    await fetch(`/api/v1/${path}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { [csrf.headerName]: csrf.token },
      body,
    }),
  );
}
function mutate<T>(path: string, body?: object, method = "POST") {
  return apiMutate<T>(`auth/${path}`, body, method);
}
export async function currentAccount(): Promise<Account | undefined> {
  try {
    return await get<Account>("me");
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) return undefined;
    throw error;
  }
}
export async function startLogin() {
  const { authorizationUrl } = await mutate<{ authorizationUrl: string }>(
    "start",
  );
  const url = new URL(authorizationUrl);
  if (url.protocol !== "https:")
    throw new Error("로그인 주소 설정을 확인해 주세요.");
  window.location.assign(url.href);
}
export function saveProfile(
  displayName: string,
  avatar: number,
  appearance: AvatarAppearance,
  bio = "",
  links: string[] = [],
) {
  return mutate<Account>(
    "profile",
    { displayName, avatar, ...appearance, bio, links },
    "PATCH",
  );
}
export function savePokePreference(allowPokes: boolean) {
  return mutate<Account>("preferences", { allowPokes }, "PATCH");
}
export function getAccountDeletionImpact() {
  return get<AccountDeletionImpact>("account/deletion-impact");
}
export function deleteCurrentAccount(confirmation: string) {
  return mutate<{ deleted: boolean }>("account", { confirmation }, "DELETE");
}
export async function logout() {
  try {
    await mutate("logout");
  } catch (error) {
    if (!(error instanceof AuthError && error.status === 401)) throw error;
  }
}
export async function logoutEverywhere() {
  try {
    await mutate("sessions", undefined, "DELETE");
  } catch (error) {
    if (!(error instanceof AuthError && error.status === 401)) throw error;
  }
}

// Capture once, remove code/state from history immediately, and share the exchange across StrictMode effects.
const callback =
  typeof window !== "undefined" && window.location.pathname === "/auth/callback"
    ? new URLSearchParams(window.location.search)
    : undefined;
if (callback) window.history.replaceState(null, "", "/");
let callbackConsumed = false;
let initialRequest: Promise<AuthState> | undefined;
const callbackErrorKeys: Record<string, TranslationKey> = {
  SSO_LOGIN_FAILED: "auth.callback.expired",
  INVALID_LOGIN_STATE: "auth.callback.stateExpired",
  SSO_UNAVAILABLE: "auth.callback.providerUnavailable",
  SSO_NOT_CONFIGURED: "auth.callback.setupPending",
  SSO_CREDENTIALS_REJECTED: "auth.callback.setupRequired",
  SSO_STATUS_NOT_ALLOWED: "auth.callback.accountNotAllowed",
  ACCOUNT_UNAVAILABLE: "auth.callback.accountNotAllowed",
  AUTH_RATE_LIMIT: "auth.callback.rateLimited",
};
export function loadAuth(): Promise<AuthState> {
  if (initialRequest) return initialRequest;
  initialRequest = (async () => {
    const config = await get<AuthConfig>("config");
    if (callback && !callbackConsumed) {
      callbackConsumed = true;
      if (callback.has("error"))
        return {
          config,
          error: "",
          errorKey: "auth.callback.cancelled" as const,
        };
      const code = callback.get("code");
      const state = callback.get("state");
      if (!code || !state || config.mode !== "sso")
        return {
          config,
          error: "",
          errorKey: "auth.callback.invalid" as const,
        };
      try {
        return {
          config,
          account: await mutate<Account>("exchange", { code, state }),
          error: "",
        };
      } catch (error) {
        const errorKey =
          error instanceof AuthError && error.code
            ? (callbackErrorKeys[error.code] ?? "auth.callback.failed")
            : "auth.callback.failed";
        return {
          config,
          error: "",
          errorKey,
        };
      } finally {
        callback.delete("code");
        callback.delete("state");
      }
    }
    return {
      config,
      account: config.mode === "sso" ? await currentAccount() : undefined,
      error: "",
    };
  })().finally(() => {
    initialRequest = undefined;
  });
  return initialRequest;
}
