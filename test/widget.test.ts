import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TldrLiteBox } from "../src/widget.js";

const theme = {
  fg(_token: string, text: string) {
    return text;
  },
};

test("renders a normal TLDR box", () => {
  const lines = new TldrLiteBox(theme as never, "Planning Agent Hub integration.").render(40);
  assert.equal(lines[0]?.startsWith("╭ tldr "), true);
  assert.equal(lines.at(-1), "╰──────────────────────────────────────╯");
});

test("uses narrow fallback", () => {
  const lines = new TldrLiteBox(theme as never, "Planning Agent Hub integration.").render(10);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.startsWith("tldr:"));
});

test("wraps without exceeding visible width", () => {
  const lines = new TldrLiteBox(theme as never, "Implementing semantic workflow summaries for many Pi Agent Hub sessions.").render(24);
  assert.ok(lines.length > 3);
  for (const line of lines) assert.ok(visibleWidth(line) <= 24, line);
});
