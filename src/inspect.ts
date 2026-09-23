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

const FOOTER_HINT = "↑/↓ scroll · Esc close";
const PANEL_CHROME_ROWS = 4;
const FRESHNESS_INTERVAL_MS = 30_000;

export interface EagleViewMessage {
  id: number;
  text: string;
  firstAt: number;
  latestAt: number;
  count: number;
}

export interface EagleViewInspectionSnapshot {
  icon: string;
  messages: readonly EagleViewMessage[];
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

function sameLocalDay(left: number, right: number): boolean {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalMoment(timestamp: number, includeDate: boolean): string {
  const date = new Date(timestamp);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (!includeDate) return time;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

function timestampLabel(entry: EagleViewMessage, newestAt: number): string {
  const spansDays = !sameLocalDay(entry.firstAt, entry.latestAt);
  const isOlderDay = !sameLocalDay(entry.latestAt, newestAt);
  const includeDate = spansDays || isOlderDay;
  const latest = formatLocalMoment(entry.latestAt, includeDate);
  if (entry.count === 1) return latest;

  const first = formatLocalMoment(entry.firstAt, includeDate);
  const range = entry.firstAt === entry.latestAt ? latest : `${first}–${latest}`;
  return `${range} · ${entry.count} updates`;
}

function buildLogicalLines(snapshot: EagleViewInspectionSnapshot, _width: number): LogicalLine[] {
  const newestAt = snapshot.messages[0]?.latestAt;
  if (newestAt === undefined) {
    return [{ id: "empty", text: theme.fg("dim", "No updates yet.") }];
  }

  return snapshot.messages.flatMap((entry, index) => {
    const baseId = `message:${entry.id}`;
    const lines: LogicalLine[] = [
      {
        id: `${baseId}:time`,
        text: theme.fg("dim", timestampLabel(entry, newestAt)),
      },
      {
        id: `${baseId}:text`,
        text: entry.text,
      },
    ];
    if (index < snapshot.messages.length - 1) {
      lines.push({ id: `${baseId}:gap`, text: "" });
    }
    return lines;
  });
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
  const age = relativeAge(snapshot.messages[0]?.latestAt);
  if (age) {
    for (const candidate of [identity, "Eagle View"]) {
      const gap = budget - visibleWidth(candidate) - visibleWidth(age);
      if (gap >= 1) return `${candidate}${" ".repeat(gap)}${theme.fg("dim", age)}`;
    }
    if (visibleWidth(age) <= budget) return theme.fg("dim", age);
  }
  if (visibleWidth(identity) <= budget) return identity;
  if (snapshot.icon && visibleWidth("Eagle View") <= budget) return "Eagle View";
  return truncateToWidth("Eagle View", budget, Ellipsis.Omit);
}

export async function showMessageHistoryOverlay(
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
