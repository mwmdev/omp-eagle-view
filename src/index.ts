import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { ActivityBuffer, assistantText, cleanActivityText, describeToolEnd, describeToolStart } from "./activity";
import { DEFAULT_CONFIG, loadEagleViewConfig, type EagleViewConfig } from "./config";
import { generateNarration, isConfigurationError } from "./narration";
import {
  showMessageHistoryOverlay,
  type EagleViewInspectionSource,
  type EagleViewMessage,
} from "./inspect";
import { clearEagleViewWidget, showEagleViewWidget } from "./widget";

const INITIAL_UPDATE_DELAY_MS = 1_000;
const IDLE_WIDGET_TIMEOUT_MS = 60_000;
const TRANSIENT_FAILURE_THRESHOLD = 3;
const MAX_FAILURE_LINE_CHARACTERS = 120;
const FAILURE_ICON = "⚠";

export function formatFailureLine(message: string, paused: boolean): string {
  const prefix = paused ? "Eagle View paused: " : "Eagle View can't reach the model: ";
  const suffix = paused ? " — /eagle-view refresh to retry" : "";
  // The widget prefixes the icon and a space; only the reason is truncated so the retry hint always survives.
  const budget = MAX_FAILURE_LINE_CHARACTERS - FAILURE_ICON.length - 1 - prefix.length - suffix.length;
  const reason = cleanActivityText(message.split("\n", 1)[0] ?? "", budget);
  return `${prefix}${reason}${suffix}`;
}

type ManagedTimer = Timer;

interface RuntimeState {
  ctx?: ExtensionContext;
  config: EagleViewConfig;
  activity: ActivityBuffer;
  summary?: string;
  enabled: boolean;
  interval?: ManagedTimer;
  initialUpdate?: ManagedTimer;
  idleClear?: ManagedTimer;
  generation?: Promise<void>;
  abortController?: AbortController;
  attemptedVersion: number;
  narration?: string;
  failureLine?: string;
  consecutiveFailures: number;
  paused: boolean;
  idle: boolean;
  refreshQueued: boolean;
  refreshFailureNotificationQueued: boolean;
  disposed: boolean;
  sessionGeneration: number;
  sessionId?: string;
  messageHistory: EagleViewMessage[];
  nextMessageId: number;
  inspection?: { controller: AbortController; onChange?: () => void };
}

export default function eagleViewExtension(
  pi: ExtensionAPI,
  narrate: typeof generateNarration = generateNarration,
): void {
  const state: RuntimeState = {
    config: { ...DEFAULT_CONFIG },
    activity: new ActivityBuffer(),
    consecutiveFailures: 0,
    paused: false,
    enabled: DEFAULT_CONFIG.enabled,
    attemptedVersion: 0,
    messageHistory: [],
    nextMessageId: 0,
    idle: true,
    refreshQueued: false,
    refreshFailureNotificationQueued: false,
    disposed: false,
    sessionGeneration: 0,
  };

  const warn = (message: string, details?: Record<string, unknown>) => pi.logger.warn(message, details);

  const stopScheduling = (): void => {
    if (!state.ctx) return;
    if (state.interval) state.ctx.clearTimer(state.interval);
    if (state.initialUpdate) state.ctx.clearTimer(state.initialUpdate);
    if (state.idleClear) state.ctx.clearTimer(state.idleClear);
    state.interval = undefined;
    state.initialUpdate = undefined;
    state.idleClear = undefined;
  };

  const resetFailures = (): void => {
    state.failureLine = undefined;
    state.consecutiveFailures = 0;
    state.paused = false;
  };

  const updateNarration = async (force: boolean, reportFailure = false): Promise<void> => {
    if (!state.ctx || !state.enabled || state.disposed || state.activity.empty) return;
    // Only an explicit refresh may retry after a configuration error.
    if (state.paused && !reportFailure) return;
    if (
      !force &&
      (state.idle ||
        state.activity.version < state.config.initialEventCount ||
        state.activity.version === state.attemptedVersion)
    ) {
      return;
    }

    if (state.generation) {
      if (force) {
        state.refreshQueued = true;
        if (reportFailure) state.refreshFailureNotificationQueued = true;
      }
      return state.generation;
    }

    // An explicit retry ends the pause; a new configuration error re-establishes it.
    if (reportFailure) state.paused = false;
    const ctx = state.ctx;
    const generation = state.sessionGeneration;
    const version = state.activity.version;
    const snapshot = state.activity.snapshot();
    const summary = state.summary;
    const controller = new AbortController();
    state.abortController = controller;
    state.attemptedVersion = version;

    const request = (async () => {
      try {
        const result = await narrate(
          ctx,
          snapshot,
          summary,
          state.config.prompt,
          state.config.model,
          controller.signal,
        );
        if (
          !state.enabled ||
          state.disposed ||
          controller.signal.aborted ||
          (!force && state.idle) ||
          state.sessionGeneration !== generation
        ) {
          return;
        }
        const acceptedAt = Date.now();
        const latestMessage = state.messageHistory[0];
        if (latestMessage?.text === result.narration) {
          latestMessage.latestAt = acceptedAt;
          latestMessage.count += 1;
        } else {
          state.messageHistory.unshift({
            id: ++state.nextMessageId,
            text: result.narration,
            firstAt: acceptedAt,
            latestAt: acceptedAt,
            count: 1,
          });
        }
        if (result.summary) state.summary = result.summary;
        resetFailures();
        state.narration = result.narration;
        if (!state.inspection) showEagleViewWidget(ctx, result.narration, state.config.icon);
        armIdleWidgetClear();
        state.inspection?.onChange?.();
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          warn("eagle-view: generation failed", { error: message });
          if (state.enabled && !state.disposed && state.sessionGeneration === generation) {
            const configuration = isConfigurationError(error);
            state.consecutiveFailures += 1;
            if (configuration) state.paused = true;
            if (configuration || state.consecutiveFailures >= TRANSIENT_FAILURE_THRESHOLD) {
              state.failureLine = formatFailureLine(message, configuration);
              if (!state.inspection) showEagleViewWidget(ctx, state.failureLine, FAILURE_ICON);
            }
          }
          if (
            reportFailure &&
            state.enabled &&
            !state.disposed &&
            state.sessionGeneration === generation
          ) {
            ctx.ui.notify(`Eagle View refresh failed: ${message}`, "error");
          }
        }
      } finally {
        if (state.abortController === controller) state.abortController = undefined;
        state.generation = undefined;
        state.inspection?.onChange?.();
        if (state.refreshQueued && state.enabled && !state.disposed) {
          const notifyOnFailure = state.refreshFailureNotificationQueued;
          state.refreshQueued = false;
          state.refreshFailureNotificationQueued = false;
          void updateNarration(true, notifyOnFailure);
        }
      }
    })();

    state.generation = request;
    state.inspection?.onChange?.();
    return request;
  };

  const scheduleInitialUpdate = (): void => {
    if (
      !state.ctx ||
      !state.enabled ||
      state.activity.version < state.config.initialEventCount ||
      state.narration ||
      state.initialUpdate ||
      state.disposed ||
      state.idle
    ) {
      return;
    }

    state.initialUpdate = state.ctx.setTimeout(() => {
      state.initialUpdate = undefined;
      return updateNarration(false);
    }, INITIAL_UPDATE_DELAY_MS);
    state.inspection?.onChange?.();
  };

  const armIdleWidgetClear = (): void => {
    if (!state.ctx || !state.enabled || state.disposed) return;
    if (state.idleClear) state.ctx.clearTimer(state.idleClear);
    const ctx = state.ctx;
    const sessionGeneration = state.sessionGeneration;
    state.idle = false;
    state.idleClear = ctx.setTimeout(() => {
      if (state.disposed || state.sessionGeneration !== sessionGeneration) return;
      state.idleClear = undefined;
      state.idle = true;
      state.refreshQueued = false;
      state.refreshFailureNotificationQueued = false;
      state.abortController?.abort();
      // A failure line stays until success, refresh, or toggle so a broken setup is never hidden.
      if (!state.failureLine) clearEagleViewWidget(ctx);
      state.narration = undefined;
    }, IDLE_WIDGET_TIMEOUT_MS);
  };

  const noteActivity = (kind: Parameters<ActivityBuffer["add"]>[0], text: string): void => {
    const changed = state.activity.add(kind, text);
    armIdleWidgetClear();
    if (!changed) return;
    if (state.generation) state.refreshQueued = true;
    else if (!state.narration) scheduleInitialUpdate();
  };

  const startScheduling = (): void => {
    if (!state.ctx || !state.enabled || state.disposed) return;
    if (state.interval) state.ctx.clearTimer(state.interval);
    state.interval = state.ctx.setInterval(
      () => updateNarration(false),
      state.config.intervalMinutes * 60_000,
    );
    scheduleInitialUpdate();
  };

  const initializeSession = async (ctx: ExtensionContext): Promise<void> => {
    const generation = state.sessionGeneration + 1;
    const sessionId = ctx.sessionManager.getSessionId();
    state.sessionGeneration = generation;
    stopScheduling();
    state.abortController?.abort();
    const inspection = state.inspection;
    state.inspection = undefined;
    inspection?.controller.abort();
    if (state.ctx) clearEagleViewWidget(state.ctx);
    state.ctx = ctx;
    state.sessionId = sessionId;
    state.disposed = false;
    state.activity.clear();
    state.summary = undefined;
    resetFailures();
    state.attemptedVersion = 0;
    state.narration = undefined;
    state.messageHistory = [];
    state.nextMessageId = 0;
    state.idle = true;
    state.refreshQueued = false;
    state.refreshFailureNotificationQueued = false;
    const config = await loadEagleViewConfig(ctx.cwd, warn);
    if (state.disposed || state.sessionId !== sessionId || state.sessionGeneration !== generation) return;

    state.config = config;
    state.enabled = config.enabled;
    if (state.enabled) startScheduling();
  };

  pi.setLabel("Eagle View");

  pi.on("session_start", async (_event, ctx) => initializeSession(ctx));
  pi.on("session_switch", async (_event, ctx) => initializeSession(ctx));
  pi.on("session_branch", async (_event, ctx) => initializeSession(ctx));
  pi.on("session_tree", async (_event, ctx) => initializeSession(ctx));

  pi.on("input", (event) => {
    if (event.source === "extension" || event.text.trimStart().startsWith("/eagle-view")) return;
    noteActivity("user", event.text);
  });

  pi.on("message_end", (event) => {
    const text = assistantText(event.message);
    if (text) noteActivity("assistant", text);
  });

  pi.on("tool_execution_start", (event) => {
    const activity = describeToolStart(event.toolName, event.intent);
    noteActivity(activity.kind, activity.text);
  });

  pi.on("tool_execution_end", (event) => {
    const activity = describeToolEnd(event.toolName, event.isError);
    noteActivity(activity.kind, activity.text);
  });

  pi.on("agent_end", (event, ctx) => {
    if (
      event.willContinue ||
      state.sessionId !== ctx.sessionManager.getSessionId() ||
      !state.enabled ||
      state.disposed ||
      state.activity.empty
    ) {
      return;
    }

    state.ctx = ctx;
    if (state.initialUpdate) {
      ctx.clearTimer(state.initialUpdate);
      state.initialUpdate = undefined;
    }

    void updateNarration(true);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    state.sessionGeneration += 1;
    state.disposed = true;
    stopScheduling();
    state.abortController?.abort();
    const inspection = state.inspection;
    state.inspection = undefined;
    inspection?.controller.abort();
    clearEagleViewWidget(ctx);
    state.narration = undefined;
    state.refreshFailureNotificationQueued = false;
    state.idle = true;
  });

  pi.registerCommand("eagle-view", {
    description: "Toggle, refresh, or inspect Eagle View updates",
    getArgumentCompletions: (prefix) =>
      ["toggle", "refresh", "inspect"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const commandSessionId = ctx.sessionManager.getSessionId();
      if (state.sessionId !== commandSessionId) {
        ctx.ui.notify("Eagle View is not initialized for this session", "warning");
        return;
      }
      state.ctx = ctx;
      const action = args.trim().toLowerCase() || "toggle";

      if (action === "toggle") {
        state.enabled = !state.enabled;
        if (state.enabled) {
          state.disposed = false;
          if (!state.activity.empty) armIdleWidgetClear();
          startScheduling();
          ctx.ui.notify("Eagle View enabled", "info");
        } else {
          stopScheduling();
          state.abortController?.abort();
          const inspection = state.inspection;
          state.inspection = undefined;
          inspection?.controller.abort();
          clearEagleViewWidget(ctx);
          state.narration = undefined;
          state.attemptedVersion = 0;
          resetFailures();
          state.refreshFailureNotificationQueued = false;
          state.idle = true;
          ctx.ui.notify("Eagle View disabled", "info");
        }
        return;
      }

      if (action === "refresh") {
        if (!state.enabled) {
          ctx.ui.notify("Eagle View is disabled", "info");
          return;
        }
        if (state.activity.empty) {
          ctx.ui.notify("Eagle View has no activity to summarize yet", "info");
          return;
        }
        armIdleWidgetClear();
        await updateNarration(true, true);
        return;
      }

      if (action === "inspect") {
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify("Eagle View inspection requires the interactive TUI", "warning");
          return;
        }
        if (state.inspection) return;

        const sessionGeneration = state.sessionGeneration;
        const sessionId = state.sessionId;
        const openingContext = ctx;
        const owner: NonNullable<RuntimeState["inspection"]> = { controller: new AbortController() };
        state.inspection = owner;
        clearEagleViewWidget(ctx);
        const source: EagleViewInspectionSource = {
          getSnapshot: () => ({
            icon: state.config.icon,
            messages: state.messageHistory,
          }),
          subscribe: (onChange) => {
            if (state.inspection === owner) owner.onChange = onChange;
            return () => {
              if (state.inspection === owner && owner.onChange === onChange) owner.onChange = undefined;
            };
          },
        };
        try {
          await showMessageHistoryOverlay(ctx, source, owner.controller.signal);
        } catch (error) {
          if (!owner.controller.signal.aborted) {
            warn("eagle-view: inspection failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            ctx.ui.notify("Eagle View inspection could not be opened", "warning");
          }
        } finally {
          if (
            state.inspection === owner &&
            state.sessionGeneration === sessionGeneration &&
            state.sessionId === sessionId
          ) {
            state.inspection = undefined;
            if (state.enabled && !state.disposed && state.failureLine) {
              showEagleViewWidget(openingContext, state.failureLine, FAILURE_ICON);
            } else if (state.enabled && !state.disposed && !state.idle && state.narration) {
              showEagleViewWidget(openingContext, state.narration, state.config.icon);
            }
          }
        }
        return;
      }

      ctx.ui.notify("Usage: /eagle-view [toggle|refresh|inspect]", "warning");
    },
  });
}
