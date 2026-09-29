import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Minimize2, X } from "lucide-react";
import { translate, useOptionalLanguage } from "../i18n/language";
export function Dialog({
  title,
  close,
  children,
  closeLabel,
  minimizable = true,
  size = "standard",
  initialFocusRef,
  descriptionId,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  closeLabel?: string;
  minimizable?: boolean;
  size?: "standard" | "wide";
  initialFocusRef?: RefObject<HTMLElement | null>;
  descriptionId?: string;
}) {
  const language = useOptionalLanguage()?.language ?? "ko";
  const label = closeLabel ?? translate(language, "dialog.close");
  const ref = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const [minimized, setMinimized] = useState(false);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
    return () => {
      dialog.close();
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target?.isConnected) {
        window.requestAnimationFrame(() => {
          if (target.isConnected && !target.closest("[inert]"))
            target.focus({ preventScroll: true });
        });
      }
    };
  }, []);
  useEffect(() => {
    let root = document.getElementById("town-dialog-dock");
    if (!root) {
      root = document.createElement("div");
      root.id = "town-dialog-dock";
      document.body.append(root);
    }
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", translate(language, "dialog.dock"));
    setDock(root);
  }, [language]);
  useEffect(() => {
    const dialog = ref.current!;
    if (minimized) {
      if (dialog.open) dialog.close();
      const frame = window.requestAnimationFrame(() =>
        restoreButton.current?.focus({ preventScroll: true }),
      );
      return () => window.cancelAnimationFrame(frame);
    }
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => {
      if (dialog.open)
        (initialFocusRef?.current ?? closeButton.current)?.focus({
          preventScroll: true,
        });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusRef, minimized]);
  return (
    <>
      <dialog
        className={`town-dialog ${size === "wide" ? "dialog-wide" : ""}`}
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <div className="dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <div className="dialog-heading-actions">
            {minimizable && (
              <button
                type="button"
                className="icon-button"
                aria-label={translate(language, "dialog.minimize")}
                title={translate(language, "dialog.minimize")}
                onClick={() => setMinimized(true)}
              >
                <Minimize2 size={18} />
              </button>
            )}
            <button
              ref={closeButton}
              type="button"
              className="icon-button"
              aria-label={label}
              onClick={close}
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="dialog-content">{children}</div>
      </dialog>
      {minimized && dock
        ? createPortal(
            <button
              ref={restoreButton}
              type="button"
              className="dialog-restore"
              onClick={() => setMinimized(false)}
            >
              <span className="dialog-restore-dot" aria-hidden="true" />
              <span>{title}</span>
              <span className="dialog-restore-hint">
                {translate(language, "dialog.restore")}
              </span>
            </button>,
            dock,
          )
        : null}
    </>
  );
}
