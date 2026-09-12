/**
 * Per-camera UI skin (user request: each simulated camera tints the whole interface with
 * its brand-authentic but MUTED identity color — e.g. Leica = textured dark Leica red,
 * Ricoh Negative = pale film green. Never glaring; the accent derives from the profile
 * JSON's ui.accent so new cameras skin themselves automatically.)
 */

export interface CameraSkin {
  /** The profile's identity accent, e.g. "#B5443C". */
  readonly accent: string;
  /** accent mixed over pure black — chrome/background tint (~8%). */
  readonly chrome: string;
  /** accent at low alpha — soft washes behind controls. */
  readonly soft: string;
  /** accent at mid alpha — borders and hairlines. */
  readonly border: string;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function hexToRgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? [255, 255, 255];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp01(alpha).toFixed(3)})`;
}

/** Mix a hex color over black by `ratio` (0 = black, 1 = the color itself). */
function mixOverBlack(hex: string, ratio: number): string {
  const rgb = parseHex(hex) ?? [255, 255, 255];
  const channel = (c: number): number => Math.round(c * clamp01(ratio));
  return `rgb(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])})`;
}

/** True when the accent is light enough that black text stays readable on it. */
export function isLightColor(hex: string): boolean {
  const rgb = parseHex(hex);
  if (!rgb) return false;
  const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return luminance > 0.6;
}

export function deriveSkin(accent: string | null | undefined): CameraSkin {
  const safe = typeof accent === 'string' && parseHex(accent) ? accent : '#D9B98A';
  return {
    accent: safe,
    chrome: mixOverBlack(safe, 0.09),
    soft: hexToRgba(safe, 0.14),
    border: hexToRgba(safe, 0.4),
  };
}
