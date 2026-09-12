/**
 * ApertureVisualProfile — the aperture is not an isolated number.
 *
 * One f-stop position drives the whole visual system at once (advice §20/§21):
 *
 *   aperture → physical aperture (hardware, iOS 27+)
 *            + bloom (halation) strength      — strong wide open, restrained stopped down
 *            + starburst strength             — absent wide open, strongest stopped down
 *
 * Depth is deliberately NOT software-simulated (repo red line 4: no fake bokeh without
 * physical hardware) — on real variable-aperture hardware the optics do it themselves.
 *
 * Exposure is also NOT touched here: on real hardware the AE system compensates
 * shutter/ISO automatically (we drive it with setExposureModeCustom(lensAperture:…,
 * duration:.auto, iso:.auto)); faking exposure with brightness would look cheap (§22).
 */

export interface ApertureVisualFactors {
  /** Multiplier on the profile's halation (bloom) amount. */
  readonly bloom: number;
  /** Multiplier on the profile's starburst strength. */
  readonly starburst: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Map the current f-stop onto visual factors. t=0 (wide open) → strong bloom, no
 * starburst; t=1 (stopped down) → the expert's reference table inverted: bloom ~0.25-0.5,
 * starburst 1.0. Neutral (1, 1) when the device has no variable aperture, so fixed-lens
 * profiles render exactly as calibrated.
 */
export function apertureVisualFactors(
  currentAperture: number,
  isVariableAperture: boolean,
  minAperture: number | null | undefined,
  maxAperture: number | null | undefined,
): ApertureVisualFactors {
  if (!isVariableAperture || !minAperture || !maxAperture || maxAperture <= minAperture) {
    return { bloom: 1, starburst: 1 };
  }
  const t = clamp01((currentAperture - minAperture) / (maxAperture - minAperture));
  return {
    bloom: lerp(1.3, 0.55, t),
    starburst: lerp(0.1, 1.0, t),
  };
}

/**
 * Merge the factors into a profile copy for the renderer. Only the two texture amounts
 * are touched; everything else (tone, LUT, color) passes through untouched.
 */
export function applyApertureVisual<T extends Record<string, unknown>>(profile: T, factors: ApertureVisualFactors): T {
  const texture = profile.texture as Record<string, unknown> | undefined;
  if (!texture || (factors.bloom === 1 && factors.starburst === 1)) return profile;
  const halation = texture.halation as Record<string, unknown> | undefined;
  const starburst = texture.starburst as Record<string, unknown> | undefined;
  return {
    ...profile,
    texture: {
      ...texture,
      halation: halation
        ? { ...halation, amount: clamp01(Number(halation.amount ?? 0) * factors.bloom) }
        : halation,
      starburst: starburst
        ? { ...starburst, strength: clamp01(Number(starburst.strength ?? 0) * factors.starburst) }
        : starburst,
    },
  } as T;
}
