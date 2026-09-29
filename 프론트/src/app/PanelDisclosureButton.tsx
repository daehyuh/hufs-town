import type { ButtonHTMLAttributes } from "react";

interface PanelDisclosureButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-controls" | "aria-expanded"
> {
  expanded: boolean;
  controlsId: string;
}

export function PanelDisclosureButton({
  expanded,
  controlsId,
  ...buttonProps
}: PanelDisclosureButtonProps) {
  return (
    <button
      {...buttonProps}
      aria-expanded={expanded}
      aria-controls={expanded ? controlsId : undefined}
    />
  );
}
