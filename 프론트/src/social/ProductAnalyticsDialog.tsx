import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Dialog } from "../components/Dialog";
import { formatDate, formatNumber, useLanguage } from "../i18n/language";
import {
  getProductAnalytics,
  type ProductAnalyticsDashboard,
} from "./productAnalytics";
import "./productAnalytics.css";

export function ProductAnalyticsDialog({ close }: { close: () => void }) {
  const { language, t } = useLanguage();
  const [dashboard, setDashboard] = useState<ProductAnalyticsDashboard>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const initialLoadStarted = useRef(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(false);
    try {
      setDashboard(await getProductAnalytics());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void refresh();
  }, [refresh]);

  return (
    <Dialog
      title={t("analytics.title")}
      closeLabel={t("dialog.close")}
      close={close}
    >
      <section className="product-analytics" aria-label={t("analytics.title")}>
        <p className="product-analytics-intro">{t("analytics.privacy")}</p>
        {busy && !dashboard && (
          <p className="product-analytics-status" role="status">
            {t("analytics.loading")}
          </p>
        )}
        {error && (
          <div className="product-analytics-error" role="alert">
            <p>{t("analytics.error")}</p>
            <button type="button" onClick={() => void refresh()}>
              {t("analytics.retry")}
            </button>
          </div>
        )}
        {dashboard && (
          <>
            <div className="product-analytics-heading">
              <p>{t("analytics.range")}</p>
              <button
                type="button"
                className="product-analytics-refresh"
                disabled={busy}
                onClick={() => void refresh()}
              >
                <RefreshCw size={15} aria-hidden="true" />
                {t("analytics.refresh")}
              </button>
            </div>
            <dl className="product-analytics-summary">
              <div>
                <dt>{t("analytics.metric.spaceJoins")}</dt>
                <dd>{formatNumber(language, dashboard.totals.spaceJoins)}</dd>
              </div>
              <div>
                <dt>{t("analytics.metric.eventParticipations")}</dt>
                <dd>
                  {formatNumber(language, dashboard.totals.eventParticipations)}
                </dd>
              </div>
              <div>
                <dt>{t("analytics.metric.worldRejections")}</dt>
                <dd>
                  {formatNumber(language, dashboard.totals.worldRejections)}
                </dd>
              </div>
              <div>
                <dt>{t("analytics.metric.apiServerErrors")}</dt>
                <dd>
                  {formatNumber(language, dashboard.totals.apiServerErrors)}
                </dd>
              </div>
            </dl>
            <p className="product-analytics-retention">
              {t("analytics.retention", {
                days: dashboard.retentionDays,
              })}
            </p>
            <div
              className="product-analytics-table-wrap"
              role="region"
              aria-label={t("analytics.table.caption")}
              tabIndex={0}
            >
              <table className="product-analytics-table">
                <caption>{t("analytics.table.caption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("analytics.table.date")}</th>
                    <th scope="col">{t("analytics.metric.spaceJoins")}</th>
                    <th scope="col">
                      {t("analytics.metric.eventParticipations")}
                    </th>
                    <th scope="col">{t("analytics.metric.worldRejections")}</th>
                    <th scope="col">{t("analytics.metric.apiServerErrors")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.days.map((day) => (
                    <tr key={day.date}>
                      <th scope="row">
                        {formatDate(language, `${day.date}T00:00:00Z`, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          timeZone: "UTC",
                        })}
                      </th>
                      <td>{formatNumber(language, day.counts.spaceJoins)}</td>
                      <td>
                        {formatNumber(language, day.counts.eventParticipations)}
                      </td>
                      <td>
                        {formatNumber(language, day.counts.worldRejections)}
                      </td>
                      <td>
                        {formatNumber(language, day.counts.apiServerErrors)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="product-analytics-updated">
              {t("analytics.updated", {
                time: formatDate(language, dashboard.generatedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </p>
          </>
        )}
      </section>
    </Dialog>
  );
}
