import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeText, type SummaryStage } from "./text.js";
import type { PlanProgress } from "./workflow.js";

export const WIDGET_KEY = "pi-session-summary";
export const WARNING_WIDGET_KEY = "pi-session-summary-warning";
const WARNING = "no session summary model authenticated";
const MIN_BOX_WIDTH = 16;

const STAGE_LABELS: Record<SummaryStage, string> = {
  reading: "READING",
  editing: "EDITING",
  testing: "TESTING",
  waiting: "WAITING",
  complete: "DONE",
  blocked: "BLOCKED",
  unknown: "STATUS",
};

export type SessionSummaryContent =
  | { kind: "status"; status: string; stage: SummaryStage; nextStep?: string }
  | { kind: "plan"; progress: PlanProgress; nextStep?: string };

export function formatStatusLine(status: string, stage: SummaryStage): string {
  return `${STAGE_LABELS[stage]} · ${status}`;
}

class WarningLine implements Component {
  constructor(private readonly theme: Theme, private readonly message: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [this.theme.fg("warning", truncateToWidth(this.message, width))];
  }
}

export class SessionSummaryBox implements Component {
  constructor(private readonly theme: Theme, private readonly content: SessionSummaryContent) {}
  invalidate(): void {}
  render(width: number): string[] {
    const lines = contentLines(this.content);
    const title = ` ${this.content.kind} `;
    if (width < MIN_BOX_WIDTH) return [truncateToWidth(`${this.content.kind}: ${lines.join(" · ")}`, width)];

    const contentWidth = Math.max(1, width - 4);
    const wrapped = lines.flatMap((line) => wrapTextWithAnsi(sanitizeText(line, 220), contentWidth));
    return [
      this.topBorder(width, title),
      ...(wrapped.length ? wrapped : [""]).map((line) => this.contentLine(line, contentWidth)),
      this.bottomBorder(width),
    ];
  }

  private topBorder(width: number, title: string): string {
    const rightWidth = Math.max(1, width - visibleWidth(title) - 2);
    return this.theme.fg("borderMuted", `╭${title}${"─".repeat(rightWidth)}╮`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(width - 2)}╯`);
  }

  private contentLine(line: string, contentWidth: number): string {
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
    return `${this.theme.fg("borderMuted", "│ ")}${this.theme.fg("text", line)}${padding}${this.theme.fg("borderMuted", " │")}`;
  }
}

export function showSessionSummaryWidget(ctx: ExtensionContext, content: SessionSummaryContent): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new SessionSummaryBox(theme, content), { placement: "aboveEditor" });
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

function contentLines(content: SessionSummaryContent): string[] {
  if (content.kind === "status") {
    return [
      formatStatusLine(content.status, content.stage),
      ...(content.nextStep ? [`Next: ${content.nextStep}`] : []),
    ];
  }

  return [
    `Phase ${content.progress.phaseIndex}/${content.progress.phaseCount} · ${content.progress.title}`,
    `✓ ${content.progress.completed}/${content.progress.total} tasks${content.nextStep ? ` · Next: ${content.nextStep}` : ""}`,
  ];
}
