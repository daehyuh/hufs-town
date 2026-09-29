import { useEffect, useRef, useState } from "react";
import { createUuid } from "../ids";
import { AuthError } from "../auth/client";
import { useDialogActions } from "../components/DialogActions";
import { useLanguage, type TranslationKey } from "../i18n/language";
import type { MapDefinition } from "../generated/protocol";
import { rebuildCollisions } from "../game/officeAssets";
import * as api from "./client";
import { importMap } from "./importMap";
import {
  applyMapEditActions,
  diffMap,
  mapEditTouches,
} from "./collaborativeOperations";

interface History {
  past: MapDefinition[];
  present?: MapDefinition;
  future: MapDefinition[];
}
export function useMapEditor(space: string, user: string, mapId = space) {
  const language = useLanguage();
  const { confirm } = useDialogActions();
  const languageRef = useRef(language);
  languageRef.current = language;
  function errorMessage(error: unknown, fallback: TranslationKey) {
    const current = languageRef.current;
    if (
      error instanceof AuthError &&
      error.status === 403 &&
      mode.current === "COLLABORATIVE"
    )
      return current.t("editor.collaborative.permissionLost");
    if (
      error instanceof AuthError &&
      error.status === 409 &&
      mode.current === "COLLABORATIVE"
    )
      return current.t("editor.collaborative.conflict");
    if (error instanceof AuthError && [401, 403, 409].includes(error.status))
      return current.t("editor.error.leaseLost");
    if (current.language === "ko" && error instanceof Error)
      return error.message;
    return current.t(fallback);
  }
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [writable, setWritable] = useState(false),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<string[]>([]),
    [version, setVersion] = useState(0);
  const [editMode, setEditMode] = useState<api.EditMode["mode"]>("LEGACY");
  const [collaborativeUndoReady, setCollaborativeUndoReady] = useState(false);
  const [collaborativeRedoReady, setCollaborativeRedoReady] = useState(false);
  const [collaborativeConflict, setCollaborativeConflict] = useState(false);
  const [recovery, setRecovery] = useState<MapDefinition>();
  const client = useRef(createUuid());
  const lease = useRef<api.Credentials | undefined>(undefined);
  const mode = useRef<api.EditMode["mode"]>("LEGACY");
  const collaborativeSequence = useRef(0);
  const collaborativeBaseline = useRef<MapDefinition | undefined>(undefined);
  const collaborativeOperations = useRef<api.MapEditOperationEvent[]>([]);
  const collaborativeRedo = useRef<api.MapEditOperationEvent[]>([]);
  const collaborativeConflictEditor = useRef<api.EditorDocument | undefined>(
    undefined,
  );
  const collaborativeConflictActive = useRef(false);
  const generation = useRef(0),
    serial = useRef(0),
    savedSerial = useRef(0),
    serverVersion = useRef(0);
  const current = useRef<History>(history),
    canWrite = useRef(false);
  const flight = useRef<Promise<void> | undefined>(undefined);
  const pending = useRef<
    | { map: MapDefinition; serial: number; operation: string; version: number }
    | undefined
  >(undefined);
  const collaborativePending = useRef<api.MapEditCommand | undefined>(
    undefined,
  );
  const collaborativePublishPending = useRef<
    | {
        revisionId?: string;
        clientId: string;
        operationId: string;
        baseSequence: number;
        baseVersion: number;
      }
    | undefined
  >(undefined);
  const collaborativeSyncing = useRef(false);
  const recoveryKey = `hufs.map-recovery.${user}.${space}.${mapId}`;
  function permissions(value: boolean) {
    canWrite.current = value;
    setWritable(value);
  }
  function setMode(value: api.EditMode["mode"]) {
    mode.current = value;
    setEditMode(value);
  }
  function setCollaborativeOperations(operations: api.MapEditOperationEvent[]) {
    collaborativeOperations.current = operations;
    const undone = new Set(
      operations
        .map((operation) => operation.undoOfSequence)
        .filter((sequence): sequence is number => sequence !== null),
    );
    setCollaborativeUndoReady(
      operations.some(
        (operation) =>
          operation.actorId === user && !undone.has(operation.sequence),
      ),
    );
    setCollaborativeRedoReady(collaborativeRedo.current.length > 0);
  }
  function appendCollaborativeOperation(operation: api.MapEditOperationEvent) {
    const operations = collaborativeOperations.current.filter(
      (item) => item.sequence !== operation.sequence,
    );
    operations.push(operation);
    setCollaborativeOperations(
      operations.sort((a, b) => a.sequence - b.sequence),
    );
  }
  function collaborativeCommand(
    actions: api.MapEditAction[],
    baseSequence: number,
  ) {
    return {
      protocolVersion: 1 as const,
      mapId,
      clientId: client.current,
      operationId: createUuid(),
      baseSequence,
      actions,
    };
  }
  async function loadCollaborative(afterSequence: number) {
    let result = await api.collaborativeSync(space, mapId, afterSequence);
    const operations = [...result.operations];
    let pages = 1;
    let cursor = afterSequence;
    while (result.hasMore && pages < 40) {
      const nextCursor = operations.at(-1)?.sequence;
      if (nextCursor === undefined || nextCursor <= cursor) break;
      cursor = nextCursor;
      result = await api.collaborativeSync(space, mapId, cursor);
      operations.push(...result.operations);
      pages++;
    }
    return { ...result, operations };
  }
  function updateCollaborativeSnapshot(
    sync: api.CollaborativeSync,
    append = false,
  ) {
    collaborativeBaseline.current = sync.editor.map;
    collaborativeSequence.current = sync.sequence;
    const operations = append
      ? [
          ...collaborativeOperations.current,
          ...sync.operations.filter(
            (operation) =>
              !collaborativeOperations.current.some(
                (current) => current.sequence === operation.sequence,
              ),
          ),
        ]
      : sync.operations;
    setCollaborativeOperations(operations);
    setVersion(sync.editor.version);
    setIssues(sync.editor.issues);
  }
  function install(next: History) {
    current.current = next;
    setHistory(next);
  }
  function remember(map: MapDefinition) {
    try {
      localStorage.setItem(
        recoveryKey,
        JSON.stringify({ savedAt: Date.now(), map }),
      );
    } catch {
      /* Download remains available if browser storage is full. */
    }
  }
  function handleCollaborativePermissionLoss(error: unknown) {
    if (
      !(error instanceof AuthError) ||
      ![401, 403].includes(error.status) ||
      mode.current !== "COLLABORATIVE"
    )
      return;
    if (current.current.present) remember(current.current.present);
    permissions(false);
  }
  function modified(next: History) {
    serial.current++;
    install(next);
    setDirty(true);
    setNotice("");
    if (next.present) remember(next.present);
  }
  function edit(transform: (map: MapDefinition) => MapDefinition) {
    if (!canWrite.current || !current.current.present) return;
    const previous = current.current.present,
      next = rebuildCollisions(transform(structuredClone(previous)));
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    modified({
      past: [...current.current.past, previous].slice(-50),
      present: next,
      future: [],
    });
  }
  function undo() {
    const h = current.current;
    if (!canWrite.current || !h.present) return;
    if (
      mode.current === "COLLABORATIVE" &&
      savedSerial.current === serial.current
    ) {
      void undoCollaborative();
      return;
    }
    if (!h.past.length) return;
    modified({
      past: h.past.slice(0, -1),
      present: h.past.at(-1),
      future: [h.present, ...h.future],
    });
  }
  function redo() {
    const h = current.current;
    if (!canWrite.current || !h.present) return;
    if (
      mode.current === "COLLABORATIVE" &&
      savedSerial.current === serial.current
    ) {
      void redoCollaborative();
      return;
    }
    if (!h.future.length) return;
    modified({
      past: [...h.past, h.present],
      present: h.future[0],
      future: h.future.slice(1),
    });
  }
  function accept(result: api.EditorDocument, reset: boolean) {
    serverVersion.current = result.version;
    setVersion(result.version);
    setIssues(result.issues);
    if (reset) {
      install({ past: [], present: result.map, future: [] });
      serial.current = 0;
      savedSerial.current = 0;
      setDirty(false);
      pending.current = undefined;
    }
  }
  async function synchronizeCollaborative(gen = generation.current) {
    if (
      mode.current !== "COLLABORATIVE" ||
      !canWrite.current ||
      collaborativeConflictActive.current ||
      collaborativeSyncing.current ||
      flight.current ||
      gen !== generation.current
    )
      return;
    collaborativeSyncing.current = true;
    try {
      const fromSequence = collaborativeSequence.current;
      const sync = await loadCollaborative(fromSequence);
      if (gen !== generation.current || mode.current !== "COLLABORATIVE")
        return;
      if (sync.sequence < collaborativeSequence.current) return;
      if (sync.sequence === collaborativeSequence.current) {
        if (sync.editor.version > serverVersion.current) {
          const clean = savedSerial.current === serial.current;
          updateCollaborativeSnapshot(sync, true);
          accept(sync.editor, clean);
        }
        return;
      }

      if (
        savedSerial.current !== serial.current &&
        current.current.present &&
        collaborativeBaseline.current
      ) {
        const localActions = diffMap(
          collaborativeBaseline.current,
          current.current.present,
        );
        const localTouches = mapEditTouches(localActions);
        const remoteTouches = mapEditTouches(
          sync.operations.flatMap((operation) => operation.actions),
        );
        if ([...localTouches].some((touch) => remoteTouches.has(touch))) {
          collaborativeConflictActive.current = true;
          collaborativePending.current = undefined;
          collaborativeConflictEditor.current = sync.editor;
          setRecovery(current.current.present);
          setCollaborativeConflict(true);
          setError(languageRef.current.t("editor.collaborative.conflict"));
          return;
        }
        const rebased = applyMapEditActions(sync.editor.map, localActions);
        updateCollaborativeSnapshot(sync, true);
        install({ past: [], present: rebased, future: [] });
        if (localActions.length) {
          remember(rebased);
          setDirty(true);
        } else {
          setDirty(false);
        }
        return;
      }

      updateCollaborativeSnapshot(sync, true);
      accept(sync.editor, true);
      collaborativeConflictActive.current = false;
      collaborativeConflictEditor.current = undefined;
      setCollaborativeConflict(false);
    } catch (error) {
      handleCollaborativePermissionLoss(error);
      throw error;
    } finally {
      collaborativeSyncing.current = false;
    }
  }
  function discardCollaborativeConflict() {
    const latest = collaborativeConflictEditor.current;
    if (!latest) return;
    const gen = generation.current;
    if (current.current.present) setRecovery(current.current.present);
    collaborativeConflictActive.current = false;
    collaborativeConflictEditor.current = undefined;
    setCollaborativeConflict(false);
    setError("");
    setCollaborativeOperations(collaborativeOperations.current);
    void loadCollaborative(collaborativeSequence.current)
      .then((sync) => {
        if (gen !== generation.current) return;
        updateCollaborativeSnapshot(sync, true);
        accept(sync.editor, true);
        collaborativeBaseline.current = sync.editor.map;
        permissions(true);
        setDirty(false);
      })
      .catch((error) => {
        setError(errorMessage(error, "editor.error.open"));
      });
  }
  async function begin(takeover = false) {
    const gen = generation.current;
    setBusy(true);
    setError("");
    try {
      const currentMode = await api.editMode(space, mapId);
      if (gen !== generation.current) return;
      setMode(currentMode.mode);
      setVersion(currentMode.version);
      if (currentMode.mode === "COLLABORATIVE") {
        const sync = await loadCollaborative(0);
        if (gen !== generation.current) return;
        updateCollaborativeSnapshot(sync);
        collaborativeConflictActive.current = false;
        collaborativeConflictEditor.current = undefined;
        setCollaborativeConflict(false);
        permissions(true);
        accept(sync.editor, true);
        return;
      }
      const granted = await api.acquire(space, client.current, takeover, mapId);
      if (gen !== generation.current) return;
      collaborativeBaseline.current = undefined;
      collaborativeSequence.current = 0;
      setCollaborativeOperations([]);
      collaborativeRedo.current = [];
      setCollaborativeConflict(false);
      collaborativeConflictActive.current = false;
      lease.current = {
        token: granted.token,
        fence: granted.fence,
        clientId: client.current,
      };
      permissions(true);
      accept(granted.editor, true);
    } catch (e) {
      if (gen !== generation.current) return;
      permissions(false);
      setError(errorMessage(e, "editor.error.open"));
      try {
        const draft = await api.getEditor(space, mapId);
        if (gen === generation.current) accept(draft, true);
      } catch {
        /* Keep the actionable initial failure. */
      }
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  async function save(): Promise<void> {
    if (flight.current) return flight.current;
    if (
      !canWrite.current ||
      (mode.current === "LEGACY" && !lease.current) ||
      !current.current.present ||
      savedSerial.current === serial.current
    )
      return;
    const gen = generation.current;
    setSaving(true);
    setError("");
    const job = (async () => {
      while (
        canWrite.current &&
        (mode.current === "COLLABORATIVE" || lease.current) &&
        savedSerial.current !== serial.current
      ) {
        if (mode.current === "COLLABORATIVE") {
          if (collaborativeConflictActive.current) break;
          const map = current.current.present;
          const baseline = collaborativeBaseline.current;
          if (!map || !baseline) break;
          const requestSerial = serial.current;
          const actions = diffMap(baseline, map);
          if (!actions.length) {
            savedSerial.current = requestSerial;
            setDirty(false);
            try {
              localStorage.removeItem(recoveryKey);
            } catch {}
            setRecovery(undefined);
            continue;
          }
          const command =
            collaborativePending.current ??
            collaborativeCommand(actions, collaborativeSequence.current);
          collaborativePending.current = command;
          const result = await api.applyCollaborativeEdit(space, command);
          if (gen !== generation.current) return;
          collaborativePending.current = undefined;
          collaborativeBaseline.current = result.editor.map;
          collaborativeSequence.current = result.sequence;
          appendCollaborativeOperation(result.operation);
          accept(result.editor, false);
          savedSerial.current = requestSerial;
          const present = current.current.present;
          if (present) {
            const rebased =
              serial.current === requestSerial
                ? result.editor.map
                : applyMapEditActions(result.editor.map, diffMap(map, present));
            install({ ...current.current, present: rebased });
          }
          if (savedSerial.current === serial.current) {
            setDirty(false);
            try {
              localStorage.removeItem(recoveryKey);
            } catch {}
            setRecovery(undefined);
            setNotice(languageRef.current.t("editor.notice.saved"));
          }
          continue;
        }
        const request = pending.current ?? {
          map: current.current.present!,
          serial: serial.current,
          operation: createUuid(),
          version: serverVersion.current,
        };
        pending.current = request;
        const result = await api.saveDraft(
          space,
          lease.current!,
          request.version,
          request.operation,
          request.map,
          mapId,
        );
        if (gen !== generation.current) return;
        pending.current = undefined;
        accept(result, false);
        savedSerial.current = request.serial;
        if (savedSerial.current === serial.current) {
          setDirty(false);
          try {
            localStorage.removeItem(recoveryKey);
          } catch {}
          setRecovery(undefined);
          setNotice(languageRef.current.t("editor.notice.saved"));
        }
      }
    })()
      .catch((e) => {
        if (gen !== generation.current) return;
        setError(errorMessage(e, "editor.error.save"));
        handleCollaborativePermissionLoss(e);
        if (e instanceof AuthError && e.status === 400)
          pending.current = undefined;
        if (
          e instanceof AuthError &&
          e.status === 409 &&
          mode.current === "COLLABORATIVE"
        ) {
          collaborativePending.current = undefined;
          void synchronizeCollaborative(gen).catch(() => {});
        }
        if (
          e instanceof AuthError &&
          [401, 403, 409].includes(e.status) &&
          mode.current === "LEGACY"
        ) {
          permissions(false);
          lease.current = undefined;
        }
        throw e;
      })
      .finally(() => {
        flight.current = undefined;
        if (gen === generation.current) setSaving(false);
      });
    flight.current = job;
    return job;
  }
  async function enableCollaborativeEditing() {
    if (mode.current !== "LEGACY" || !canWrite.current || !lease.current)
      return;
    const gen = generation.current;
    setBusy(true);
    setError("");
    try {
      await save();
      if (gen !== generation.current || !lease.current) return;
      await api.release(space, lease.current, mapId);
      lease.current = undefined;
      permissions(false);
      const sync = await api.enableCollaborativeEditing(
        space,
        mapId,
        serverVersion.current,
      );
      if (gen !== generation.current) return;
      setMode("COLLABORATIVE");
      collaborativeRedo.current = [];
      setCollaborativeRedoReady(false);
      updateCollaborativeSnapshot(sync);
      accept(sync.editor, true);
      permissions(true);
      setNotice(languageRef.current.t("editor.collaborative.enabled"));
    } catch (error) {
      if (gen !== generation.current) return;
      setError(errorMessage(error, "editor.collaborative.enableError"));
      if (!lease.current) void begin();
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  async function undoCollaborative() {
    const undone = new Set(
      collaborativeOperations.current
        .map((operation) => operation.undoOfSequence)
        .filter((sequence): sequence is number => sequence !== null),
    );
    const target = [...collaborativeOperations.current]
      .reverse()
      .find(
        (operation) =>
          operation.actorId === user && !undone.has(operation.sequence),
      );
    if (!target) return;
    const gen = generation.current;
    setSaving(true);
    setError("");
    try {
      const command = {
        protocolVersion: 1 as const,
        mapId,
        clientId: client.current,
        operationId: createUuid(),
        baseSequence: collaborativeSequence.current,
        undoSequence: target.sequence,
      };
      const result = await api.undoCollaborativeEdit(space, mapId, command);
      if (gen !== generation.current) return;
      collaborativeRedo.current.push(target);
      setCollaborativeRedoReady(true);
      collaborativeBaseline.current = result.editor.map;
      collaborativeSequence.current = result.sequence;
      appendCollaborativeOperation(result.operation);
      accept(result.editor, true);
      setNotice(languageRef.current.t("editor.collaborative.undone"));
    } catch (error) {
      if (gen !== generation.current) return;
      setError(errorMessage(error, "editor.error.save"));
      handleCollaborativePermissionLoss(error);
      if (error instanceof AuthError && error.status === 409)
        void synchronizeCollaborative(gen).catch(() => {});
    } finally {
      if (gen === generation.current) setSaving(false);
    }
  }
  async function redoCollaborative() {
    const target = collaborativeRedo.current.at(-1);
    if (!target || !current.current.present) return;
    const gen = generation.current;
    setSaving(true);
    setError("");
    try {
      const command = collaborativeCommand(
        target.actions,
        collaborativeSequence.current,
      );
      const result = await api.applyCollaborativeEdit(space, command);
      if (gen !== generation.current) return;
      collaborativeRedo.current.pop();
      collaborativeBaseline.current = result.editor.map;
      collaborativeSequence.current = result.sequence;
      appendCollaborativeOperation(result.operation);
      accept(result.editor, true);
      setNotice(languageRef.current.t("editor.collaborative.redone"));
    } catch (error) {
      if (gen !== generation.current) return;
      setError(errorMessage(error, "editor.error.save"));
      handleCollaborativePermissionLoss(error);
      if (error instanceof AuthError && error.status === 409)
        void synchronizeCollaborative(gen).catch(() => {});
    } finally {
      if (gen === generation.current) setSaving(false);
    }
  }
  async function publish(revision?: string) {
    const collaborative = mode.current === "COLLABORATIVE";
    if (!canWrite.current || (!collaborative && !lease.current) || busy) return;
    const gen = generation.current;
    setBusy(true);
    setError("");
    try {
      await save();
      if (!canWrite.current || (!collaborative && !lease.current)) return;
      if (
        savedSerial.current !== serial.current ||
        (collaborative && collaborativeConflictActive.current)
      )
        throw new Error(languageRef.current.t("editor.error.save"));
      let result: api.EditorDocument;
      if (collaborative) {
        let pendingPublish = collaborativePublishPending.current;
        if (
          !pendingPublish ||
          pendingPublish.revisionId !== revision ||
          pendingPublish.baseSequence !== collaborativeSequence.current ||
          pendingPublish.baseVersion !== serverVersion.current
        ) {
          pendingPublish = {
            revisionId: revision,
            clientId: client.current,
            operationId: createUuid(),
            baseSequence: collaborativeSequence.current,
            baseVersion: serverVersion.current,
          };
          collaborativePublishPending.current = pendingPublish;
        }
        let publication: api.CollaborativePublication;
        try {
          publication = await api.publishCollaborative(
            space,
            mapId,
            pendingPublish.clientId,
            pendingPublish.operationId,
            pendingPublish.baseSequence,
            pendingPublish.baseVersion,
            revision,
          );
        } catch (error) {
          if (!(error instanceof AuthError) || error.status !== 409)
            throw error;
          const latest = await loadCollaborative(collaborativeSequence.current);
          if (gen !== generation.current) return;
          if (savedSerial.current !== serial.current) throw error;
          updateCollaborativeSnapshot(latest, true);
          accept(latest.editor, true);
          pendingPublish = {
            ...pendingPublish,
            baseSequence: latest.sequence,
            baseVersion: latest.editor.version,
          };
          collaborativePublishPending.current = pendingPublish;
          publication = await api.publishCollaborative(
            space,
            mapId,
            pendingPublish.clientId,
            pendingPublish.operationId,
            collaborativeSequence.current,
            serverVersion.current,
            revision,
          );
        }
        if (gen !== generation.current) return;
        collaborativeSequence.current = publication.editSequence;
        collaborativeBaseline.current = publication.editor.map;
        if (
          collaborativePublishPending.current?.operationId ===
          pendingPublish.operationId
        )
          collaborativePublishPending.current = undefined;
        result = publication.editor;
      } else {
        result = revision
          ? await api.restore(
              space,
              lease.current!,
              serverVersion.current,
              revision,
              mapId,
            )
          : await api.publish(
              space,
              lease.current!,
              serverVersion.current,
              mapId,
            );
      }
      if (gen !== generation.current) return;
      accept(result, true);
      let publication = result.publication ?? undefined;
      const deadline = Date.now() + 12_000;
      while (
        publication &&
        ["PUBLISHING", "APPLYING"].includes(publication.state) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (gen !== generation.current) return;
        try {
          publication = await api.publicationStatus(
            space,
            mapId,
            result.publishedRevision,
          );
        } catch {
          break;
        }
      }
      if (gen !== generation.current) return;
      if (!publication) {
        setNotice(languageRef.current.t("editor.notice.publishStatus"));
      } else if (publication.state === "APPLIED") {
        setNotice(
          languageRef.current.t(
            revision ? "editor.notice.restored" : "editor.notice.published",
          ),
        );
      } else if (publication.state === "DEGRADED") {
        setNotice(
          languageRef.current.t("editor.notice.degraded", {
            applied: publication.appliedNodes,
            target: publication.targetNodes,
          }),
        );
      } else {
        setNotice(
          languageRef.current.t("editor.notice.checking", {
            applied: publication.appliedNodes,
            target: publication.targetNodes,
          }),
        );
      }
    } catch (e) {
      if (gen === generation.current)
        setError(errorMessage(e, "editor.error.publish"));
      if (
        e instanceof AuthError &&
        [401, 403].includes(e.status) &&
        collaborative
      ) {
        handleCollaborativePermissionLoss(e);
      }
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }
  function download() {
    if (!current.current.present) return;
    const blob = new Blob([JSON.stringify(current.current.present, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hufs-map-${mapId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  useEffect(() => {
    const gen = ++generation.current;
    permissions(false);
    install({ past: [], future: [] });
    setBusy(false);
    setSaving(false);
    setDirty(false);
    setError("");
    setNotice("");
    setIssues([]);
    setVersion(0);
    setMode("LEGACY");
    collaborativeSequence.current = 0;
    collaborativeBaseline.current = undefined;
    collaborativeOperations.current = [];
    collaborativeRedo.current = [];
    collaborativePending.current = undefined;
    collaborativeSyncing.current = false;
    collaborativeConflictActive.current = false;
    collaborativeConflictEditor.current = undefined;
    setCollaborativeUndoReady(false);
    setCollaborativeRedoReady(false);
    setCollaborativeConflict(false);
    serial.current = 0;
    savedSerial.current = 0;
    serverVersion.current = 0;
    pending.current = undefined;
    setRecovery(undefined);
    try {
      const stored = JSON.parse(localStorage.getItem(recoveryKey) ?? "null");
      if (stored?.map) setRecovery(importMap(stored.map));
    } catch {}
    void begin();
    const autosave = setInterval(() => {
      void save().catch(() => {});
    }, 2500);
    const heartbeat = setInterval(() => {
      const c = lease.current;
      if (!c || !canWrite.current) return;
      void api.renew(space, c, mapId).catch((e) => {
        if (gen === generation.current) {
          permissions(false);
          lease.current = undefined;
          setError(errorMessage(e, "editor.error.leaseLost"));
        }
      });
    }, 10000);
    const collaborationPoll = setInterval(() => {
      void synchronizeCollaborative(gen).catch((error) => {
        if (gen === generation.current && mode.current === "COLLABORATIVE")
          setError(errorMessage(error, "editor.error.open"));
      });
    }, 1250);
    const unload = (e: BeforeUnloadEvent) => {
      if (serial.current !== savedSerial.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      generation.current++;
      clearInterval(autosave);
      clearInterval(heartbeat);
      clearInterval(collaborationPoll);
      window.removeEventListener("beforeunload", unload);
      const c = lease.current;
      lease.current = undefined;
      canWrite.current = false;
      if (c) void api.release(space, c, mapId).catch(() => {});
    };
    // One lease and autosave queue per mounted editor, not per canvas render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, user, mapId]);
  return {
    map: history.present,
    edit,
    undo,
    redo,
    canUndo:
      editMode === "COLLABORATIVE"
        ? dirty
          ? history.past.length > 0
          : collaborativeUndoReady
        : history.past.length > 0,
    canRedo:
      editMode === "COLLABORATIVE"
        ? dirty
          ? history.future.length > 0
          : collaborativeRedoReady
        : history.future.length > 0,
    editMode,
    collaborativeConflict,
    clientId: client.current,
    writable,
    busy,
    saving,
    dirty,
    error,
    notice,
    issues,
    version,
    recovery,
    setError,
    save,
    publish,
    enableCollaborativeEditing,
    discardCollaborativeConflict,
    download,
    retry: () => void begin(),
    takeover: async () => {
      if (flight.current) return;
      if (
        dirty &&
        !(await confirm(languageRef.current.t("editor.dialog.takeoverUnsaved")))
      )
        return;
      void begin(true);
    },
    recover: () => {
      if (recovery) {
        edit(() => recovery);
        setRecovery(undefined);
      }
    },
  };
}
