import { useEffect, useRef, useState, type FormEvent } from "react";
import { Blocks, ExternalLink, ShieldCheck, ShieldOff } from "lucide-react";
import { Dialog } from "../components/Dialog";
import { useLanguage, useLocalizedError } from "../i18n/language";
import type { Space } from "./client";
import {
  approveSpaceExtensionPermissions,
  getSpaceExtensionContext,
  listSpaceExtensions,
  registerSpaceExtension,
  setSpaceExtensionEnabled,
  type SpaceExtensionApp,
  type SpaceExtensionPermission,
} from "./extensionsClient";

const CHANNEL = "HUFS_TOWN_EXTENSION";
const MESSAGE_BYTES_LIMIT = 4_096;
const REQUESTS_PER_MINUTE = 30;
const SUMMARY_PERMISSION: SpaceExtensionPermission = "SPACE_SUMMARY_READ";

export function SpaceExtensionsDialog({
  space,
  close,
}: {
  space: Space | undefined;
  close: () => void;
}) {
  const { t } = useLanguage();
  const { message: error, clear: clearError, setFailure } = useLocalizedError();
  const [apps, setApps] = useState<SpaceExtensionApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [launchUrl, setLaunchUrl] = useState("");
  const [requestSummary, setRequestSummary] = useState(true);
  const [activeApp, setActiveApp] = useState<SpaceExtensionApp>();
  const [bridgeNonce, setBridgeNonce] = useState("");
  const [bridgeStatus, setBridgeStatus] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const manager = space?.role === "OWNER" || space?.role === "ADMIN";

  async function refresh() {
    if (!space) return;
    setLoading(true);
    clearError();
    try {
      setApps(await listSpaceExtensions(space.id));
    } catch (cause) {
      setFailure(cause, "extension.error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Refresh whenever the selected space changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space?.id]);

  useEffect(() => {
    if (!activeApp || !space) return;
    const selectedApp = activeApp;
    const selectedSpace = space;
    const nonce = bridgeNonce;
    if (!nonce) return;
    const target = frame.current?.contentWindow;
    if (!target) return;
    let requestCount = 0;
    let requestWindowStartedAt = Date.now();
    let current = true;
    setBridgeStatus("");

    function send(message: Record<string, unknown>) {
      if (current && frame.current?.contentWindow === target)
        target!.postMessage(
          { channel: CHANNEL, version: 1, nonce, ...message },
          "*",
        );
    }

    async function onMessage(event: MessageEvent) {
      if (event.source !== target || event.origin !== "null") return;
      let serialized: string;
      try {
        serialized = JSON.stringify(event.data);
      } catch {
        return;
      }
      if (
        typeof serialized !== "string" ||
        new TextEncoder().encode(serialized).length > MESSAGE_BYTES_LIMIT ||
        !event.data ||
        Object.getPrototypeOf(event.data) !== Object.prototype ||
        event.data.channel !== CHANNEL ||
        event.data.version !== 1 ||
        event.data.nonce !== nonce ||
        event.data.type !== "CONTEXT_REQUEST" ||
        typeof event.data.requestId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(event.data.requestId)
      )
        return;

      const now = Date.now();
      if (now - requestWindowStartedAt >= 60_000) {
        requestCount = 0;
        requestWindowStartedAt = now;
      }
      requestCount++;
      if (requestCount > REQUESTS_PER_MINUTE) {
        send({
          type: "CONTEXT_RESPONSE",
          requestId: event.data.requestId,
          error: "RATE_LIMIT",
        });
        return;
      }

      try {
        const context = await getSpaceExtensionContext(
          selectedSpace.id,
          selectedApp.id,
        );
        send({
          type: "CONTEXT_RESPONSE",
          requestId: event.data.requestId,
          context,
        });
      } catch {
        if (current) setBridgeStatus(t("extension.bridgeDenied"));
        send({
          type: "CONTEXT_RESPONSE",
          requestId: event.data.requestId,
          error: "UNAVAILABLE",
        });
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      current = false;
      window.removeEventListener("message", onMessage);
    };
  }, [activeApp, bridgeNonce, space, t]);

  async function manage(action: () => Promise<unknown>) {
    setBusy(true);
    clearError();
    try {
      await action();
      await refresh();
    } catch (cause) {
      setFailure(cause, "extension.error");
    } finally {
      setBusy(false);
    }
  }

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!space) return;
    await manage(async () => {
      await registerSpaceExtension(space.id, {
        name,
        launchUrl,
        requestedPermissions: requestSummary ? [SUMMARY_PERMISSION] : [],
      });
      setName("");
      setLaunchUrl("");
    });
  }

  if (!space) return null;

  return (
    <Dialog title={t("extension.title")} close={close}>
      {error && (
        <p className="extension-error" role="alert">
          {error}
        </p>
      )}
      {activeApp ? (
        <section
          className="extension-running"
          aria-label={t("extension.running", { name: activeApp.name })}
        >
          <div className="extension-running-heading">
            <div>
              <h3>{activeApp.name}</h3>
              <p>{activeApp.origin}</p>
            </div>
            <button
              type="button"
              className="space-secondary"
              onClick={() => setActiveApp(undefined)}
            >
              {t("extension.closeApp")}
            </button>
          </div>
          {bridgeStatus && (
            <p role="status" className="extension-error">
              {bridgeStatus}
            </p>
          )}
          <iframe
            key={activeApp.id}
            ref={frame}
            className="extension-frame"
            title={activeApp.name}
            src={activeApp.launchUrl}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => {
              const target = frame.current?.contentWindow;
              if (target && bridgeNonce)
                target.postMessage(
                  {
                    channel: CHANNEL,
                    version: 1,
                    type: "INITIALIZE",
                    nonce: bridgeNonce,
                    extensionId: activeApp.id,
                    permissions: activeApp.approvedPermissions,
                  },
                  "*",
                );
            }}
          />
          <p className="extension-sandbox-note">{t("extension.sandboxNote")}</p>
        </section>
      ) : (
        <section
          className="space-extension-panel"
          aria-label={t("extension.title")}
        >
          <p className="muted">
            {t("extension.description", { name: space.name })}
          </p>
          <p className="extension-permission-note">
            <ShieldCheck size={16} /> {t("extension.permissionSummary")}
          </p>
          {loading ? (
            <p role="status">{t("extension.loading")}</p>
          ) : apps.length ? (
            <ul className="extension-app-list">
              {apps.map((app) => {
                const needsApproval = app.requestedPermissions.some(
                  (permission) => !app.approvedPermissions.includes(permission),
                );
                return (
                  <li key={app.id}>
                    <div className="extension-app-copy">
                      <strong>{app.name}</strong>
                      <span>
                        <ExternalLink size={14} /> {app.origin}
                      </span>
                      <small>
                        {app.enabled
                          ? t("extension.enabled")
                          : t("extension.disabled")}
                      </small>
                    </div>
                    <div className="extension-app-actions">
                      {manager && needsApproval && (
                        <button
                          type="button"
                          className="space-secondary"
                          disabled={busy}
                          onClick={() =>
                            void manage(() =>
                              approveSpaceExtensionPermissions(
                                space.id,
                                app.id,
                                app.requestedPermissions,
                              ),
                            )
                          }
                        >
                          {t("extension.approve")}
                        </button>
                      )}
                      {manager && app.approvedPermissions.length > 0 && (
                        <button
                          type="button"
                          className="space-secondary"
                          disabled={busy}
                          onClick={() =>
                            void manage(() =>
                              approveSpaceExtensionPermissions(
                                space.id,
                                app.id,
                                [],
                              ),
                            )
                          }
                        >
                          {t("extension.revoke")}
                        </button>
                      )}
                      {manager && (
                        <button
                          type="button"
                          className="icon-button"
                          title={
                            app.enabled
                              ? t("extension.disable")
                              : t("extension.enable")
                          }
                          aria-label={`${app.name} ${app.enabled ? t("extension.disable") : t("extension.enable")}`}
                          disabled={busy || (needsApproval && !app.enabled)}
                          onClick={() =>
                            void manage(() =>
                              setSpaceExtensionEnabled(
                                space.id,
                                app.id,
                                !app.enabled,
                              ),
                            )
                          }
                        >
                          {app.enabled ? (
                            <ShieldOff size={17} />
                          ) : (
                            <ShieldCheck size={17} />
                          )}
                        </button>
                      )}
                      {app.enabled && (
                        <button
                          type="button"
                          className="space-primary"
                          onClick={() => {
                            setBridgeNonce(window.crypto.randomUUID());
                            setActiveApp(app);
                          }}
                        >
                          <Blocks size={15} /> {t("extension.open")}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="space-empty">{t("extension.empty")}</p>
          )}
          {manager && (
            <form
              className="extension-install-form"
              onSubmit={(event) => void install(event)}
            >
              <h3>{t("extension.register")}</h3>
              <label>
                {t("extension.name")}
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={60}
                  required
                />
              </label>
              <label>
                {t("extension.url")}
                <input
                  type="url"
                  value={launchUrl}
                  onChange={(event) => setLaunchUrl(event.target.value)}
                  maxLength={2048}
                  placeholder="https://apps.example.org"
                  required
                />
              </label>
              <label className="extension-permission-choice">
                <input
                  type="checkbox"
                  checked={requestSummary}
                  onChange={(event) => setRequestSummary(event.target.checked)}
                />
                {t("extension.requestSummary")}
              </label>
              <button type="submit" className="space-primary" disabled={busy}>
                {t("extension.register")}
              </button>
            </form>
          )}
        </section>
      )}
    </Dialog>
  );
}
