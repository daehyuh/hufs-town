import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "../components/Dialog";
import { formatDate, useLanguage } from "../i18n/language";
import {
  getChatRetentionPolicy,
  updateChatRetentionPolicy,
  type ChatRetentionPolicy,
} from "./chatRetention";

export function ChatRetentionSettingsDialog({ close }: { close: () => void }) {
  const { language, t } = useLanguage();
  const [policy, setPolicy] = useState<ChatRetentionPolicy>();
  const [days, setDays] = useState("30");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    getChatRetentionPolicy()
      .then((result) => {
        if (!active) return;
        setPolicy(result);
        setDays(String(result.retentionDays));
      })
      .catch((reason) => {
        if (active)
          setError(
            language === "ko" && reason instanceof Error
              ? reason.message
              : t("retention.error.load"),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [language]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const retentionDays = Number(days);
    if (
      saving ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 365
    )
      return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await updateChatRetentionPolicy(retentionDays);
      setPolicy(result);
      setDays(String(result.retentionDays));
      setNotice(t("retention.success"));
    } catch (reason) {
      setError(
        language === "ko" && reason instanceof Error
          ? reason.message
          : t("retention.error.save"),
      );
    } finally {
      setSaving(false);
    }
  }

  const parsedDays = Number(days);
  const validDays =
    Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365;

  return (
    <Dialog
      title={t("retention.title")}
      closeLabel={t("dialog.close")}
      close={() => !saving && close()}
    >
      <form className="group-dialog-form chat-retention-form" onSubmit={submit}>
        <p className="group-dialog-note">{t("retention.intro")}</p>
        {loading ? (
          <p className="muted small" role="status">
            {t("retention.loading")}
          </p>
        ) : (
          <>
            <label className="group-name-field">
              <span>{t("retention.field.days")}</span>
              <input
                aria-label={t("retention.field.aria")}
                type="number"
                min={1}
                max={365}
                step={1}
                value={days}
                onChange={(event) => setDays(event.target.value)}
                required
              />
            </label>
            <p className="group-dialog-note">
              {policy?.source === "DATABASE"
                ? t("retention.state.database")
                : t("retention.state.default")}
            </p>
            {policy?.updatedAt && (
              <small className="muted small">
                {t("retention.updatedAt", {
                  date: formatDate(language, policy.updatedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                })}
              </small>
            )}
          </>
        )}
        {error && (
          <p className="poke-feedback error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="poke-feedback success" role="status">
            {notice}
          </p>
        )}
        <div className="group-dialog-actions">
          <button
            type="button"
            className="group-cancel"
            onClick={close}
            disabled={saving}
          >
            {t("retention.close")}
          </button>
          <button
            className="group-create"
            type="submit"
            disabled={loading || saving || !validDays}
          >
            {saving ? t("retention.saving") : t("retention.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
