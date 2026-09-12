export const HUE_BAND_NAMES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const;
export type HueBandName = (typeof HUE_BAND_NAMES)[number];

export interface ApertureSettings {
  readonly preferred: number;
  /**
   * f-number from which a real optical starburst becomes more likely (the restrained ✦ hint).
   * Informational only — the starburst itself must always come from the physical aperture.
   */
  readonly starZone?: number;
}
export interface ProfileUi {
  readonly shortName: string;
  /** Light accent color (≈5% of the visual budget); never a brand color, never large fills. */
  readonly accent: string;
  readonly dialStyle: string;
  /** Personality keyword for micro-motion / copy tone. Appearance-only, never interaction. */
  readonly personality?: string;
  readonly labelStyle?: string;
  /** Abstract selection marker glyph: dot | line | diamond | ring. */
  readonly markerStyle?: string;
  /** 0..1 — how strongly the accent may tint the glass around this camera. Default 0.06. */
  readonly glassTintStrength?: number;
}
export interface RawAdjustments {
  readonly sharpness: number;
  readonly detail: number;
  readonly localToneMap: number;
  readonly luminanceNoiseReduction: number;
  readonly colorNoiseReduction: number;
}
export type CurvePoint = readonly [x: number, y: number];
export interface ToneSettings {
  readonly exposure: number;
  readonly contrast: number;
  readonly blackPoint: number;
  readonly curve: readonly CurvePoint[];
  /** Reserved: capture-time exposure bias in EV for this camera's metering personality. Engine wiring (AVCaptureDevice.setExposureTargetBias) is not implemented yet. */
  readonly exposureBias?: number;
}
export interface HueBandAdjustments { readonly hue: number; readonly saturation: number; readonly luminance: number }
export type HueBands = Readonly<Record<HueBandName, HueBandAdjustments>>;
export interface GlobalColorAdjustments {
  readonly saturation: number;
  readonly temperature: number;
  readonly tint: number;
  readonly hueBands: HueBands;
  /** Optional 3D LUT (.cube, Camera18_LUT_V0 pack) applied as the camera-character layer. */
  readonly lut?: string | null;
  /**
   * LUT blend intensity 0..1 (default 1). The engine mixes LUT output over the tone-mapped
   * image, so calibrated looks can be held back (0.3–0.8) to avoid a cheap filter feel.
   */
  readonly lutIntensity?: number;
}
export interface GrainSettings { readonly amount: number; readonly size: number }
export interface VignetteSettings { readonly amount: number; readonly radius: number }
export interface HalationSettings { readonly amount: number; readonly radius: number }
export interface StarburstSettings {
  /** Highlight cut-in threshold 0..1 — only true point lights pass (lamps, sun, speculars). */
  readonly threshold: number;
  /** 0..1 base strength; the aperture linkage multiplies this at run time. */
  readonly strength: number;
  /** 0..1 streak length (maps to the motion-blur radius of each ray pass). */
  readonly length: number;
  /** Visible ray points: 4, 6 or 8 (2/3/4 blur directions). */
  readonly rays: number;
}
export interface TextureSettings {
  readonly grain: GrainSettings;
  readonly vignette: VignetteSettings;
  readonly halation: HalationSettings;
  readonly starburst?: StarburstSettings;
}
export interface CameraProfile {
  readonly id: string;
  /** User-visible production name. Describes the photographic feel, never a third-party brand. */
  readonly name: string;
  readonly displayName?: string;
  /**
   * Development-only calibration metadata (e.g. the real target camera). The validator strips
   * this at runtime, so it can never reach production state or the UI.
   */
  readonly developmentReference?: { readonly target?: string; readonly note?: string };
  readonly aperture: ApertureSettings;
  readonly ui: ProfileUi;
  readonly raw: RawAdjustments;
  readonly tone: ToneSettings;
  readonly color: GlobalColorAdjustments;
  readonly texture: TextureSettings;
}
export interface ProfileDocument {
  readonly schemaVersion: 1;
  readonly profiles: readonly CameraProfile[];
}
export interface ProfileValidationSuccess { readonly success: true; readonly document: ProfileDocument }
export interface ProfileValidationFailure { readonly success: false; readonly errors: readonly string[] }
export type ProfileValidationResult = ProfileValidationSuccess | ProfileValidationFailure;
