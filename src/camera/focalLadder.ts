/**
 * Focal-stop model for the in-finder focal dial — PHYSICAL LENS ROUTING (user spec):
 *
 * The capture input is ALWAYS a physical camera (never the virtual triple/dual
 * device). Each stop maps to exactly one real lens:
 *   13mm        -> builtInUltraWideCamera  (its own fixed aperture)
 *   26/35/52mm  -> builtInWideAngleCamera  (ONE physical main; 35/52 are crop zooms,
 *                                          so the main's real variable iris — when
 *                                          the hardware has one — serves all three)
 *   tele        -> builtInTelephotoCamera  (its own fixed aperture)
 *
 * Lens switches (13 <-> wide <-> tele) swap the physical input natively
 * (CameraEngine.setLens); 26/35/52 only move videoZoomFactor on the main
 * (CameraEngine.setZoomFactor) — no input churn inside the trio.
 */

export type PhysicalLens = 'ultrawide' | 'wide' | 'tele';

export interface FocalStop {
  /** Stable stop id (dial keys, EXIF provenance): "uw-13" / "wide-26" / "tele-77" … */
  readonly id: string;
  /** 35mm-equivalent focal length in millimeters (displayed on the dial; EXIF stamped). */
  readonly mm: number;
  /** The PHYSICAL camera this stop resolves to. */
  readonly lens: PhysicalLens;
  /** videoZoomFactor applied on that physical device (1.0 for ultrawide/tele stops). */
  readonly zoom: number;
}

const WIDE_BASE_MM = 26;
/** Ultra-wide base; the tele stop's mm = UW_BASE_MM × inventory.teleZoom. */
const UW_BASE_MM = 13;

export interface LensInventory {
  /** A physical builtInUltraWideCamera exists. */
  readonly ultraWide: boolean;
  /** A physical builtInTelephotoCamera exists. */
  readonly tele: boolean;
  /** Tele's native multiplier over the 13mm base (nil = unknown / no tele). */
  readonly teleZoom?: number | null;
}

/**
 * Ladder (capability-driven — a stop without its physical lens is HIDDEN):
 *   [13 (real UW)] 26 -> 35 -> 52 (physical main crops) [tele at its own mm].
 */
export function buildFocalStops(inventory: LensInventory): FocalStop[] {
  const stops: FocalStop[] = [];
  if (inventory.ultraWide) {
    stops.push({ id: 'uw-13', mm: 13, lens: 'ultrawide', zoom: 1.0 });
  }
  stops.push({ id: 'wide-26', mm: 26, lens: 'wide', zoom: 1.0 });
  stops.push({ id: 'wide-35', mm: 35, lens: 'wide', zoom: 35 / WIDE_BASE_MM });
  stops.push({ id: 'wide-52', mm: 52, lens: 'wide', zoom: 52 / WIDE_BASE_MM });
  const teleZoom = inventory.teleZoom;
  if (
    inventory.tele &&
    typeof teleZoom === 'number' &&
    Number.isFinite(teleZoom) &&
    teleZoom > 0
  ) {
    const teleMm = Math.round(UW_BASE_MM * teleZoom);
    if (teleMm > 52 && !stops.some((stop) => stop.mm === teleMm)) {
      stops.push({ id: `tele-${teleMm}`, mm: teleMm, lens: 'tele', zoom: 1.0 });
    }
  }
  return stops;
}

/** Default stop: the physical main camera at 26mm (zoom 1.0). */
export function defaultFocalStop(): FocalStop {
  return { id: 'wide-26', mm: 26, lens: 'wide', zoom: 1.0 };
}
