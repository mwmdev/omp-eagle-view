import { beforeAll, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, initTheme, theme } from "@oh-my-pi/pi-tui";

import {
  retainAcceptedEntries,
  showProgressionOverlay,
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

function mixedSnapshot(): EagleViewInspectionSnapshot {
  return {
    icon: "🦅",
    updatedAt: Date.now(),
    briefingPending: false,
    milestoneHistory: ["Fifth milestone", "Fourth milestone", "Third milestone", "Second milestone", "First milestone"],
    decisionHistory: ["Fourth decision", "Third decision", "Second decision", "First decision"],
    progression: {
      ompGoal: "Make configuration discovery reliable across environments.",
      digest: {
        goal: "Inferred goal should yield to the native goal.",
        currentFocus: "Comparing saved evidence with the expected behavior to locate the remaining failure.",
        completedMilestones: [],
        decisions: [],
        blockers: ["Waiting for approval", "Offline validation is unavailable"],
      },
      tasks: [
        { phase: "Contracts", label: "Define schemas", status: "completed" },
        { phase: "Contracts", label: "Validate contracts", status: "completed" },
        { phase: "Acceptance", label: "Prepare evidence", status: "completed" },
        {
          phase: "Acceptance",
          label: "Compare evaluator details, stored evidence, and scenario validation",
          status: "in_progress",
        },
        { phase: "Acceptance", label: "Diagnose the contextual follow-up failure", status: "pending" },
        { phase: "Acceptance", label: "Verify the repaired evidence path", status: "pending" },
        { phase: "Acceptance", label: "Review edge cases", status: "pending" },
        { phase: "Acceptance", label: "Await fixture approval", status: "blocked", blocker: "Waiting for approval" },
        { phase: "Diagnostics", label: "Check offline loading", status: "pending" },
        { phase: "Diagnostics", label: "Legacy probe", status: "abandoned" },
        {
          phase: "Diagnostics",
          label: "Obtain reference bundle",
          status: "blocked",
          blocker: "Reference bundle missing",
        },
      ],
    },
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
  const completion = showProgressionOverlay(context, source);
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

test("retains accepted history newest-first across later omissions", () => {
  expect(retainAcceptedEntries(["B", "A"], ["A", "C", "B"])).toEqual(["C", "B", "A"]);
  expect(retainAcceptedEntries(["C", "B", "A"], ["B", "C"])).toEqual(["C", "B", "A"]);
  expect(retainAcceptedEntries(["C", "B", "A"], ["D", "C", "D"])).toEqual(["D", "C", "B", "A"]);
});

test("renders the session story without duplicating the visible plan", async () => {
  const source = new MutableSource(mixedSnapshot());
  const panel = openPanel(source, 100);
  const rendered = plain(panel.component().render(100));
  const text = rendered.join("\n");

  panel.setRows(40);
  const constrained = plain(panel.component().render(100));
  expect(constrained.length).toBeLessThanOrEqual(34);
  expect(constrained.every((line) => Bun.stringWidth(line) <= 100)).toBe(true);
  expect(constrained.at(-2)).toContain("↑/↓ scroll · Esc close");
  expect(text.indexOf("GOAL")).toBeLessThan(text.indexOf("NOW"));
  expect(text.indexOf("NOW")).toBeLessThan(text.indexOf("BLOCKERS"));
  expect(text.indexOf("BLOCKERS")).toBeLessThan(text.indexOf("MILESTONES"));
  expect(text.indexOf("MILESTONES")).toBeLessThan(text.indexOf("DECISIONS"));
  expect(text).toContain("3/11 tasks · 1 dropped");
  expect(text).toContain("Make configuration discovery reliable across environments.");
  expect(text).not.toContain("Inferred goal should yield to the native goal.");
  expect(text).not.toContain("PLAN");
  expect(text).not.toContain("Contracts");
  expect(text).not.toContain("Compare evaluator details, stored evidence, and scenario validation");
  expect(text).not.toContain("Diagnose the contextual follow-up failure");
  expect(text).toContain("Acceptance: Await fixture approval");
  expect(text).toContain("Waiting for approval");
  expect(text).toContain("Diagnostics: Obtain reference bundle");
  expect(text).toContain("Offline validation is unavailable");
  expect(text).toContain("Fifth milestone");
  expect(text).toContain("First milestone");
  expect(text).toContain("Fourth decision");
  expect(text).toContain("First decision");
  expect(text).not.toContain("earlier milestones");
  expect(text).not.toContain("earlier decisions");

  panel.component().handleInput("q");
  await panel.completion;
  expect(source.unsubscriptions).toBe(1);
  expect(panel.timers[0]?.cleared).toBe(true);
});

test("opens with deterministic data while preparing the first briefing", async () => {
  const source = new MutableSource({
    icon: "",
    briefingPending: true,
    milestoneHistory: [],
    decisionHistory: [],
    progression: {
      ompGoal: "Raw fallback",
      digest: { completedMilestones: [], decisions: [], blockers: [] },
      tasks: [
        { phase: "Finished", label: "Done", status: "completed" },
        { phase: "Dropped", label: "Not done", status: "abandoned" },
      ],
    },
  });
  const panel = openPanel(source, 20);
  const text = plain(panel.component().render(80)).join("\n");
  expect(text).toContain("GOAL");
  expect(text).toContain("Raw fallback");
  expect(text).toContain("NOW");
  expect(text).toContain("Preparing briefing…");
  expect(text).toContain("1/2 tasks · 1 dropped");
  expect(text).not.toContain("PLAN");
  expect(text).not.toContain("Done");
  source.publish({ ...source.snapshot, briefingPending: false });
  const inactive = plain(panel.component().render(80)).join("\n");
  expect(inactive).not.toContain("NOW");
  expect(inactive).not.toContain("Preparing briefing…");
  expect(text).not.toContain("Not done");
  panel.component().handleInput("q");
  await panel.completion;
});

test("caps height, fits narrow rows, scrolls, and preserves logical position on updates", async () => {
  const source = new MutableSource(mixedSnapshot());
  const panel = openPanel(source, 16);
  const component = panel.component();
  const initial = plain(component.render(60));
  expect(initial.length).toBeLessThanOrEqual(13);
  expect(initial.every((line) => Bun.stringWidth(line) <= 60)).toBe(true);
  expect(initial.some((line) => line.includes("█") || line.includes("│"))).toBe(true);

  let historyAnchor = plain(component.render(60));
  for (let index = 0; index < 80 && !historyAnchor[1]?.includes("Third milestone"); index += 1) {
    component.handleInput("\u001b[B");
    historyAnchor = plain(component.render(60));
  }
  expect(historyAnchor[1]).toContain("Third milestone");

  const changed = mixedSnapshot();
  changed.progression.ompGoal = `${changed.progression.ompGoal} This added sentence changes wrapping above the current viewport.`;
  source.publish(changed);
  const updated = plain(component.render(60));
  expect(updated[1]).toContain("Third milestone");

  source.publish({
    ...changed,
    milestoneHistory: changed.milestoneHistory.filter((entry) => entry !== "Third milestone"),
  });
  const removedAnchor = plain(component.render(60));
  expect(removedAnchor[1]).not.toContain("Third milestone");
  expect(removedAnchor[1]).not.toContain("GOAL");
  expect(removedAnchor.join("\n")).toContain("Fourth milestone");

  component.invalidate?.();
  const resized = plain(component.render(20));
  expect(resized.length).toBeLessThanOrEqual(13);
  expect(resized.every((line) => Bun.stringWidth(line) <= 20)).toBe(true);
  expect(resized[1]).toContain("Fourth");
  expect(resized[2]).toContain("milestone");

  component.handleInput("\u001b[H");
  expect(plain(component.render(20)).join("\n")).toContain("GOAL");
  panel.timers[0]?.callback();
  const afterAgeTick = plain(component.render(20));
  expect(afterAgeTick.join("\n")).toContain("GOAL");

  component.handleInput("q");
  await panel.completion;
});

test("renders age boundaries and compact height safely", async () => {
  const originalNow = Date.now;
  let now = 10 * 86_400_000;
  Date.now = () => now;
  try {
    const source = new MutableSource(mixedSnapshot());
    source.snapshot.updatedAt = now;
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

test("cleans partial setup and omits age before a valid digest", async () => {
  let unsubscriptions = 0;
  const snapshot = mixedSnapshot();
  snapshot.updatedAt = undefined;
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
  await expect(showProgressionOverlay(context, source)).rejects.toThrow("subscription failed");
  expect(rendered).toBe("");
  expect(unsubscriptions).toBe(0);

  const healthy = new MutableSource(snapshot);
  const panel = openPanel(healthy);
  expect(Bun.stripANSI(panel.component().render(80)[0] ?? "")).not.toContain("Updated");
  panel.component().handleInput("q");
  await panel.completion;
});
