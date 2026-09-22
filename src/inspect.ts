import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { OverlayPanel, PanelDivider, topBorder } from "@oh-my-pi/pi-tui/chrome";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
  Ellipsis,
  matchesKey,
  ScrollView,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";

import type { EagleViewProgressionSnapshot, TrackedTask } from "./progression";

const FOOTER_HINT = "↑/↓ scroll · Esc close";
const PANEL_CHROME_ROWS = 4;
const FRESHNESS_INTERVAL_MS = 30_000;

export interface EagleViewInspectionSnapshot {
  progression: EagleViewProgressionSnapshot;
  icon: string;
  updatedAt?: number;
  briefingPending: boolean;
  milestoneHistory: readonly string[];
  decisionHistory: readonly string[];
}

export interface EagleViewInspectionSource {
  getSnapshot(): EagleViewInspectionSnapshot;
  subscribe(onChange: () => void): () => void;
}

interface LogicalLine {
  id: string;
  text: string;
  continuationIndent?: number;
}

interface WrappedLine {
  id: string;
  text: string;
}

interface PresentedBlocker {
  id: string;
  phase?: string;
  label?: string;
  detail?: string;
  comparison: string;
}

export function retainAcceptedEntries(previous: readonly string[], current: readonly string[]): string[] {
  const retained = new Set(previous);
  const newlyAccepted: string[] = [];
  for (const entry of current) {
    if (retained.has(entry)) continue;
    retained.add(entry);
    newlyAccepted.push(entry);
  }
  return [...newlyAccepted, ...previous];
}

function taskKey(task: Pick<TrackedTask, "phase" | "label">): string {
  return `${task.phase}\u0000${task.label}`;
}

function presentationBlockers(snapshot: EagleViewInspectionSnapshot): PresentedBlocker[] {
  const blockedTasks = snapshot.progression.tasks
    .filter((task) => task.status === "blocked")
    .map((task) => ({
      id: `blocker:task:${taskKey(task)}`,
      phase: task.phase,
      label: task.label,
      detail: task.blocker,
      comparison: task.blocker ?? task.label,
    }));
  const taskComparisons = new Set(blockedTasks.map((entry) => entry.comparison));
  const seenDigest = new Set<string>();
  const digestEntries: PresentedBlocker[] = [];
  for (const blocker of snapshot.progression.digest.blockers) {
    if (taskComparisons.has(blocker) || seenDigest.has(blocker)) continue;
    seenDigest.add(blocker);
    digestEntries.push({ id: `blocker:digest:${blocker}`, detail: blocker, comparison: blocker });
  }
  return [...blockedTasks, ...digestEntries];
}


function historyLines(kind: "milestone" | "decision", entries: readonly string[]): LogicalLine[] {
  const symbol = kind === "milestone" ? theme.fg("success", "✓") : "•";
  return entries.map((entry) => ({
    id: `${kind}:${entry}`,
    text: `${symbol} ${entry}`,
    continuationIndent: 2,
  }));
}

function buildLogicalLines(snapshot: EagleViewInspectionSnapshot, _width: number): LogicalLine[] {
  const sections: LogicalLine[][] = [];
  const heading = (title: string): LogicalLine => ({ id: `heading:${title}`, text: theme.bold(theme.fg("accent", title)) });
  const { digest } = snapshot.progression;
  const goal = snapshot.progression.ompGoal ?? digest.goal;

  if (goal) sections.push([heading("GOAL"), { id: "goal", text: goal }]);
  if (digest.currentFocus) {
    sections.push([heading("NOW"), { id: "now", text: digest.currentFocus }]);
  } else if (snapshot.briefingPending) {
    sections.push([heading("NOW"), { id: "now:preparing", text: theme.fg("dim", "Preparing briefing…") }]);
  }

  const blockers = presentationBlockers(snapshot);
  if (blockers.length) {
    const lines: LogicalLine[] = [heading("BLOCKERS")];
    for (const blocker of blockers) {
      const label = blocker.label ? `${blocker.phase ? `${blocker.phase}: ` : ""}${blocker.label}` : blocker.detail ?? blocker.comparison;
      lines.push({ id: blocker.id, text: `${theme.fg("warning", "!")} ${label}`, continuationIndent: 2 });
      if (blocker.label && blocker.detail) lines.push({ id: `${blocker.id}:detail`, text: `  ${blocker.detail}`, continuationIndent: 2 });
    }
    sections.push(lines);
  }

  if (snapshot.milestoneHistory.length) {
    sections.push([heading("MILESTONES"), ...historyLines("milestone", snapshot.milestoneHistory)]);
  }
  if (snapshot.decisionHistory.length) {
    sections.push([heading("DECISIONS"), ...historyLines("decision", snapshot.decisionHistory)]);
  }

  return sections.flatMap((section, index) => (index === 0 ? section : [{ id: `gap:${index}`, text: "" }, ...section]));
}

function wrapLogicalLines(lines: readonly LogicalLine[], width: number): WrappedLine[] {
  const safeWidth = Math.max(1, width);
  const wrapped: WrappedLine[] = [];
  for (const line of lines) {
    const indent = Math.min(line.continuationIndent ?? 0, Math.max(0, safeWidth - 1));
    const first = wrapTextWithAnsi(line.text, safeWidth);
    if (first.length === 0) {
      wrapped.push({ id: line.id, text: "" });
      continue;
    }
    wrapped.push({ id: line.id, text: first[0] ?? "" });
    for (const continuation of first.slice(1)) {
      const continuationWidth = Math.max(1, safeWidth - indent);
      for (const part of wrapTextWithAnsi(continuation, continuationWidth)) {
        wrapped.push({ id: line.id, text: `${" ".repeat(indent)}${part}` });
      }
    }
  }
  return wrapped;
}

function relativeAge(updatedAt: number | undefined): string | undefined {
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return undefined;
  const elapsed = Math.max(0, Date.now() - updatedAt);
  if (elapsed < 60_000) return "Updated just now";
  if (elapsed < 3_600_000) return `Updated ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `Updated ${Math.floor(elapsed / 3_600_000)}h ago`;
  return `Updated ${Math.floor(elapsed / 86_400_000)}d ago`;
}

function titleForWidth(snapshot: EagleViewInspectionSnapshot, width: number): string {
  const budget = Math.max(0, width - 6);
  const identity = snapshot.icon ? `${snapshot.icon} Eagle View` : "Eagle View";
  const tasks = snapshot.progression.tasks;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const dropped = tasks.filter((task) => task.status === "abandoned").length;
  const progress = tasks.length
    ? `${completed}/${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}${dropped ? ` · ${dropped} dropped` : ""}`
    : undefined;
  const detailed = progress ? `${identity} · ${progress}` : identity;
  const age = relativeAge(snapshot.updatedAt);
  if (age) {
    for (const candidate of [detailed, identity, "Eagle View"]) {
      const gap = budget - visibleWidth(candidate) - visibleWidth(age);
      if (gap >= 1) return `${candidate}${" ".repeat(gap)}${theme.fg("dim", age)}`;
    }
    if (visibleWidth(age) <= budget) return theme.fg("dim", age);
  }
  if (visibleWidth(detailed) <= budget) return detailed;
  if (visibleWidth(identity) <= budget) return identity;
  if (snapshot.icon && visibleWidth("Eagle View") <= budget) return "Eagle View";
  return truncateToWidth("Eagle View", budget, Ellipsis.Omit);
}

export async function showProgressionOverlay(
  ctx: ExtensionContext,
  source: EagleViewInspectionSource,
  signal?: AbortSignal,
): Promise<void> {
  let disposeComponent: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>(
      (tui, _openingTheme, _keybindings, done) => {
        let snapshot: EagleViewInspectionSnapshot;
        let dataDirty = true;
        let invalidated = true;
        let disposed = false;
        let lastWidth = -1;
        let lastBodyCapacity = -1;
        let wrapped: WrappedLine[] = [];
        let timer: Timer | undefined;
        const scrollView = new ScrollView([], {
          height: 0,
          scrollbar: "auto",
          ellipsis: Ellipsis.Omit,
          theme: {
            track: (text) => theme.fg("dim", text),
            thumb: (text) => theme.fg("accent", text),
          },
        });
        const footer = new Text("", 0, 0);
        footer.setStyleFn((text) => theme.fg("dim", text));
        const panel = new OverlayPanel("Eagle View");
        panel.addChild(scrollView);
        panel.addChild(new PanelDivider());
        panel.addChild(footer);

        let unsubscribe = () => {};
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          unsubscribe();
          if (timer) ctx.clearTimer(timer);
          timer = undefined;
          panel.dispose();
        };
        disposeComponent = dispose;
        unsubscribe = source.subscribe(() => {
          if (disposed) return;
          snapshot = source.getSnapshot();
          dataDirty = true;
          tui.requestRender();
        });
        snapshot = source.getSnapshot();
        timer = ctx.setInterval(() => {
          if (!disposed) tui.requestRender();
        }, FRESHNESS_INTERVAL_MS);

        const rebuild = (innerWidth: number, bodyCapacity: number) => {
          const previousOffset = scrollView.getScrollOffset();
          const anchor = wrapped[previousOffset];
          const anchorOffset = anchor ? wrapped.slice(0, previousOffset).filter((line) => line.id === anchor.id).length : 0;
          let logical = buildLogicalLines(snapshot, innerWidth);
          let next = wrapLogicalLines(logical, innerWidth);
          if (next.length > bodyCapacity && innerWidth > 1) {
            logical = buildLogicalLines(snapshot, innerWidth - 1);
            next = wrapLogicalLines(logical, innerWidth - 1);
          }
          wrapped = next;
          scrollView.setLines(next.map((line) => line.text));
          const height = Math.min(next.length, bodyCapacity);
          scrollView.setHeight(height);
          if (previousOffset === 0) {
            scrollView.setScrollOffset(0);
          } else if (anchor) {
            const indices = next.flatMap((line, index) => (line.id === anchor.id ? [index] : []));
            if (indices.length) scrollView.setScrollOffset(indices[Math.min(anchorOffset, indices.length - 1)] ?? previousOffset);
            else scrollView.setScrollOffset(previousOffset);
          } else {
            scrollView.setScrollOffset(previousOffset);
          }
        };

        const component = {
          render(width: number): readonly string[] {
            const safeWidth = Math.max(0, Math.trunc(width));
            const budget = Math.max(1, Math.floor(tui.terminal.rows * 0.85));
            if (safeWidth < 4 || budget < 5) {
              const title = truncateToWidth(titleForWidth(snapshot, safeWidth), safeWidth, Ellipsis.Omit);
              const footerLine = truncateToWidth(theme.fg("dim", FOOTER_HINT), safeWidth, Ellipsis.Omit);
              if (budget === 1) return [truncateToWidth(footerLine, safeWidth, null, true)];
              return [
                truncateToWidth(title, safeWidth, null, true),
                ...Array.from({ length: Math.max(0, budget - 2) }, () => " ".repeat(safeWidth)),
                truncateToWidth(footerLine, safeWidth, null, true),
              ];
            }
            const innerWidth = Math.max(1, safeWidth - 4);
            const bodyCapacity = Math.max(1, budget - PANEL_CHROME_ROWS);
            if (dataDirty || invalidated || safeWidth !== lastWidth || bodyCapacity !== lastBodyCapacity) {
              rebuild(innerWidth, bodyCapacity);
              dataDirty = false;
              invalidated = false;
              lastWidth = safeWidth;
              lastBodyCapacity = bodyCapacity;
            }
            footer.setText(truncateToWidth(FOOTER_HINT, innerWidth, Ellipsis.Omit));
            const rows = [...panel.render(safeWidth)];
            rows[0] = topBorder(safeWidth, titleForWidth(snapshot, safeWidth));
            return rows.slice(0, budget);
          },
          invalidate(): void {
            invalidated = true;
            panel.invalidate();
          },
          handleInput(data: string): void {
            if (matchesKey(data, "escape") || data === "q") {
              done();
              return;
            }
            if (scrollView.handleScrollKey(data)) tui.requestRender();
          },
          dispose,
        };
        return component;
      },
      {
        overlay: true,
        signal,
        overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 },
      },
    );
  } finally {
    disposeComponent?.();
  }
}
