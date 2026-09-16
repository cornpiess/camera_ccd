/**
 * Focal-stop model for the in-finder focal dial.
 *
 * Built on Apple's canonical smooth-focal architecture: the session uses a VIRTUAL
 * capture device (builtInTripleCamera / builtInDualCamera / builtInDualWideCamera) and
 * focal changes are pure videoZoomFactor moves — the system crossfades between the
 * physical cameras seamlessly (no input swaps, no preview flicker).
 *
 * Zoom baseline (Apple docs for virtual devices): zoomFactor 1.0 renders the widest
 * constituent camera, the ultra-wide (13mm-equivalent). So on virtual bodies:
 *   zoom(mm) = mm / 13   → 13mm=1.0, 26mm=2.0, 35mm≈2.69, 52mm=4.0.
 * The ladder is EXACTLY the four stops the user confirmed (2026-09-14):
 *   13 (0.5× real ultra-wide) / 26 (1× main) / 35 (main crop) / 52 (2× main crop).
 * Single-wide bodies (no ultra-wide constituent) start at the 26mm main (zoom 1.0),
 * and their zoom baseline is the 26mm main itself.
 */

export type DeviceKind = 'virtual-triple' | 'virtual-dual' | 'virtual-dual-wide' | 'single';

export interface FocalStop {
  /** 35mm-equivalent focal length in millimeters (displayed on the dial). */
  readonly mm: number;
  /** Physical lens this stop resolves to (always "wide" — the virtual device). */
  readonly lensId: 'wide';
  /** videoZoomFactor applied on the device; preview and capture framing stay identical. */
  readonly zoom: number;
}

const VIRTUAL_BASE_MM = 13;
const SINGLE_BASE_MM = 26;

const isVirtual = (kind: DeviceKind): boolean => kind.startsWith('virtual');

export interface BuildFocalStopsOptions {
  /** Native switchover zoom factor of the TELEPHOTO constituent (nil = no tele). */
  readonly teleZoom?: number | null;
}

/**
 * Ladder order (user spec, capability-driven):
 *   Ultra Wide (REAL, only when the device has one) -> 26 -> 35 -> 52 -> Tele (REAL,
 *   only when the device has one, at the DEVICE'S OWN tele mm - never a fixed 3x/4x/5x).
 * 26/35/52 are identical on every iPhone (main 1x + crops). Tele mm = 13 * teleZoom
 * (the native switchover factor IS the tele's own multiplier over the 13mm base).
 */
export function buildFocalStops(kind: DeviceKind, options: BuildFocalStopsOptions = {}): FocalStop[] {
  const base = isVirtual(kind) ? VIRTUAL_BASE_MM : SINGLE_BASE_MM;
  const zoomFor = (mm: number): number => mm / base;
  const stops: FocalStop[] = [];
  if (isVirtual(kind)) {
    stops.push({ mm: 13, lensId: 'wide', zoom: zoomFor(13) });
  }
  stops.push({ mm: 26, lensId: 'wide', zoom: zoomFor(26) });
  stops.push({ mm: 35, lensId: 'wide', zoom: zoomFor(35) });
  stops.push({ mm: 52, lensId: 'wide', zoom: zoomFor(52) });
  const teleZoom = options.teleZoom;
  if (isVirtual(kind) && typeof teleZoom === 'number' && Number.isFinite(teleZoom) && teleZoom > 0) {
    const teleMm = Math.round(VIRTUAL_BASE_MM * teleZoom);
    if (teleMm > 52 && !stops.some((stop) => stop.mm === teleMm)) {
      stops.push({ mm: teleMm, lensId: 'wide', zoom: teleZoom });
    }
  }
  return stops;
}

/** Default stop: the main camera (26mm) — zoom 2.0 on virtual bodies, 1.0 on single-wide. */
export function defaultFocalStop(kind: DeviceKind): FocalStop {
  const base = isVirtual(kind) ? VIRTUAL_BASE_MM : SINGLE_BASE_MM;
  return { mm: 26, lensId: 'wide', zoom: 26 / base };
}

/** Convenience: tele stop for the dial when the device reports a tele zoom factor. */
export function teleFocalStop(kind: DeviceKind, teleZoom: number): FocalStop | null {
  if (!isVirtual(kind) || !(teleZoom > 0)) return null;
  const teleMm = Math.round(VIRTUAL_BASE_MM * teleZoom);
  if (teleMm <= 52) return null;
  return { mm: teleMm, lensId: 'wide', zoom: teleZoom };
}
