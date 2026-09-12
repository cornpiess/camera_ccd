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
export interface ProfileUi { readonly shortName: string; readonly accent: string; readonly dialStyle: string }
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
  /** Reserved: reference to a future 3D LUT / color cube asset (GOAL 19 keeps this capability open). Not applied by the engine yet. */
  readonly lut?: string | null;
}
export interface GrainSettings { readonly amount: number; readonly size: number }
export interface VignetteSettings { readonly amount: number; readonly radius: number }
export interface HalationSettings { readonly amount: number; readonly radius: number }
export interface TextureSettings {
  readonly grain: GrainSettings;
  readonly vignette: VignetteSettings;
  readonly halation: HalationSettings;
}
export interface CameraProfile {
  readonly id: string;
  readonly name: string;
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
