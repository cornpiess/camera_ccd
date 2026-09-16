/**
 * ApertureVisualProfile — the aperture is not an isolated number.
 *
 * One f-stop position drives the whole visual system at once (advice §20/§21):
 *
 *   aperture → physical aperture (hardware, iOS 27+)
 *            + bloom (halation) strength      — strong wide open, restrained stopped down
 *            + starburst strength             — SIMULATION ONLY, fixed-lens devices; forced
 *                                               to 0 on real variable-aperture hardware
 *                                               (the optics already produce real spikes)
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
 * starburst; t=1 (stopped down) → the expert's reference table inverted: bloom ~0.25-0.5.
 * Starburst is a FIXED-LENS simulation factor only — always 0 on real variable-aperture
 * hardware so synthetic spikes never stack on the real diffraction ones. Neutral (1, 1)
 * when the device has no variable aperture, so fixed-lens profiles render exactly as
 * calibrated.
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
  // Real variable-aperture hardware (iPhone 18 Pro): stopped-down star spikes are REAL
  // diffraction around the blade edges — the synthetic starburst stage must never stack
  // on top of them (double flare, worse than the system camera). The optics own the
  // starburst; the synthetic layer exists only for fixed-lens demo simulation.
  // Bloom stays linked: film-halation stylization mirrors the real wide-open veiling
  // flare direction without claiming to be the optics.
  return {
    bloom: lerp(1.3, 0.55, t),
    starburst: 0,
  };
}

/**
 * Whether the aperture→bloom/starburst linkage is actually consumed by the native
 * renderer. The halation/starburst stages were RETIRED from CameraDNARenderer (star
 * spikes must come only from the real iPhone 18 Pro aperture optics) and every profile
 * ships texture.halation.amount = 0 — so cloning the profile per f-stop changed nothing
 * visible while costing a full native cube invalidation + 33³ rebuild per drag tick.
 * Keep this OFF until the renderer gains a stage that reads these fields again; flip it
 * to true in the same change that reintroduces the stages.
 */
const APERTURE_VISUAL_LINKAGE_ENABLED = false;

/**
 * Merge the factors into a profile copy for the renderer. Only the two texture amounts
 * are touched; everything else (tone, LUT, color) passes through untouched.
 */
export function applyApertureVisual<T extends Record<string, unknown>>(profile: T, factors: ApertureVisualFactors): T {
  if (!APERTURE_VISUAL_LINKAGE_ENABLED) return profile;
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
