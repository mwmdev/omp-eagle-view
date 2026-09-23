import { beforeAll, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, initTheme, theme } from "@oh-my-pi/pi-tui";

import {
  showMessageHistoryOverlay,
  type EagleViewInspectionSnapshot,
  type EagleViewInspectionSource,
} from "../src/inspect";

beforeAll(async () => {
  await initTheme(false);
});

class MutableSource implements EagleViewInspectionSource {
  snapshot: EagleViewInspectionSnapshot;
  listener?: () => void;
  subscriptions = 0;
  unsubscriptions = 0;

  constructor(snapshot: EagleViewInspectionSnapshot) {
    this.snapshot = snapshot;
  }

  getSnapshot(): EagleViewInspectionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listener = listener;
    this.subscriptions += 1;
    return () => {
      if (this.listener === listener) this.listener = undefined;
      this.unsubscriptions += 1;
    };
  }

  publish(snapshot: EagleViewInspectionSnapshot): void {
    this.snapshot = snapshot;
    this.listener?.();
  }
}

interface CapturedComponent extends Component {
  handleInput(data: string): void;
  dispose(): void;
}

function at(day: number, hour: number, minute: number): number {
  return new Date(2026, 8, day, hour, minute).getTime();
}

function mixedSnapshot(): EagleViewInspectionSnapshot {
  return {
    icon: "🦅",
    messages: [
      {
        id: 6,
        text: "Newest update explains the current work in plain language.",
        firstAt: at(23, 12, 20),
        latestAt: at(23, 12, 30),
        count: 3,
      },
      { id: 5, text: "Fifth update", firstAt: at(23, 12, 10), latestAt: at(23, 12, 10), count: 1 },
      { id: 4, text: "Fourth update", firstAt: at(23, 12, 0), latestAt: at(23, 12, 0), count: 1 },
      { id: 3, text: "Third update", firstAt: at(23, 11, 50), latestAt: at(23, 11, 50), count: 1 },
      { id: 2, text: "Second update", firstAt: at(23, 11, 40), latestAt: at(23, 11, 40), count: 1 },
      { id: 1, text: "First update", firstAt: at(22, 17, 5), latestAt: at(22, 17, 5), count: 1 },
    ],
  };
}

function openPanel(source: MutableSource, rows = 40) {
  let component: CapturedComponent | undefined;
  let close: (() => void) | undefined;
  let renderRequests = 0;
  const timers: Array<{ callback: () => unknown; cleared: boolean }> = [];
  const tui = { terminal: { rows }, requestRender: () => (renderRequests += 1) };
  const context = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: async (factory: Function) =>
        new Promise<void>((resolve) => {
          close = resolve;
          component = factory(tui, theme, {}, resolve);
        }),
    },
    setInterval: (callback: () => unknown) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: { cleared: boolean }) => {
      timer.cleared = true;
    },
  } as unknown as ExtensionContext;
  const completion = showMessageHistoryOverlay(context, source);
  return {
    component: () => {
      if (!component) throw new Error("panel factory was not captured");
      return component;
    },
    completion,
    close: () => close?.(),
    timers,
    renderRequests: () => renderRequests,
    setRows: (value: number) => {
      tui.terminal.rows = value;
    },
  };
}

function plain(lines: readonly string[]): string[] {
  return lines.map((line) => Bun.stripANSI(line));
}

test("renders timestamped message history without structured progression sections", async () => {
  const source = new MutableSource(mixedSnapshot());
  const panel = openPanel(source, 100);
  const rendered = plain(panel.component().render(100));
  const text = rendered.join("\n");

  panel.setRows(40);
  const constrained = plain(panel.component().render(100));
  expect(constrained.length).toBeLessThanOrEqual(34);
  expect(constrained.every((line) => Bun.stringWidth(line) <= 100)).toBe(true);
  expect(constrained.at(-2)).toContain("↑/↓ scroll · Esc close");
  expect(text).toContain("12:20–12:30 · 3 updates");
  expect(text).toContain("Newest update explains the current work in plain language.");
  expect(text).toContain("2026-09-22 17:05");
  expect(text).toContain("First update");
  expect(text).not.toContain("GOAL");
  expect(text).not.toContain("NOW");
  expect(text).not.toContain("BLOCKERS");
  expect(text).not.toContain("MILESTONES");
  expect(text).not.toContain("DECISIONS");
  expect(text).not.toContain("tasks");

  panel.component().handleInput("q");
  await panel.completion;
  expect(source.unsubscriptions).toBe(1);
  expect(panel.timers[0]?.cleared).toBe(true);
});

test("shows a deterministic empty state before the first accepted message", async () => {
  const source = new MutableSource({ icon: "", messages: [] });
  const panel = openPanel(source, 20);
  const text = plain(panel.component().render(80)).join("\n");
  expect(text).toContain("No updates yet.");
  expect(text).not.toContain("Updated");
  expect(text).not.toContain("Preparing");
  panel.component().handleInput("q");
  await panel.completion;
});

test("caps height, fits narrow rows, follows newest updates, and preserves older reading position", async () => {
  const source = new MutableSource(mixedSnapshot());
  const panel = openPanel(source, 16);
  const component = panel.component();
  const initial = plain(component.render(60));
  expect(initial.length).toBeLessThanOrEqual(13);
  expect(initial.every((line) => Bun.stringWidth(line) <= 60)).toBe(true);
  expect(initial.some((line) => line.includes("█") || line.includes("│"))).toBe(true);

  const followed = mixedSnapshot();
  followed.messages = [
    { id: 7, text: "A newly accepted update", firstAt: at(23, 12, 40), latestAt: at(23, 12, 40), count: 1 },
    ...followed.messages,
  ];
  source.publish(followed);
  expect(plain(component.render(60)).join("\n")).toContain("A newly accepted update");

  let historyAnchor = plain(component.render(60));
  for (let index = 0; index < 80 && !historyAnchor.some((line) => line.includes("Third update")); index += 1) {
    component.handleInput("\u001b[B");
    historyAnchor = plain(component.render(60));
  }
  const anchorIndex = historyAnchor.findIndex((line) => line.includes("Third update"));
  expect(anchorIndex).toBeGreaterThanOrEqual(0);

  const inserted = {
    ...followed,
    messages: [
      { id: 8, text: "Another new update", firstAt: at(23, 12, 50), latestAt: at(23, 12, 50), count: 1 },
      ...followed.messages,
    ],
  };
  source.publish(inserted);
  expect(plain(component.render(60))[anchorIndex]).toContain("Third update");

  const grouped = {
    ...inserted,
    messages: inserted.messages.map((message, index) =>
      index === 0 ? { ...message, latestAt: at(23, 12, 55), count: 2 } : message,
    ),
  };
  source.publish(grouped);
  expect(plain(component.render(60))[anchorIndex]).toContain("Third update");

  component.invalidate?.();
  const resized = plain(component.render(20));
  expect(resized.length).toBeLessThanOrEqual(13);
  expect(resized.every((line) => Bun.stringWidth(line) <= 20)).toBe(true);
  expect(resized.join("\n")).toContain("Third update");

  component.handleInput("\u001b[H");
  expect(plain(component.render(20)).join("\n")).toContain("Another new");
  panel.timers[0]?.callback();
  expect(plain(component.render(20)).join("\n")).toContain("Another new");

  component.handleInput("q");
  await panel.completion;
});

test("renders age boundaries and compact height safely", async () => {
  const originalNow = Date.now;
  let now = at(23, 12, 30);
  Date.now = () => now;
  try {
    const source = new MutableSource(mixedSnapshot());
    source.snapshot = {
      ...source.snapshot,
      messages: source.snapshot.messages.map((message, index) =>
        index === 0 ? { ...message, firstAt: now, latestAt: now, count: 1 } : message,
      ),
    };
    const panel = openPanel(source, 6);
    expect(plain(panel.component().render(100))[0]).toContain("Updated just now");
    now += 61_000;
    panel.timers[0]?.callback();
    expect(plain(panel.component().render(100))[0]).toContain("Updated 1m ago");
    now += 3_600_000;
    expect(plain(panel.component().render(100))[0]).toContain("Updated 1h ago");
    now += 86_400_000;
    expect(plain(panel.component().render(100))[0]).toContain("Updated 1d ago");
    expect(panel.component().render(3)).toHaveLength(5);
    expect(plain(panel.component().render(3)).every((line) => Bun.stringWidth(line) <= 3)).toBe(true);
    panel.component().handleInput("q");
    await panel.completion;
    const requests = panel.renderRequests();
    panel.timers[0]?.callback();
    source.publish(source.snapshot);
    expect(panel.renderRequests()).toBe(requests);
  } finally {
    Date.now = originalNow;
  }
});

test("cleans partial setup and omits age for empty history", async () => {
  let unsubscriptions = 0;
  const snapshot: EagleViewInspectionSnapshot = { icon: "🦅", messages: [] };
  const source: EagleViewInspectionSource = {
    getSnapshot: () => snapshot,
    subscribe: () => {
      throw new Error("subscription failed");
    },
  };
  let rendered = "";
  const context = {
    ui: {
      custom: async (factory: Function) => {
        const component = factory({ terminal: { rows: 40 }, requestRender: () => {} }, theme, {}, () => {});
        rendered = Bun.stripANSI(component.render(80).join("\n"));
        component.dispose?.();
      },
    },
    setInterval: () => {
      throw new Error("timer must not start after subscription failure");
    },
    clearTimer: () => {
      unsubscriptions += 1;
    },
  } as unknown as ExtensionContext;
  await expect(showMessageHistoryOverlay(context, source)).rejects.toThrow("subscription failed");
  expect(rendered).toBe("");
  expect(unsubscriptions).toBe(0);

  const healthy = new MutableSource(snapshot);
  const panel = openPanel(healthy);
  expect(Bun.stripANSI(panel.component().render(80)[0] ?? "")).not.toContain("Updated");
  panel.component().handleInput("q");
  await panel.completion;
});
