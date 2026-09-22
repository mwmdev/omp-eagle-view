import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

const WIDGET_KEY = "eagle-view";
const MAX_WIDGET_LINES = 2;

export function renderWidgetLines(narration: string, width: number, icon = ""): string[] {
  const normalized = narration.replaceAll(/\s+/g, " ").trim();
  if (!normalized || width < 1) return [];

  const desiredPrefix = icon ? ` ${icon} ` : " ";
  const desiredPrefixWidth = Bun.stringWidth(desiredPrefix, { countAnsiEscapeCodes: false });
  const prefix = desiredPrefixWidth < width ? desiredPrefix : width > 1 ? " " : "";
  const prefixWidth = Bun.stringWidth(prefix, { countAnsiEscapeCodes: false });
  const contentWidth = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(normalized, contentWidth);
  const messageLines =
    wrapped.length <= MAX_WIDGET_LINES
      ? wrapped
      : [wrapped[0], truncateToWidth(wrapped.slice(1).join(" "), contentWidth)];
  const continuationIndent = " ".repeat(prefixWidth);

  return [
    `${prefix}${messageLines[0]}`,
    ...messageLines.slice(1).map((line) => `${continuationIndent}${line}`),
    "",
  ];
}

export function showEagleViewWidget(ctx: ExtensionContext, narration: string, icon = ""): void {
  if (!ctx.hasUI) return;

  ctx.ui.setWidget(
    WIDGET_KEY,
    (_tui, theme) => ({
      render(width: number): readonly string[] {
        return renderWidgetLines(narration, width, icon).map((line) =>
          truncateToWidth(theme.fg("muted", line), width, null, true),
        );
      },
    }),
    { placement: "aboveEditor" },
  );
}

export function clearEagleViewWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
}
