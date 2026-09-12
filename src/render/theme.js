/**
 * Thresholds and glyph helpers shared by every surface.
 *
 * Remaining (not used) percent drives the color so that a healthy account reads
 * green, a tightening one yellow and a nearly exhausted one red.
 */

/**
 * @typedef {"ok" | "warn" | "danger" | "unknown" | "dim" | "bold" | "accent"} PaletteKey
 */

/**
 * @typedef {(key: PaletteKey, text: string) => string} Paint
 */

/**
 * @param {number | null} remainingPercent
 * @returns {PaletteKey}
 */
export function thresholdKey(remainingPercent) {
  if (remainingPercent === null || !Number.isFinite(remainingPercent)) return "unknown";
  if (remainingPercent > 50) return "ok";
  if (remainingPercent >= 20) return "warn";
  return "danger";
}

/**
 * Five-step ring glyph for compact status lines.
 *
 * @param {number | null} remainingPercent
 * @returns {string}
 */
export function ringGlyph(remainingPercent) {
  if (remainingPercent === null || !Number.isFinite(remainingPercent)) return "◌";
  if (remainingPercent >= 87.5) return "●";
  if (remainingPercent >= 62.5) return "◕";
  if (remainingPercent >= 37.5) return "◑";
  if (remainingPercent >= 12.5) return "◔";
  return "○";
}

/**
 * Percentage bar for the detailed panel.
 *
 * @param {number | null} remainingPercent
 * @param {number} [width]
 * @returns {string}
 */
export function bar(remainingPercent, width = 14) {
  if (remainingPercent === null || !Number.isFinite(remainingPercent)) {
    return "·".repeat(width);
  }
  const filled = Math.round((Math.min(100, Math.max(0, remainingPercent)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/**
 * Round a percent for display, tolerating missing values.
 *
 * @param {number | null} value
 * @returns {string}
 */
export function percentText(value) {
  if (value === null || !Number.isFinite(value)) return "  n/a";
  return `${Math.round(value)}%`.padStart(5);
}

const ANSI = {
  ok: "\u001b[32m",
  warn: "\u001b[33m",
  danger: "\u001b[31m",
  unknown: "\u001b[90m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  accent: "\u001b[36m",
  reset: "\u001b[0m",
};

/**
 * ANSI palette used by the terminal CLI.
 *
 * @param {{ color?: boolean, env?: Record<string, string | undefined>, isTty?: boolean }} [options]
 * @returns {Paint}
 */
export function ansiPalette(options = {}) {
  const env = options.env ?? process.env;
  const isTty = options.isTty ?? Boolean(process.stdout?.isTTY);
  const enabled =
    options.color ?? (isTty && env.NO_COLOR === undefined && env.TERM !== "dumb");
  if (!enabled) return (_key, text) => text;
  return (key, text) => `${ANSI[key] ?? ""}${text}${ANSI.reset}`;
}

/**
 * Identity palette used when the caller already styles its own output
 * (for example the Pi TUI, which paints through its theme).
 *
 * @returns {Paint}
 */
export function plainPalette() {
  return (_key, text) => text;
}
