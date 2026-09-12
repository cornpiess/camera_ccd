import type { CameraLens } from './CameraEngine';

/**
 * Focal-stop model for the FocalApertureDial.
 *
 * Focal lengths are 35mm-equivalent values derived from the physical lens inventory:
 * - Dual-camera devices (e.g. iPhone 14 Plus): 13mm ultra-wide + 26mm main, with 35mm
 *   and 52mm (2× crop) derived digitally on the main lens.
 * - Triple-camera devices (Pro class, assumed 24mm main and 3× telephoto): 13 / 24 / 28 /
 *   35 / 48 are native-or-crop on the main, 96 (≈4×) / 192 (≈8×) sit on the telephoto —
 *   native stops once a 4×-telephoto body (e.g. iPhone 18 Pro) is available, mild crops
 *   on current 3× hardware.
 * `zoom` is the videoZoomFactor to apply ON the stop's physical lens (1.0 = native FOV),
 * so preview and capture framing stay identical (WYSIWYG).
 */
export type LensId = CameraLens['id'];

export interface FocalStop {
  /** 35mm-equivalent focal length in millimeters (displayed on the dial). */
  readonly mm: number;
  /** Physical lens this stop resolves to. */
  readonly lensId: LensId;
  /** videoZoomFactor applied on that lens (≥1). */
  readonly zoom: number;
}

/** Single-lens devices: main only, still get the classic walk. */
const WIDE_ONLY_BASE_MM = 26;

const hasTelephoto = (lensIds: readonly string[]): boolean => lensIds.includes('telephoto');

export function buildFocalStops(lensIds: readonly string[]): FocalStop[] {
  const has = (id: LensId): boolean => lensIds.includes(id);
  const hasUltraWide = has('ultraWide');
  // Pro bodies (all triple-camera iPhones to date) use a 24mm-equivalent main;
  // single/dual-camera bodies use 26mm (e.g. iPhone 14 Plus).
  const base = has('telephoto') ? 24 : WIDE_ONLY_BASE_MM;

  const stops: FocalStop[] = [];
  if (hasUltraWide) {
    stops.push({ mm: 13, lensId: 'ultraWide', zoom: 1 });
  }
  stops.push({ mm: base, lensId: 'wide', zoom: 1 });
  stops.push({ mm: 35, lensId: 'wide', zoom: 35 / base });
  stops.push({ mm: base * 2, lensId: 'wide', zoom: 2 });
  if (has('telephoto')) {
    // 28mm is only meaningful on a rich ladder; keep dual-camera dials uncluttered.
    stops.splice(2, 0, { mm: 28, lensId: 'wide', zoom: 28 / base });
    // Assumed 3× telephoto on current hardware; native ~4× on future bodies — the mm
    // targets stay the same either way, only the crop on the tele changes slightly.
    stops.push({ mm: base * 4, lensId: 'telephoto', zoom: 4 / 3 });
    stops.push({ mm: base * 8, lensId: 'telephoto', zoom: 8 / 3 });
  }
  return stops;
}

/** Default stop when a device reports no usable lens list (treated as main-only). */
export function defaultFocalStop(lensIds: readonly string[]): FocalStop {
  const base = hasTelephoto(lensIds) ? 24 : WIDE_ONLY_BASE_MM;
  return { mm: base, lensId: 'wide', zoom: 1 };
}
