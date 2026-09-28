import { beforeAll, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, initTheme, theme } from "@oh-my-pi/pi-tui";

import eagleViewExtension from "../src/index";
import { EagleViewConfigurationError, generateNarration, type NarrationResult } from "../src/narration";
import { renderWidgetLines, showEagleViewWidget } from "../src/widget";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface CapturedOverlay {
  component: Component & { handleInput?(data: string): void; dispose?(): void };
  close(): void;
}

beforeAll(async () => {
  await initTheme(false);
});

function createContext(
  widgetCalls: Array<{ content: unknown; placement?: string }> = [],
  sessionId = "session-1",
  mode: "tui" | "rpc" = "tui",
) {
  let clearedTimerCount = 0;
  let renderRequests = 0;
  let resolveWidgetUpdate: (() => void) | undefined;
  let widgetUpdate = new Promise<void>((resolve) => {
    resolveWidgetUpdate = resolve;
  });
  const timeouts: Array<{ callback: () => unknown; ms: number; cleared: boolean }> = [];
  const intervals: Array<() => unknown> = [];
  const customCalls: CapturedOverlay[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const contextShape = {
    hasUI: true,
    mode,
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      setWidget: (_key: string, content: unknown, options?: { placement?: string }) => {
        widgetCalls.push({ content, placement: options?.placement });
        resolveWidgetUpdate?.();
        widgetUpdate = new Promise<void>((resolve) => {
          resolveWidgetUpdate = resolve;
        });
      },
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      custom: async (factory: Function, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(options.signal.reason ?? new DOMException("Dialog aborted", "AbortError"));
            return;
          }
          let settled = false;
          let overlay: CapturedOverlay | undefined;
          let onAbort = () => {};
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            options?.signal?.removeEventListener("abort", onAbort);
            overlay?.component.dispose?.();
            if (error) reject(error);
            else resolve();
          };
          onAbort = () => finish(options?.signal?.reason ?? new DOMException("Dialog aborted", "AbortError"));
          const component = factory(
            { terminal: { rows: 40 }, requestRender: () => (renderRequests += 1) },
            theme,
            {},
            () => finish(),
          );
          overlay = { component, close: () => finish() };
          customCalls.push(overlay);
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          if (options?.signal?.aborted) onAbort();
        }),
    },
    setInterval: (callback: () => unknown) => {
      intervals.push(callback);
      return callback;
    },
    setTimeout: (callback: () => unknown, ms: number) => {
      const timer = { callback, ms, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimer: (timer: unknown) => {
      clearedTimerCount += 1;
      if (timer && typeof timer === "object" && "cleared" in timer) timer.cleared = true;
    },
  };
  // The extension context is intentionally broad; this harness implements only the lifecycle surface under test.
  const context = contextShape as unknown as ExtensionContext;
  return {
    context,
    intervalCount: () => intervals.length,
    clearedTimerCount: () => clearedTimerCount,
    widgetCalls,
    intervals,
    timeouts,
    customCalls,
    notifications,
    renderRequests: () => renderRequests,
    waitForWidgetUpdate: () => widgetUpdate,
  };
}

function createExtensionHarness(
  warnings: string[] = [],
  narrate: typeof generateNarration = generateNarration,
) {
  const handlers = new Map<string, EventHandler>();
  const extensionShape = {
    logger: { warn: (message: string) => warnings.push(message) },
    setLabel: () => {},
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown },
    ) => handlers.set(`command:${name}`, (args, ctx) => command.handler(String(args), ctx)),
  };
  // The production API has many unrelated methods; this harness supplies every member Eagle View uses during registration.
  const extensionApi = extensionShape as unknown as ExtensionAPI;
  eagleViewExtension(extensionApi, narrate);
  return handlers;
}

function renderCapturedWidget(call: { content: unknown }, width = 60): string {
  if (typeof call.content !== "function") throw new Error("expected a widget factory");
  const component = call.content({ terminal: { rows: 40 } }, theme);
  if (!component || typeof component !== "object" || !("render" in component) || typeof component.render !== "function") {
    throw new Error("widget factory did not return a component");
  }
  return Bun.stripANSI(component.render(width).join("\n"));
}

test("session shutdown invalidates configuration loading before timers start", async () => {
  const handlers = createExtensionHarness();

  const sessionStart = handlers.get("session_start");
  const sessionShutdown = handlers.get("session_shutdown");
  expect(sessionStart).toBeDefined();
  expect(sessionShutdown).toBeDefined();
  const sharedWidgetCalls: Array<{ content: unknown; placement?: string }> = [];
  const harness = createContext(sharedWidgetCalls, "session-1");
  const shutdownContext = createContext(sharedWidgetCalls, "session-1");
  const initialization = sessionStart?.({ type: "session_start" }, harness.context);
  sessionShutdown?.({ type: "session_shutdown" }, shutdownContext.context);
  await initialization;

  expect(harness.intervalCount()).toBe(0);
  expect(harness.widgetCalls.at(-1)).toEqual({ content: undefined, placement: "aboveEditor" });
});

test("refreshes the widget after the final agent turn settles", async () => {
  const widgetCalls: Array<{ content: unknown; placement?: string }> = [];
  const narrations: string[] = [];
  const narrate = (async (...args: Parameters<typeof generateNarration>) => {
    narrations.push(args[1]);
    return { narration: `Final update ${narrations.length}` };
  }) as typeof generateNarration;
  const handlers = createExtensionHarness([], narrate);
  const harness = createContext(widgetCalls);

  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "First activity" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "assistant", text: "Second activity" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Third activity" }, harness.context);

  if (harness.intervalCount() === 0) {
    await handlers.get("command:eagle-view")?.("toggle", harness.context);
  }

  await handlers.get("agent_end")?.({ type: "agent_end", messages: [], willContinue: true }, harness.context);
  expect(narrations).toHaveLength(0);

  await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, harness.context);
  expect(narrations).toHaveLength(1);
  const firstWidget = widgetCalls.at(-1);
  expect(firstWidget?.placement).toBe("aboveEditor");
  expect(typeof firstWidget?.content).toBe("function");

  handlers.get("input")?.({ type: "input", source: "user", text: "Last activity" }, harness.context);
  await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, harness.context);
  expect(narrations).toHaveLength(2);
  expect(widgetCalls.at(-1)?.content).not.toBe(firstWidget?.content);

});

test("agent end returns while its narration is still pending", async () => {
  const widgetCalls: Array<{ content: unknown; placement?: string }> = [];
  let resolveNarration: ((result: NarrationResult) => void) | undefined;
  const pendingNarration = new Promise<NarrationResult>((resolve) => {
    resolveNarration = resolve;
  });
  const narrate = (async () => pendingNarration) as typeof generateNarration;
  const handlers = createExtensionHarness([], narrate);
  const harness = createContext(widgetCalls);
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  if (harness.intervalCount() === 0) await handlers.get("command:eagle-view")?.("toggle", harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Pending final activity" }, harness.context);

  const handlerResult = handlers.get("agent_end")?.(
    { type: "agent_end", messages: [] },
    harness.context,
  );
  expect(handlerResult).toBeUndefined();

  const widgetUpdate = harness.waitForWidgetUpdate();
  resolveNarration?.({ narration: "The final update arrived in the background." });
  await widgetUpdate;
  expect(renderCapturedWidget(widgetCalls.at(-1) ?? { content: undefined })).toContain(
    "The final update arrived in the background.",
  );
});

test("keeps the current widget until inactivity clears the last message", async () => {
  const handlers = createExtensionHarness();
  const widgetCalls: Array<{ content: unknown; placement?: string }> = [];
  const harness = createContext(widgetCalls);
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  showEagleViewWidget(harness.context, "The current work is still being checked.", "🦅");
  const currentWidget = widgetCalls.at(-1);

  const input = handlers.get("input");
  expect(input).toBeDefined();
  input?.({ type: "input", source: "user", text: "First activity" }, harness.context);
  expect(harness.timeouts.filter((timer) => timer.ms === 1_000)).toHaveLength(0);
  input?.({ type: "input", source: "user", text: "Second activity" }, harness.context);
  expect(harness.timeouts.filter((timer) => timer.ms === 1_000)).toHaveLength(0);
  const callsBeforeThreshold = widgetCalls.length;
  await harness.intervals[0]?.();
  expect(widgetCalls).toHaveLength(callsBeforeThreshold);
  input?.({ type: "input", source: "user", text: "Third activity" }, harness.context);

  const idleTimers = harness.timeouts.filter((timer) => timer.ms === 60_000);
  expect(idleTimers).toHaveLength(3);
  expect(harness.clearedTimerCount()).toBe(2);
  await harness.timeouts.find((timer) => timer.ms === 1_000)?.callback();
  expect(widgetCalls.at(-1)).toBe(currentWidget);
  idleTimers.at(-1)?.callback();
  expect(widgetCalls.at(-1)).toEqual({ content: undefined, placement: "aboveEditor" });
  input?.({ type: "input", source: "user", text: "Work resumed" }, harness.context);
  expect(harness.timeouts.filter((timer) => timer.ms === 1_000)).toHaveLength(2);
});

test("does not retry a failed update until new activity arrives", async () => {
  const warnings: string[] = [];
  const handlers = createExtensionHarness(warnings);
  const harness = createContext();
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);

  handlers.get("input")?.({ type: "input", source: "user", text: "First activity" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "assistant", text: "Second activity" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Third activity" }, harness.context);
  await harness.timeouts.find((timer) => timer.ms === 1_000)?.callback();
  expect(warnings).toHaveLength(1);

  await harness.intervals[0]?.();
  expect(warnings).toHaveLength(1);

  handlers.get("input")?.({ type: "input", source: "user", text: "New activity" }, harness.context);
  await harness.timeouts.filter((timer) => timer.ms === 1_000).at(-1)?.callback();
  expect(warnings).toHaveLength(2);
});

test("reports manual refresh failures in the UI", async () => {
  const narrate = (async () => {
    throw new Error("No session model is available");
  }) as typeof generateNarration;
  const handlers = createExtensionHarness([], narrate);
  const harness = createContext();
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Summarize this work" }, harness.context);

  await handlers.get("command:eagle-view")?.("refresh", harness.context);

  expect(harness.notifications).toContainEqual({
    message: "Eagle View refresh failed: No session model is available",
    level: "error",
  });
});

test("queues new activity during an update without clearing the current widget", async () => {
  const warnings: string[] = [];
  const handlers = createExtensionHarness(warnings);
  const widgetCalls: Array<{ content: unknown; placement?: string }> = [];
  const harness = createContext(widgetCalls);
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  showEagleViewWidget(harness.context, "The earlier explanation remains visible.", "🦅");
  const currentWidget = widgetCalls.at(-1);

  handlers.get("input")?.({ type: "input", source: "user", text: "First activity" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "assistant", text: "Second activity" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Third activity" }, harness.context);
  const firstAttempt = harness.timeouts.find((timer) => timer.ms === 1_000)?.callback();
  handlers.get("input")?.({ type: "input", source: "user", text: "Activity during generation" }, harness.context);

  await firstAttempt;
  expect(warnings).toHaveLength(2);
  expect(widgetCalls.at(-1)).toBe(currentWidget);
});

test("aligns wrapped text after the icon and leaves an empty line below", () => {
  const lines = renderWidgetLines(
    "Authentication works locally; provider verification remains before deployment and release.",
    24,
    "🦅",
  );

  expect(lines).toHaveLength(3);
  expect(lines[0]?.startsWith(" 🦅 Authentication")).toBe(true);
  expect(lines[1]?.startsWith("    ")).toBe(true);
  expect(lines[1]?.startsWith("     ")).toBe(false);
  expect(lines[1]?.endsWith("…")).toBe(true);
  expect(lines[2]).toBe("");
  expect(lines.every((line) => !line.includes("\n"))).toBe(true);
});

test("drops an oversized icon prefix so narrow terminals still show narration", () => {
  const lines = renderWidgetLines("Authentication remains under review.", 4, "🦅");

  expect(lines[0]).not.toContain("🦅");
  expect(lines[0]?.trim()).not.toBe("");
  expect(lines[1]?.endsWith("…")).toBe(true);
  expect(lines.slice(0, 2).every((line) => Bun.stringWidth(line) <= 4)).toBe(true);
});

test("re-enabling Eagle View rearms idle clearing and narration", async () => {
  const handlers = createExtensionHarness();
  const harness = createContext();
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "First buffered activity" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "assistant", text: "Second buffered activity" }, harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Third buffered activity" }, harness.context);
  await harness.timeouts.find((timer) => timer.ms === 1_000)?.callback();

  const toggle = handlers.get("command:eagle-view");
  expect(toggle).toBeDefined();
  await toggle?.("toggle", harness.context);
  const initialUpdateCount = harness.timeouts.filter((timer) => timer.ms === 1_000).length;
  await toggle?.("toggle", harness.context);

  expect(harness.timeouts.filter((timer) => timer.ms === 60_000)).toHaveLength(4);
  expect(harness.timeouts.filter((timer) => timer.ms === 1_000)).toHaveLength(initialUpdateCount + 1);
});

test("inspection records accepted messages, groups consecutive repeats, and retains history locally", async () => {
  const widgetCalls: Array<{ content: unknown; placement?: string }> = [];
  const narrations = [
    "Same explanation",
    "Same explanation",
    "Different explanation",
    "Same explanation",
  ];
  let narrationCalls = 0;
  const narrate = (async () => ({ narration: narrations[narrationCalls++] ?? "Unexpected explanation" })) as typeof generateNarration;
  const handlers = createExtensionHarness([], narrate);
  const harness = createContext(widgetCalls);
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  if (harness.intervalCount() === 0) await handlers.get("command:eagle-view")?.("toggle", harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Inspect this work" }, harness.context);
  await handlers.get("command:eagle-view")?.("refresh", harness.context);
  expect(renderCapturedWidget(widgetCalls.at(-1) ?? { content: undefined })).toContain("Same explanation");

  const inspection = handlers.get("command:eagle-view")?.("inspect", harness.context);
  expect(harness.customCalls).toHaveLength(1);
  expect(widgetCalls.at(-1)).toEqual({ content: undefined, placement: "aboveEditor" });
  expect(narrationCalls).toBe(1);
  await handlers.get("command:eagle-view")?.("inspect", harness.context);
  expect(harness.customCalls).toHaveLength(1);

  const overlay = harness.customCalls[0];
  expect(overlay).toBeDefined();
  const initialInspection = Bun.stripANSI(overlay?.component.render(80).join("\n") ?? "");
  expect(initialInspection).toContain("Same explanation");
  expect(initialInspection).not.toContain("GOAL");
  expect(initialInspection).not.toContain("tasks");

  await handlers.get("command:eagle-view")?.("refresh", harness.context);
  const grouped = Bun.stripANSI(overlay?.component.render(80).join("\n") ?? "");
  expect(grouped).toContain("2 updates");
  expect(grouped.split("Same explanation")).toHaveLength(2);

  await handlers.get("command:eagle-view")?.("refresh", harness.context);
  await handlers.get("command:eagle-view")?.("refresh", harness.context);
  const aThenBThenA = Bun.stripANSI(overlay?.component.render(80).join("\n") ?? "");
  expect(aThenBThenA.split("Same explanation")).toHaveLength(3);
  expect(aThenBThenA).toContain("Different explanation");
  expect(widgetCalls.at(-1)).toEqual({ content: undefined, placement: "aboveEditor" });

  overlay?.component.handleInput?.("q");
  await inspection;
  expect(renderCapturedWidget(widgetCalls.at(-1) ?? { content: undefined })).toContain("Same explanation");

  const idle = harness.timeouts.filter((timer) => timer.ms === 60_000 && !timer.cleared).at(-1);
  idle?.callback();
  expect(widgetCalls.at(-1)).toEqual({ content: undefined, placement: "aboveEditor" });
  const afterIdle = handlers.get("command:eagle-view")?.("inspect", harness.context);
  expect(Bun.stripANSI(harness.customCalls.at(-1)?.component.render(80).join("\n") ?? "")).toContain(
    "Different explanation",
  );
  harness.customCalls.at(-1)?.component.handleInput?.("q");
  await afterIdle;

  await handlers.get("command:eagle-view")?.("toggle", harness.context);
  await handlers.get("command:eagle-view")?.("toggle", harness.context);
  const afterToggle = handlers.get("command:eagle-view")?.("inspect", harness.context);
  expect(Bun.stripANSI(harness.customCalls.at(-1)?.component.render(80).join("\n") ?? "")).toContain(
    "Different explanation",
  );
  harness.customCalls.at(-1)?.component.handleInput?.("q");
  await afterToggle;
});

test("failed narration leaves an open inspection history unchanged", async () => {
  const warnings: string[] = [];
  let rejectNarration: ((reason?: unknown) => void) | undefined;
  const narrate = (async () =>
    new Promise<NarrationResult>((_resolve, reject) => {
      rejectNarration = reject;
    })) as typeof generateNarration;
  const handlers = createExtensionHarness(warnings, narrate);
  const harness = createContext();
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  if (harness.intervalCount() === 0) await handlers.get("command:eagle-view")?.("toggle", harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Inspect pending work" }, harness.context);

  const refresh = handlers.get("command:eagle-view")?.("refresh", harness.context);
  const inspection = handlers.get("command:eagle-view")?.("inspect", harness.context);
  const overlay = harness.customCalls[0];
  expect(Bun.stripANSI(overlay?.component.render(80).join("\n") ?? "")).toContain("No updates yet.");
  const requestsBeforeFailure = harness.renderRequests();

  rejectNarration?.(new Error("generation failed"));
  await refresh;
  expect(harness.renderRequests()).toBeGreaterThan(requestsBeforeFailure);
  const failed = Bun.stripANSI(overlay?.component.render(80).join("\n") ?? "");
  expect(failed).toContain("No updates yet.");
  expect(failed).not.toContain("generation failed");
  expect(warnings).toHaveLength(1);

  overlay?.component.handleInput?.("q");
  await inspection;
});

test("idle expiry and lifecycle transitions never resurrect a hidden widget", async () => {
  const widgetCalls: Array<{ content: unknown; placement?: string }> = [];
  const narrate = (async () => ({ narration: "Eligible before inspection" })) as typeof generateNarration;
  const handlers = createExtensionHarness([], narrate);
  const harness = createContext(widgetCalls);
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  if (harness.intervalCount() === 0) await handlers.get("command:eagle-view")?.("toggle", harness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Work" }, harness.context);
  await handlers.get("command:eagle-view")?.("refresh", harness.context);
  const inspection = handlers.get("command:eagle-view")?.("inspect", harness.context);
  const idle = harness.timeouts.filter((timer) => timer.ms === 60_000 && !timer.cleared).at(-1);
  idle?.callback();
  harness.customCalls[0]?.component.handleInput?.("q");
  await inspection;
  expect(widgetCalls.at(-1)).toEqual({ content: undefined, placement: "aboveEditor" });

  handlers.get("input")?.({ type: "input", source: "user", text: "More work" }, harness.context);
  await handlers.get("command:eagle-view")?.("refresh", harness.context);
  const disabledInspection = handlers.get("command:eagle-view")?.("inspect", harness.context);
  await handlers.get("command:eagle-view")?.("toggle", harness.context);
  await disabledInspection;
  expect(widgetCalls.at(-1)).toEqual({ content: undefined, placement: "aboveEditor" });
});

test("session replacement clears the in-memory message history for the new owner", async () => {
  const handlers = createExtensionHarness([], (async () => ({ narration: "Session narration" })) as typeof generateNarration);
  const oldHarness = createContext([], "session-old");
  await handlers.get("session_start")?.({ type: "session_start" }, oldHarness.context);
  if (oldHarness.intervalCount() === 0) await handlers.get("command:eagle-view")?.("toggle", oldHarness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Old session work" }, oldHarness.context);
  await handlers.get("command:eagle-view")?.("refresh", oldHarness.context);
  const oldInspection = handlers.get("command:eagle-view")?.("inspect", oldHarness.context);
  expect(Bun.stripANSI(oldHarness.customCalls[0]?.component.render(80).join("\n") ?? "")).toContain("Session narration");

  const newHarness = createContext([], "session-new");
  await handlers.get("session_switch")?.({ type: "session_switch" }, newHarness.context);
  await oldInspection;
  const newInspection = handlers.get("command:eagle-view")?.("inspect", newHarness.context);
  expect(newHarness.customCalls).toHaveLength(1);
  expect(Bun.stripANSI(newHarness.customCalls[0]?.component.render(80).join("\n") ?? "")).toContain("No updates yet.");
  await handlers.get("command:eagle-view")?.("inspect", newHarness.context);
  expect(newHarness.customCalls).toHaveLength(1);
  newHarness.customCalls[0]?.component.handleInput?.("q");
  await newInspection;
});

test("late narration from a replaced session cannot enter the new history", async () => {
  let resolveNarration: ((result: NarrationResult) => void) | undefined;
  const narrate = (async () =>
    new Promise<NarrationResult>((resolve) => {
      resolveNarration = resolve;
    })) as typeof generateNarration;
  const handlers = createExtensionHarness([], narrate);
  const oldHarness = createContext([], "session-old");
  await handlers.get("session_start")?.({ type: "session_start" }, oldHarness.context);
  if (oldHarness.intervalCount() === 0) await handlers.get("command:eagle-view")?.("toggle", oldHarness.context);
  handlers.get("input")?.({ type: "input", source: "user", text: "Old session work" }, oldHarness.context);
  const staleRefresh = handlers.get("command:eagle-view")?.("refresh", oldHarness.context);

  const newHarness = createContext([], "session-new");
  await handlers.get("session_switch")?.({ type: "session_switch" }, newHarness.context);
  resolveNarration?.({ narration: "Late old-session narration" });
  await staleRefresh;

  const inspection = handlers.get("command:eagle-view")?.("inspect", newHarness.context);
  const rendered = Bun.stripANSI(newHarness.customCalls[0]?.component.render(80).join("\n") ?? "");
  expect(rendered).toContain("No updates yet.");
  expect(rendered).not.toContain("Late old-session narration");
  newHarness.customCalls[0]?.component.handleInput?.("q");
  await inspection;
});

test("unsupported inspection warns without hiding the widget or narrating", async () => {
  const widgetCalls: Array<{ content: unknown; placement?: string }> = [];
  let narrationCalls = 0;
  const handlers = createExtensionHarness([], (async () => {
    narrationCalls += 1;
    return { narration: "Unused" };
  }) as typeof generateNarration);
  const harness = createContext(widgetCalls, "session-1", "rpc");
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  const callsBefore = widgetCalls.length;
  await handlers.get("command:eagle-view")?.("inspect", harness.context);
  expect(harness.customCalls).toHaveLength(0);
  expect(widgetCalls).toHaveLength(callsBefore);
  expect(narrationCalls).toBe(0);
  expect(harness.notifications.at(-1)?.message).toBe("Eagle View inspection requires the interactive TUI");
});

async function startWithActivity(narrate: typeof generateNarration) {
  const widgetCalls: Array<{ content: unknown; placement?: string }> = [];
  const handlers = createExtensionHarness([], narrate);
  const harness = createContext(widgetCalls);
  await handlers.get("session_start")?.({ type: "session_start" }, harness.context);
  let inputs = 0;
  const act = () =>
    handlers.get("input")?.({ type: "input", source: "user", text: `Activity ${++inputs}` }, harness.context);
  const turn = async () => {
    act();
    await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, harness.context);
  };
  const shown = () => renderCapturedWidget(widgetCalls.at(-1) ?? { content: undefined }, 200);
  return { handlers, harness, widgetCalls, act, turn, shown };
}

test("pauses automatic updates after a configuration error until refresh", async () => {
  let calls = 0;
  const narrate = (async () => {
    calls += 1;
    throw new EagleViewConfigurationError("Eagle View model 'nope/missing' is not available");
  }) as typeof generateNarration;
  const { handlers, harness, act, turn, shown } = await startWithActivity(narrate);

  await turn();
  expect(calls).toBe(1);
  expect(shown()).toContain("Eagle View paused: Eagle View model 'nope/missing' is not available");

  await turn();
  act();
  await harness.intervals[0]?.();
  await harness.timeouts.filter((timer) => timer.ms === 1_000).at(-1)?.callback();
  expect(calls).toBe(1);

  await handlers.get("command:eagle-view")?.("refresh", harness.context);
  expect(calls).toBe(2);
});

test("shows transient failures only after three in a row and recovers on success", async () => {
  const outcomes = ["ok:Good progress on the main feature.", "fail", "fail", "fail", "ok:Recovered and moving forward again.", "fail"];
  const narrate = (async () => {
    const outcome = outcomes.shift() ?? "fail";
    if (outcome === "fail") throw new Error("503 service overloaded");
    return { narration: outcome.slice(3) };
  }) as typeof generateNarration;
  const { turn, shown } = await startWithActivity(narrate);

  await turn();
  await turn();
  await turn();
  expect(shown()).toContain("Good progress on the main feature.");
  await turn();
  expect(shown()).toContain("Eagle View can't reach the model: 503 service overloaded");
  await turn();
  expect(shown()).toContain("Recovered and moving forward again.");
  await turn();
  expect(shown()).toContain("Recovered and moving forward again.");
});

test("keeps the failure line through inactivity and bounds it to one short line", async () => {
  const narrate = (async () => {
    throw new Error(`404 {"type":"error","error":{"type":"not_found_error","message":"model: ${"x".repeat(400)}"}}\nstack`);
  }) as typeof generateNarration;
  const { harness, turn, shown, widgetCalls } = await startWithActivity(narrate);

  await turn();
  const lines = shown().split("\n").filter((line) => line.trim());
  expect(lines).toHaveLength(1);
  expect(Bun.stringWidth(lines[0]?.trim() ?? "")).toBeLessThanOrEqual(121);
  expect(lines[0]).toContain("Eagle View paused: 404");
  expect(lines[0]).toContain("— /eagle-view refresh to retry");

  harness.timeouts.filter((timer) => timer.ms === 60_000).at(-1)?.callback();
  expect(widgetCalls.at(-1)?.content).toBeDefined();
  expect(shown()).toContain("Eagle View paused");
});

test("feeds the previous summary back and never forwards todo input", async () => {
  const requests: Array<{ activity: string; summary: string | undefined }> = [];
  const narrate = (async (...args: Parameters<typeof generateNarration>) => {
    requests.push({ activity: args[1], summary: args[2] });
    return { narration: "Steady progress on the work.", summary: `Summary ${requests.length}` };
  }) as typeof generateNarration;
  const { handlers, harness, turn } = await startWithActivity(narrate);

  handlers.get("tool_call")?.(
    { type: "tool_call", toolName: "todo", toolCallId: "t1", input: { op: "init", list: [{ phase: "P", items: ["Secret task label"] }] } },
    harness.context,
  );
  handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolName: "todo", toolCallId: "t1" }, harness.context);
  handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolName: "todo", toolCallId: "t1", isError: false }, harness.context);
  await turn();
  await turn();

  expect(requests[0]?.summary).toBeUndefined();
  expect(requests[1]?.summary).toBe("Summary 1");
  expect(JSON.stringify(requests)).not.toContain("Secret task label");
});

test("a manual refresh ends the pause even when the retry fails transiently", async () => {
  const outcomes: Array<"config" | "transient" | "ok"> = ["config", "transient", "ok"];
  let calls = 0;
  const narrate = (async () => {
    calls += 1;
    const outcome = outcomes.shift() ?? "ok";
    if (outcome === "config") throw new EagleViewConfigurationError("No credential is available for x/y");
    if (outcome === "transient") throw new Error("503 service overloaded");
    return { narration: "Work resumed after the credential was fixed." };
  }) as typeof generateNarration;
  const { handlers, harness, turn, shown } = await startWithActivity(narrate);

  await turn();
  await handlers.get("command:eagle-view")?.("refresh", harness.context);
  expect(calls).toBe(2);

  await turn();
  expect(calls).toBe(3);
  expect(shown()).toContain("Work resumed after the credential was fixed.");
});
