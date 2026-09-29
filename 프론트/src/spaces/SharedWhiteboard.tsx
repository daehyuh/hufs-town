import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { AuthError } from "../auth/client";
import { useDialogActions } from "../components/DialogActions";
import { createUuid } from "../ids";
import {
  formatNumber,
  useLanguage,
  type TranslationKey,
} from "../i18n/language";
import {
  addWhiteboardStroke,
  clearSpaceWhiteboard,
  getSpaceWhiteboard,
  type SpaceWhiteboard,
  type WhiteboardPoint,
} from "./boards";

const colors = [
  { value: "#1e293b", label: "whiteboard.color.black" },
  { value: "#2563eb", label: "whiteboard.color.blue" },
  { value: "#dc2626", label: "whiteboard.color.red" },
  { value: "#16a34a", label: "whiteboard.color.green" },
  { value: "#9333ea", label: "whiteboard.color.purple" },
  { value: "#f59e0b", label: "whiteboard.color.orange" },
] as const;

const whiteboardErrorKeys: Record<string, TranslationKey> = {
  WHITEBOARD_NOT_FOUND: "whiteboard.error.access",
  WHITEBOARD_CLEAR_FORBIDDEN: "whiteboard.error.clearForbidden",
  WHITEBOARD_OPERATION_CONFLICT: "whiteboard.error.operationConflict",
  WHITEBOARD_REVISION_CONFLICT: "whiteboard.error.revisionConflict",
  WHITEBOARD_FULL: "whiteboard.error.full",
  INVALID_WHITEBOARD_REQUEST: "whiteboard.error.invalid",
};

function errorKey(cause: unknown, fallback: TranslationKey): TranslationKey {
  if (cause instanceof AuthError) {
    const knownError = cause.code ? whiteboardErrorKeys[cause.code] : undefined;
    if (knownError) return knownError;
    if (cause.status === 401 || cause.status === 403)
      return "whiteboard.error.access";
  }
  return fallback;
}

function operationId() {
  return createUuid();
}

function pointFromEvent(event: PointerEvent<SVGSVGElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        1000,
        Math.round(((event.clientX - rect.left) / rect.width) * 1000),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        1000,
        Math.round(((event.clientY - rect.top) / rect.height) * 1000),
      ),
    ),
  } satisfies WhiteboardPoint;
}

function pointsValue(points: WhiteboardPoint[]) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

export function SharedWhiteboard({
  spaceId,
  boardId,
}: {
  spaceId: string;
  boardId: string;
}) {
  const { language, t } = useLanguage();
  const { confirm } = useDialogActions();
  const [whiteboard, setWhiteboard] = useState<SpaceWhiteboard>();
  const [draft, setDraft] = useState<WhiteboardPoint[]>([]);
  const [color, setColor] = useState<string>(colors[0].value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | "">("");
  const [notice, setNotice] = useState<TranslationKey>(
    "whiteboard.notice.initial",
  );
  const draftRef = useRef<WhiteboardPoint[]>([]);
  const busyRef = useRef(false);

  const refresh = useCallback(
    async (quiet = false) => {
      try {
        const latest = await getSpaceWhiteboard(spaceId, boardId);
        setWhiteboard((current) =>
          !current || latest.revision >= current.revision ? latest : current,
        );
        if (!quiet) setError("");
      } catch (cause) {
        if (!quiet) setError(errorKey(cause, "whiteboard.error.load"));
      }
    },
    [spaceId, boardId],
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (window.document.visibilityState === "visible" && !busyRef.current)
        void refresh(true);
    }, 1500);
    const onVisible = () => {
      if (window.document.visibilityState === "visible" && !busyRef.current)
        void refresh(true);
    };
    window.document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  async function saveStroke(points: WhiteboardPoint[]) {
    if (!points.length || !whiteboard || busyRef.current) return;
    const path = points.length === 1 ? [...points, points[0]] : points;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await addWhiteboardStroke(
        spaceId,
        boardId,
        operationId(),
        { color, width: 7, points: path },
        whiteboard.revision,
      );
      setWhiteboard((current) =>
        !current || saved.revision >= current.revision ? saved : current,
      );
      setNotice("whiteboard.notice.saved");
    } catch (cause) {
      setError(errorKey(cause, "whiteboard.error.save"));
      void refresh(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
      draftRef.current = [];
      setDraft([]);
    }
  }

  function startStroke(event: PointerEvent<SVGSVGElement>) {
    if (busy || !whiteboard || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    draftRef.current = [point];
    setDraft([point]);
  }

  function continueStroke(event: PointerEvent<SVGSVGElement>) {
    if (!draftRef.current.length) return;
    const point = pointFromEvent(event);
    const previous = draftRef.current.at(-1)!;
    if (Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) < 3)
      return;
    const next = [...draftRef.current, point];
    draftRef.current = next;
    setDraft(next);
  }

  function endStroke(event: PointerEvent<SVGSVGElement>) {
    if (!draftRef.current.length) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    void saveStroke(draftRef.current);
  }

  async function clearBoard() {
    if (!whiteboard?.canClear || busyRef.current) return;
    if (!(await confirm(t("whiteboard.confirmClear")))) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const cleared = await clearSpaceWhiteboard(
        spaceId,
        boardId,
        operationId(),
        whiteboard.revision,
      );
      setWhiteboard(cleared);
      setNotice("whiteboard.notice.cleared");
    } catch (cause) {
      setError(errorKey(cause, "whiteboard.error.clear"));
      await refresh(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="shared-whiteboard" aria-label={t("whiteboard.label")}>
      <div className="whiteboard-toolbar" aria-label={t("whiteboard.tools")}>
        <div
          className="whiteboard-colors"
          role="group"
          aria-label={t("whiteboard.colors")}
        >
          {colors.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`whiteboard-color${value === color ? " selected" : ""}`}
              style={{ "--whiteboard-color": value } as CSSProperties}
              aria-label={t("whiteboard.pen", { color: t(label) })}
              aria-pressed={value === color}
              disabled={busy}
              onClick={() => setColor(value)}
            />
          ))}
        </div>
        {whiteboard?.canClear && (
          <button
            type="button"
            className="whiteboard-clear"
            disabled={busy || !whiteboard.strokes.length}
            onClick={() => void clearBoard()}
          >
            {t("whiteboard.clear")}
          </button>
        )}
      </div>
      {error && (
        <p className="whiteboard-error" role="alert">
          {t(error)}
        </p>
      )}
      <svg
        className={`whiteboard-canvas${busy || !whiteboard ? " disabled" : ""}`}
        viewBox="0 0 1000 1000"
        role="img"
        aria-label={t("whiteboard.canvas")}
        onPointerDown={startStroke}
        onPointerMove={continueStroke}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      >
        <rect width="1000" height="1000" fill="white" />
        {whiteboard?.strokes.map((stroke) => (
          <polyline
            key={stroke.id}
            points={pointsValue(stroke.points)}
            fill="none"
            stroke={stroke.color}
            strokeWidth={stroke.width * 3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {draft.length > 0 && (
          <polyline
            points={pointsValue(
              draft.length === 1 ? [...draft, draft[0]] : draft,
            )}
            fill="none"
            stroke={color}
            strokeWidth={21}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      <div className="whiteboard-status" aria-live="polite">
        <span role="status">{t(notice)}</span>
        <span>
          {whiteboard
            ? t("whiteboard.status.count", {
                count: formatNumber(language, whiteboard.strokes.length),
                revision: formatNumber(language, whiteboard.revision),
              })
            : t("whiteboard.status.loading")}
        </span>
      </div>
    </section>
  );
}
