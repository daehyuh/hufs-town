import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PanelDisclosureButton } from "../../src/app/PanelDisclosureButton";

function render(expanded: boolean) {
  return renderToStaticMarkup(
    createElement(
      PanelDisclosureButton,
      {
        expanded,
        controlsId: "campus-info-panel",
        "aria-label": "참가자 보기",
      },
      "사람들",
    ),
  );
}

it("exposes the open state and controlled campus panel to assistive technology", () => {
  const closed = render(false);
  const open = render(true);

  expect(closed).toContain('aria-expanded="false"');
  expect(closed).not.toContain("aria-controls=");
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain('aria-controls="campus-info-panel"');
  expect(open).toContain('aria-label="참가자 보기"');
});
