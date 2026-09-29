import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { useLanguage } from "../i18n/language";
import type { CampusScene } from "./CampusScene";

type StickPosition = { x: number; y: number };

export function MobileMovementPad({
  sceneRef,
}: {
  sceneRef: RefObject<CampusScene | null>;
}) {
  const { t } = useLanguage();
  const joystickRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | undefined>(undefined);
  const runningRef = useRef(false);
  const [position, setPosition] = useState<StickPosition>({ x: 0, y: 0 });
  const [running, setRunning] = useState(false);

  function updatePointer(event: PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== event.pointerId) return;
    const bounds = joystickRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const maxTravel = Math.max(1, Math.min(bounds.width, bounds.height) / 2 - 28);
    const deltaX = event.clientX - (bounds.left + bounds.width / 2);
    const deltaY = event.clientY - (bounds.top + bounds.height / 2);
    const distance = Math.hypot(deltaX, deltaY);
    const intensity = Math.min(1, distance / maxTravel);
    const deadZone = 0.14;
    const next = distance > 0 && intensity >= deadZone
      ? { x: (deltaX / distance) * intensity, y: (deltaY / distance) * intensity }
      : { x: 0, y: 0 };
    const effectiveIntensity = intensity < deadZone ? 0 : intensity;
    const nextRunning = effectiveIntensity > 0 && (runningRef.current
      ? effectiveIntensity >= 0.68
      : effectiveIntensity >= 0.82);
    runningRef.current = nextRunning;
    setRunning(nextRunning);
    setPosition(next);
    sceneRef.current?.setTouchVector(next.x, next.y, nextRunning);
  }

  function releasePointer(event: PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = undefined;
    runningRef.current = false;
    setRunning(false);
    setPosition({ x: 0, y: 0 });
    sceneRef.current?.setTouchVector(0, 0, false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  useEffect(() => () => sceneRef.current?.clearTouchInput(), [sceneRef]);

  return (
    <div className={`mobile-movement${running ? " is-running" : ""}`}>
      <div
        ref={joystickRef}
        className="mobile-joystick"
        role="group"
        aria-label={t("mobile.movement.group")}
        aria-describedby="mobile-joystick-status"
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          if (pointerIdRef.current !== undefined) return;
          pointerIdRef.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          updatePointer(event);
        }}
        onPointerMove={updatePointer}
        onPointerUp={releasePointer}
        onPointerCancel={releasePointer}
        onLostPointerCapture={releasePointer}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="mobile-joystick-guide horizontal" aria-hidden="true" />
        <span className="mobile-joystick-guide vertical" aria-hidden="true" />
        <span className="mobile-joystick-center" aria-hidden="true" />
        <span
          className="mobile-joystick-knob"
          aria-hidden="true"
          style={{
            transform: `translate(calc(-50% + ${position.x * 40}px), calc(-50% + ${position.y * 40}px))`,
          }}
        />
      </div>
      <span className="mobile-joystick-status" id="mobile-joystick-status" aria-live="polite">
        {t(running ? "mobile.movement.run" : "mobile.movement.walk")}
      </span>
    </div>
  );
}
