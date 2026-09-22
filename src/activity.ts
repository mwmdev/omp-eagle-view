const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE = /\s+/g;
const MAX_ENTRY_CHARACTERS = 480;
const MAX_ENTRIES = 32;

export type ActivityKind = "user" | "assistant" | "tool" | "subagent" | "system";

interface ActivityEntry {
  kind: ActivityKind;
  text: string;
}

const LABELS: Record<ActivityKind, string> = {
  user: "User request",
  assistant: "Assistant update",
  tool: "Work event",
  subagent: "Delegated work",
  system: "Session event",
};

export function cleanActivityText(value: string, limit = MAX_ENTRY_CHARACTERS): string {
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

export function assistantText(message: unknown): string | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    !(("role" in message) && message.role === "assistant") ||
    !(("content" in message) && Array.isArray(message.content))
  ) {
    return undefined;
  }

  const text = message.content.filter(isTextPart).map((part) => part.text).join(" ");
  const cleaned = cleanActivityText(text);
  return cleaned || undefined;
}

export class ActivityBuffer {
  #entries: ActivityEntry[] = [];
  #version = 0;

  get version(): number {
    return this.#version;
  }

  get empty(): boolean {
    return this.#entries.length === 0;
  }

  clear(): void {
    this.#entries = [];
    this.#version = 0;
  }

  add(kind: ActivityKind, value: string): boolean {
    const text = cleanActivityText(value);
    if (!text) return false;

    const previous = this.#entries.at(-1);
    if (previous?.kind === kind && previous.text === text) return false;

    this.#entries.push({ kind, text });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
    this.#version += 1;
    return true;
  }

  snapshot(maxCharacters = 6_000): string {
    const lines: string[] = [];
    let size = 0;

    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index];
      const line = `- ${LABELS[entry.kind]}: ${entry.text}`;
      if (lines.length > 0 && size + line.length + 1 > maxCharacters) break;
      lines.push(line);
      size += line.length + 1;
    }

    return lines.reverse().join("\n");
  }
}

export function describeToolStart(toolName: string, intent?: string): { kind: ActivityKind; text: string } {
  if (toolName === "task") return { kind: "subagent", text: "Started background work" };
  const detail = intent ? `: ${cleanActivityText(intent, 160)}` : "";
  return { kind: "tool", text: `Started ${toolName}${detail}` };
}

export function describeToolEnd(toolName: string, isError: boolean): { kind: ActivityKind; text: string } {
  if (toolName === "task") {
    return { kind: "subagent", text: isError ? "Background work failed" : "Background work was delegated" };
  }
  return {
    kind: "tool",
    text: `${isError ? "Failed" : "Finished"} ${toolName}`,
  };
}
