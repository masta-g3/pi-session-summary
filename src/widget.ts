import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeText } from "./text.js";

export const WIDGET_KEY = "pi-session-summary";
export const WARNING_WIDGET_KEY = "pi-session-summary-warning";
const TITLE = " status ";
const WARNING = "no session summary model authenticated";
const MIN_BOX_WIDTH = 16;

class WarningLine implements Component {
  constructor(private readonly theme: Theme, private readonly message: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [this.theme.fg("warning", truncateToWidth(this.message, width))];
  }
}

export class SessionSummaryBox implements Component {
  constructor(private readonly theme: Theme, private readonly status: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    const safeStatus = sanitizeText(this.status, 220);
    if (width < MIN_BOX_WIDTH) return [truncateToWidth(`status: ${safeStatus}`, width)];

    const contentWidth = Math.max(1, width - 4);
    const lines = wrapTextWithAnsi(safeStatus, contentWidth);
    return [
      this.topBorder(width),
      ...(lines.length ? lines : [""]).map((line) => this.contentLine(line, contentWidth)),
      this.bottomBorder(width),
    ];
  }

  private topBorder(width: number): string {
    const rightWidth = Math.max(1, width - visibleWidth(TITLE) - 2);
    return this.theme.fg("borderMuted", `╭${TITLE}${"─".repeat(rightWidth)}╮`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(width - 2)}╯`);
  }

  private contentLine(line: string, contentWidth: number): string {
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
    return `${this.theme.fg("borderMuted", "│ ")}${this.theme.fg("text", line)}${padding}${this.theme.fg("borderMuted", " │")}`;
  }
}

export function showSessionSummaryWidget(ctx: ExtensionContext, status: string): void {
  if (!ctx.hasUI) return;
  const safeStatus = sanitizeText(status, 220);
  if (!safeStatus) {
    clearSessionSummaryWidget(ctx);
    return;
  }
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new SessionSummaryBox(theme, safeStatus), { placement: "aboveEditor" });
}

export function clearSessionSummaryWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function showNoModelWarning(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WARNING_WIDGET_KEY, (_tui, theme) => new WarningLine(theme, WARNING), { placement: "aboveEditor" });
}

export function clearNoModelWarning(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WARNING_WIDGET_KEY, undefined);
}

export function notifyUser(ctx: ExtensionContext, message: string, level: "info" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, level);
}
