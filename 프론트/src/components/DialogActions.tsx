import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog } from "./Dialog";
import { useLanguage } from "../i18n/language";
import "./dialog-actions.css";

type PromptOptions = {
  initialValue?: string;
  label?: string;
  maxLength?: number;
};
type DialogActionRequest =
  | {
      kind: "confirm";
      message: string;
      resolve: (value: boolean) => void;
    }
  | {
      kind: "prompt";
      message: string;
      label?: string;
      maxLength?: number;
      resolve: (value: string | undefined) => void;
    };
type DialogActions = {
  confirm: (message: string) => Promise<boolean>;
  prompt: (
    message: string,
    options?: PromptOptions,
  ) => Promise<string | undefined>;
};

const DialogActionsContext = createContext<DialogActions | undefined>(
  undefined,
);

export function DialogActionsProvider({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const [request, setRequest] = useState<DialogActionRequest>();
  const [value, setValue] = useState("");
  const pending = useRef<DialogActionRequest | undefined>(undefined);
  const promptInput = useRef<HTMLInputElement>(null);
  const messageId = useId();

  const confirm = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      const next: DialogActionRequest = {
        kind: "confirm",
        message,
        resolve,
      };
      pending.current = next;
      setRequest(next);
    });
  }, []);
  const prompt = useCallback((message: string, options: PromptOptions = {}) => {
    setValue(options.initialValue ?? "");
    return new Promise<string | undefined>((resolve) => {
      const next: DialogActionRequest = {
        kind: "prompt",
        message,
        label: options.label,
        maxLength: options.maxLength,
        resolve,
      };
      pending.current = next;
      setRequest(next);
    });
  }, []);
  const finish = useCallback((result: boolean | string | undefined) => {
    const current = pending.current;
    pending.current = undefined;
    setRequest(undefined);
    if (!current) return;
    if (current.kind === "confirm") current.resolve(result === true);
    else current.resolve(typeof result === "string" ? result : undefined);
  }, []);

  useEffect(
    () => () => {
      const current = pending.current;
      pending.current = undefined;
      if (current?.kind === "confirm") current.resolve(false);
      else if (current) current.resolve(undefined);
    },
    [],
  );

  return (
    <DialogActionsContext.Provider value={{ confirm, prompt }}>
      {children}
      {request && (
        <Dialog
          title={
            request.kind === "confirm"
              ? t("dialog.confirmTitle")
              : t("dialog.promptTitle")
          }
          close={() => finish(undefined)}
          closeLabel={t("dialog.cancel")}
          initialFocusRef={request.kind === "prompt" ? promptInput : undefined}
          descriptionId={messageId}
        >
          {request.kind === "confirm" ? (
            <div className="dialog-action-form">
              <p id={messageId} className="dialog-action-message">
                {request.message}
              </p>
              <div className="dialog-action-buttons">
                <button
                  type="button"
                  className="dialog-action-secondary"
                  onClick={() => finish(false)}
                >
                  {t("dialog.cancel")}
                </button>
                <button
                  type="button"
                  className="dialog-action-primary"
                  onClick={() => finish(true)}
                >
                  {t("dialog.confirm")}
                </button>
              </div>
            </div>
          ) : (
            <form
              className="dialog-action-form"
              onSubmit={(event) => {
                event.preventDefault();
                finish(value);
              }}
            >
              <p id={messageId} className="dialog-action-message">
                {request.message}
              </p>
              <label className="dialog-action-field">
                <span>{request.label ?? t("dialog.promptLabel")}</span>
                <input
                  ref={promptInput}
                  autoComplete="off"
                  maxLength={request.maxLength}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              </label>
              <div className="dialog-action-buttons">
                <button
                  type="button"
                  className="dialog-action-secondary"
                  onClick={() => finish(undefined)}
                >
                  {t("dialog.cancel")}
                </button>
                <button type="submit" className="dialog-action-primary">
                  {t("dialog.confirm")}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </DialogActionsContext.Provider>
  );
}

export function useDialogActions() {
  const actions = useContext(DialogActionsContext);
  if (!actions)
    throw new Error("useDialogActions requires DialogActionsProvider.");
  return actions;
}
