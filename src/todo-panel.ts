import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import type { WorkflowPlan, WorkflowPlanTask } from "./workflow.js";

export const TODO_PANEL_SHORTCUT = Key.ctrlAlt("t");
export const TODO_PANEL_OVERLAY_OPTIONS = {
  anchor: "right-center",
  width: 54,
  minWidth: 36,
  maxHeight: "80%",
  margin: { right: 1 },
} as const satisfies OverlayOptions;

const PANEL_HEIGHT_RATIO = 0.8;
const FRAME_ROWS = 3;
const MIN_BODY_ROWS = 1;
const TASK_PREFIX = "  ";
const COMPLETE_GLYPH = "☑";
const OPEN_GLYPH = "☐";

interface PanelRow {
  text: string;
  sectionStart?: boolean;
  incompleteStart?: boolean;
}

export class TodoPanel implements Component {
  private scrollOffset = 0;
  private totalRows = 0;
  private viewportRows = 1;
  private positioned = false;
  private closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly ticketId: string,
    private readonly plan: WorkflowPlan,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 4) return width > 0 ? [truncateToWidth("Plan", width)] : [];
    const safeWidth = width;
    const contentWidth = Math.max(1, safeWidth - 4);
    const rows = this.buildRows(contentWidth);
    this.totalRows = rows.length;
    this.viewportRows = Math.min(rows.length, this.bodyCapacity());

    const maxOffset = this.maxOffset();
    if (!this.positioned) {
      const sectionStart = rows.findIndex((row) => row.sectionStart);
      const incompleteStart = rows.findIndex((row) => row.incompleteStart);
      const initialOffset = incompleteStart >= 0
        ? Math.max(sectionStart, incompleteStart - this.viewportRows + 1)
        : 0;
      this.scrollOffset = Math.min(maxOffset, Math.max(0, initialOffset));
      this.positioned = true;
    } else {
      this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    }

    const visible = rows.slice(this.scrollOffset, this.scrollOffset + this.viewportRows);
    return [
      this.topBorder(safeWidth),
      ...visible.map((row) => this.contentLine(row.text, contentWidth)),
      this.contentLine(this.footer(contentWidth), contentWidth),
      this.bottomBorder(safeWidth),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, TODO_PANEL_SHORTCUT)) {
      if (!this.closed) {
        this.closed = true;
        this.onClose();
      }
      return;
    }

    const previous = this.scrollOffset;
    if (matchesKey(data, Key.up)) this.scrollOffset -= 1;
    else if (matchesKey(data, Key.down)) this.scrollOffset += 1;
    else if (matchesKey(data, Key.pageUp)) this.scrollOffset -= this.viewportRows;
    else if (matchesKey(data, Key.pageDown)) this.scrollOffset += this.viewportRows;
    else return;

    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxOffset()));
    if (this.scrollOffset !== previous) this.tui.requestRender();
  }

  private buildRows(contentWidth: number): PanelRow[] {
    return this.plan.sections.flatMap((section, sectionIndex) => {
      const heading = section.heading ?? "Tasks";
      const current = sectionIndex === this.plan.currentSectionIndex;
      const headingLines = wrapTextWithAnsi(heading, contentWidth);
      const firstIncompleteTask = current ? section.tasks.findIndex((task) => !task.done) : -1;
      const rows: PanelRow[] = headingLines.map((line, lineIndex) => ({
        text: current
          ? this.theme.fg("accent", this.theme.bold(line))
          : this.theme.fg("muted", this.theme.bold(line)),
        ...(lineIndex === 0 && current ? { sectionStart: true } : {}),
      }));
      section.tasks.forEach((task, taskIndex) => {
        rows.push(...this.taskRows(task, contentWidth, taskIndex === firstIncompleteTask));
      });
      return rows;
    });
  }

  private taskRows(task: WorkflowPlanTask, contentWidth: number, incompleteStart = false): PanelRow[] {
    const textWidth = Math.max(1, contentWidth - visibleWidth(TASK_PREFIX));
    return wrapTextWithAnsi(task.text, textWidth).map((line, index) => {
      const marker = index === 0
        ? this.theme.fg(task.done ? "success" : "dim", task.done ? COMPLETE_GLYPH : OPEN_GLYPH)
        : " ";
      const styledText = this.theme.fg(task.done ? "muted" : "text", line);
      return {
        text: `${marker} ${styledText}`,
        ...(incompleteStart && index === 0 ? { incompleteStart: true } : {}),
      };
    });
  }

  private bodyCapacity(): number {
    return Math.max(MIN_BODY_ROWS, Math.floor(this.tui.terminal.rows * PANEL_HEIGHT_RATIO) - FRAME_ROWS);
  }

  private maxOffset(): number {
    return Math.max(0, this.totalRows - this.viewportRows);
  }

  private footer(contentWidth: number): string {
    const first = this.totalRows ? this.scrollOffset + 1 : 0;
    const last = Math.min(this.totalRows, this.scrollOffset + this.viewportRows);
    const detail = `${this.plan.completed}/${this.plan.total} done · ${first}–${last}/${this.totalRows} rows · ↑↓ PgUp/PgDn · Esc`;
    return this.theme.fg("dim", truncateToWidth(detail, contentWidth));
  }

  private topBorder(width: number): string {
    const title = truncateToWidth(` Plan · ${this.ticketId} `, Math.max(1, width - 2));
    const remaining = Math.max(0, width - visibleWidth(title) - 2);
    return `${this.theme.fg("borderMuted", "╭")}${this.theme.fg("accent", this.theme.bold(title))}${this.theme.fg("borderMuted", `${"─".repeat(remaining)}╮`)}`;
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  private contentLine(line: string, contentWidth: number): string {
    const text = truncateToWidth(line, contentWidth);
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(text)));
    return `${this.theme.fg("borderMuted", "│ ")}${text}${padding}${this.theme.fg("borderMuted", " │")}`;
  }
}
