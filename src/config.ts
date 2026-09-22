import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export interface EagleViewConfig {
  enabled: boolean;
  intervalMinutes: number;
  initialEventCount: number;
  icon: string;
  prompt: string;
  model?: string;
}

export const PLUGIN_NAME = "omp-eagle-view";

export const DEFAULT_PROMPT =
  'Write like a wise old man quietly observing the work: patient, measured, warm, and plain-spoken. Explain what is happening and why it matters in everyday words. Translate technical actions into their practical purpose or outcome. For example, say "making sure the change holds firm" rather than "running integration tests." Offer gentle perspective when it fits, but avoid archaic language, riddles, sermons, grand pronouncements, clichés, and calling the reader "young one." Never sacrifice accuracy for character or invent progress.';
export const DEFAULT_CONFIG: Readonly<EagleViewConfig> = {
  enabled: true,
  icon: "🦅",
  initialEventCount: 3,
  intervalMinutes: 2,
  prompt: DEFAULT_PROMPT,
};

const MIN_INTERVAL_MINUTES = 0.25;
const MAX_INTERVAL_MINUTES = 24 * 60;
const MIN_INITIAL_EVENT_COUNT = 1;
const MAX_INITIAL_EVENT_COUNT = 100;
const ICON_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_PROMPT_CHARACTERS = 4_000;
const PROMPT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

type Warn = (message: string, details?: Record<string, unknown>) => void;

export function parseEagleViewConfig(
  value: unknown,
  source: string,
  warn: Warn = () => {},
): Partial<EagleViewConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warn("eagle-view: ignored non-object configuration", { source });
    return {};
  }

  const enabled = Reflect.get(value, "enabled");
  const intervalMinutes = Reflect.get(value, "intervalMinutes");
  const initialEventCount = Reflect.get(value, "initialEventCount");
  const icon = Reflect.get(value, "icon");
  const prompt = Reflect.get(value, "prompt");
  const model = Reflect.get(value, "model");
  const config: Partial<EagleViewConfig> = {};

  if (enabled !== undefined) {
    if (typeof enabled === "boolean") config.enabled = enabled;
    else warn("eagle-view: ignored invalid enabled setting", { source });
  }

  if (intervalMinutes !== undefined) {
    if (
      typeof intervalMinutes === "number" &&
      Number.isFinite(intervalMinutes) &&
      intervalMinutes >= MIN_INTERVAL_MINUTES &&
      intervalMinutes <= MAX_INTERVAL_MINUTES
    ) {
      config.intervalMinutes = intervalMinutes;
    } else {
      warn("eagle-view: ignored invalid intervalMinutes setting", { source });
    }
  }

  if (initialEventCount !== undefined) {
    if (
      typeof initialEventCount === "number" &&
      Number.isInteger(initialEventCount) &&
      initialEventCount >= MIN_INITIAL_EVENT_COUNT &&
      initialEventCount <= MAX_INITIAL_EVENT_COUNT
    ) {
      config.initialEventCount = initialEventCount;
    } else {
      warn("eagle-view: ignored invalid initialEventCount setting", { source });
    }
  }

  if (model !== undefined) {
    if (typeof model === "string" && model.trim()) config.model = model.trim();
    else warn("eagle-view: ignored invalid model setting", { source });
  }

  if (prompt !== undefined) {
    const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : undefined;
    if (
      trimmedPrompt &&
      trimmedPrompt.length <= MAX_PROMPT_CHARACTERS &&
      !PROMPT_CONTROL_CHARACTERS.test(trimmedPrompt)
    ) {
      config.prompt = trimmedPrompt;
    } else {
      warn("eagle-view: ignored invalid prompt setting", { source });
    }
  }

  if (icon !== undefined) {
    const trimmedIcon = typeof icon === "string" ? icon.trim() : undefined;
    if (
      trimmedIcon !== undefined &&
      !ICON_CONTROL_CHARACTERS.test(trimmedIcon) &&
      Array.from(trimmedIcon).length <= 4
    ) {
      config.icon = trimmedIcon;
    } else {
      warn("eagle-view: ignored invalid icon setting", { source });
    }
  }

  return config;
}

export async function loadEagleViewConfig(cwd: string, warn: Warn = () => {}): Promise<EagleViewConfig> {
  try {
    const settings = await getPluginSettings(PLUGIN_NAME, cwd);
    return {
      ...DEFAULT_CONFIG,
      ...parseEagleViewConfig(settings, "OMP plugin settings", warn),
    };
  } catch (error) {
    warn("eagle-view: could not read plugin settings", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_CONFIG };
  }
}
