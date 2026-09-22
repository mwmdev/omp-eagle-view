import { cleanActivityText } from "./activity";

export type TrackedTaskStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TrackedTask {
  phase: string;
  label: string;
  status: TrackedTaskStatus;
  blocker?: string;
}

export interface ProgressionDigest {
  goal?: string;
  currentFocus?: string;
  earlierProgress?: string;
  completedMilestones: string[];
  decisions: string[];
  blockers: string[];
}

export interface EagleViewProgressionSnapshot {
  digest: ProgressionDigest;
  tasks: TrackedTask[];
  ompGoal?: string;
}

const MAX_TASKS = 24;
const MAX_LABEL_CHARACTERS = 160;
const MAX_PHASE_CHARACTERS = 80;
const MAX_DIGEST_ITEM_CHARACTERS = 240;
const MAX_GOAL_CHARACTERS = 360;
const MAX_EARLIER_PROGRESS_CHARACTERS = 600;
const MAX_MILESTONES = 6;
const MAX_DECISIONS = 6;
const MAX_BLOCKERS = 4;

const TODO_OPERATIONS = new Set(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"]);
const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "abandoned", "blocked"]);
interface TodoOperationInput {
  op: string;
  list?: Array<{ phase: string; items: string[] }>;
  task?: string;
  phase?: string;
  items?: string[];
  reason?: string;
}

function emptyDigest(): ProgressionDigest {
  return {
    completedMilestones: [],
    decisions: [],
    blockers: [],
  };
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = cleanActivityText(value, limit);
  return text || undefined;
}

function boundedStringArray(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const items: string[] = [];
  for (const candidate of value) {
    const item = boundedString(candidate, MAX_DIGEST_ITEM_CHARACTERS);
    if (!item) return undefined;
    if (!items.includes(item)) items.push(item);
    if (items.length === limit) break;
  }
  return items;
}

function isTrackedTaskStatus(value: unknown): value is TrackedTaskStatus {
  return typeof value === "string" && TODO_STATUSES.has(value);
}


export function parseProgressionDigest(value: unknown): ProgressionDigest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const milestones = boundedStringArray(Reflect.get(value, "completedMilestones"), MAX_MILESTONES);
  const decisions = boundedStringArray(Reflect.get(value, "decisions"), MAX_DECISIONS);
  const blockers = boundedStringArray(Reflect.get(value, "blockers"), MAX_BLOCKERS);
  if (!milestones || !decisions || !blockers) return undefined;

  const goalValue = Reflect.get(value, "goal");
  const focusValue = Reflect.get(value, "currentFocus");
  const earlierValue = Reflect.get(value, "earlierProgress");
  const goal = goalValue == null ? undefined : boundedString(goalValue, MAX_GOAL_CHARACTERS);
  const currentFocus = focusValue == null ? undefined : boundedString(focusValue, MAX_DIGEST_ITEM_CHARACTERS);
  const earlierProgress =
    earlierValue == null ? undefined : boundedString(earlierValue, MAX_EARLIER_PROGRESS_CHARACTERS);
  if ((goalValue != null && !goal) || (focusValue != null && !currentFocus) || (earlierValue != null && !earlierProgress)) {
    return undefined;
  }

  return {
    goal,
    currentFocus,
    earlierProgress,
    completedMilestones: milestones,
    decisions,
    blockers,
  };
}

function parseTodoOperation(value: unknown): TodoOperationInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const op = Reflect.get(value, "op");
  if (typeof op !== "string" || !TODO_OPERATIONS.has(op)) return undefined;

  const parsed: TodoOperationInput = { op };
  const task = boundedString(Reflect.get(value, "task"), MAX_LABEL_CHARACTERS);
  const phase = boundedString(Reflect.get(value, "phase"), MAX_PHASE_CHARACTERS);
  const reason = boundedString(Reflect.get(value, "reason"), MAX_DIGEST_ITEM_CHARACTERS);
  if (task) parsed.task = task;
  if (phase) parsed.phase = phase;
  if (reason) parsed.reason = reason;

  const rawItems = Reflect.get(value, "items");
  if (Array.isArray(rawItems)) {
    parsed.items = rawItems
      .map((item) => boundedString(item, MAX_LABEL_CHARACTERS))
      .filter((item): item is string => Boolean(item))
      .slice(0, MAX_TASKS);
  }

  const rawList = Reflect.get(value, "list");
  if (Array.isArray(rawList)) {
    parsed.list = [];
    for (const candidate of rawList) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const candidatePhase = boundedString(Reflect.get(candidate, "phase"), MAX_PHASE_CHARACTERS);
      const candidateItems = Reflect.get(candidate, "items");
      if (!candidatePhase || !Array.isArray(candidateItems)) continue;
      parsed.list.push({
        phase: candidatePhase,
        items: candidateItems
          .map((item) => boundedString(item, MAX_LABEL_CHARACTERS))
          .filter((item): item is string => Boolean(item))
          .slice(0, MAX_TASKS),
      });
    }
  }

  return parsed;
}

export class ProgressionState {
  #digest = emptyDigest();
  #tasks: TrackedTask[] = [];
  #pendingTodoOperations = new Map<string, TodoOperationInput>();
  #ompGoal?: string;

  reset(): void {
    this.#digest = emptyDigest();
    this.#tasks = [];
    this.#pendingTodoOperations.clear();
    this.#ompGoal = undefined;
  }

  snapshot(): EagleViewProgressionSnapshot {
    return {
      digest: {
        ...this.#digest,
        completedMilestones: [...this.#digest.completedMilestones],
        decisions: [...this.#digest.decisions],
        blockers: [...this.#digest.blockers],
      },
      tasks: this.#tasks.map((task) => ({ ...task })),
      ompGoal: this.#ompGoal,
    };
  }

  applyDigest(digest: ProgressionDigest): void {
    this.#digest = {
      ...digest,
      completedMilestones: [...digest.completedMilestones],
      decisions: [...digest.decisions],
      blockers: [...digest.blockers],
    };
  }

  setOmpGoal(goal: unknown): void {
    if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
      this.#ompGoal = undefined;
      return;
    }
    this.#ompGoal = boundedString(Reflect.get(goal, "objective"), MAX_GOAL_CHARACTERS);
  }

  captureTodoOperation(toolCallId: string, input: unknown): void {
    const operation = parseTodoOperation(input);
    if (operation) this.#pendingTodoOperations.set(toolCallId, operation);
  }

  finishTodoOperation(toolCallId: string, succeeded: boolean): boolean {
    const operation = this.#pendingTodoOperations.get(toolCallId);
    this.#pendingTodoOperations.delete(toolCallId);
    if (!operation || !succeeded || operation.op === "view") return false;
    this.#applyTodoOperation(operation);
    return true;
  }

  reconcileTodoReminder(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const incomplete = new Map<string, Pick<TrackedTask, "label" | "status" | "blocker">>();
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const label = boundedString(Reflect.get(candidate, "content"), MAX_LABEL_CHARACTERS);
      const status = Reflect.get(candidate, "status");
      const blocker = boundedString(Reflect.get(candidate, "blocker"), MAX_DIGEST_ITEM_CHARACTERS);
      if (!label || !isTrackedTaskStatus(status)) continue;
      incomplete.set(label, { label, status, blocker });
      if (incomplete.size === MAX_TASKS) break;
    }
    if (incomplete.size === 0) return false;

    const reconciled: TrackedTask[] = [];
    for (const existing of this.#tasks) {
      if (existing.status === "blocked" || existing.status === "completed" || existing.status === "abandoned") {
        reconciled.push(existing);
        continue;
      }
      const update = incomplete.get(existing.label);
      if (!update) continue;
      reconciled.push({ ...existing, status: update.status, blocker: update.blocker });
      incomplete.delete(existing.label);
    }
    for (const update of incomplete.values()) {
      reconciled.push({ phase: "Tasks", ...update });
    }
    const nextTasks = reconciled.slice(0, MAX_TASKS);
    const changed =
      nextTasks.length !== this.#tasks.length ||
      nextTasks.some((task, index) => {
        const previous = this.#tasks[index];
        return (
          !previous ||
          previous.phase !== task.phase ||
          previous.label !== task.label ||
          previous.status !== task.status ||
          previous.blocker !== task.blocker
        );
      });
    if (!changed) return false;
    this.#tasks = nextTasks;
    return true;
  }

  #applyTodoOperation(operation: TodoOperationInput): void {
    if (operation.op === "init") {
      const groups = operation.list ?? [{ phase: operation.phase ?? "Tasks", items: operation.items ?? [] }];
      this.#tasks = groups
        .flatMap((group) => group.items.map((label) => ({ phase: group.phase, label, status: "pending" as const })))
        .slice(0, MAX_TASKS);
      return;
    }

    if (operation.op === "append") {
      const phase = operation.phase ?? "Tasks";
      for (const label of operation.items ?? []) {
        if (this.#tasks.some((task) => task.label === label) || this.#tasks.length === MAX_TASKS) continue;
        this.#tasks.push({ phase, label, status: "pending" });
      }
      return;
    }

    const targets = this.#tasks.filter((task) => {
      if (operation.task) return task.label === operation.task;
      if (operation.phase) return task.phase === operation.phase;
      return true;
    });

    if (operation.op === "rm") {
      const targetSet = new Set(targets);
      this.#tasks = this.#tasks.filter((task) => !targetSet.has(task));
      return;
    }

    if (operation.op === "start") {
      for (const task of this.#tasks) {
        if (task.status === "in_progress") task.status = "pending";
      }
      if (targets[0]) targets[0].status = "in_progress";
      return;
    }

    for (const task of targets) {
      if (operation.op === "done") task.status = "completed";
      if (operation.op === "drop") task.status = "abandoned";
      if (operation.op === "block" && ["pending", "in_progress", "blocked"].includes(task.status)) {
        task.status = "blocked";
        task.blocker = operation.reason;
      }
      if (operation.op === "unblock" && task.status === "blocked") {
        task.status = "pending";
        task.blocker = undefined;
      }
    }
  }
}

export function formatProgression(snapshot: EagleViewProgressionSnapshot): string {
  const digest = snapshot.digest;
  const lines = [
    `Goal: ${snapshot.ompGoal ?? digest.goal ?? "Not established yet"}`,
    `Current focus: ${digest.currentFocus ?? "Not established yet"}`,
  ];

  lines.push("Tasks:");
  if (snapshot.tasks.length === 0) lines.push("- None tracked");
  for (const task of snapshot.tasks) {
    const blocker = task.blocker ? ` — ${task.blocker}` : "";
    lines.push(`- [${task.status}] ${task.phase}: ${task.label}${blocker}`);
  }

  const sections: Array<[string, string[]]> = [
    ["Completed milestones", digest.completedMilestones],
    ["Decisions", digest.decisions],
    ["Blockers", digest.blockers],
  ];
  for (const [heading, items] of sections) {
    lines.push(`${heading}:`);
    if (items.length === 0) lines.push("- None");
    else lines.push(...items.map((item) => `- ${item}`));
  }
  lines.push(`Earlier progress: ${digest.earlierProgress ?? "None"}`);
  return lines.join("\n");
}
