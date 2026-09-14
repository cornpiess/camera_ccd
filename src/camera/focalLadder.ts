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

export function buildFocalStops(kind: DeviceKind): FocalStop[] {
  const base = isVirtual(kind) ? VIRTUAL_BASE_MM : SINGLE_BASE_MM;
  const zoomFor = (mm: number): number => mm / base;
  const stops: FocalStop[] = [];
  if (isVirtual(kind)) {
    stops.push({ mm: 13, lensId: 'wide', zoom: zoomFor(13) });
  }
  stops.push({ mm: 26, lensId: 'wide', zoom: zoomFor(26) });
  stops.push({ mm: 35, lensId: 'wide', zoom: zoomFor(35) });
  stops.push({ mm: 52, lensId: 'wide', zoom: zoomFor(52) });
  return stops;
}

/** Default stop: the main camera (26mm) — zoom 2.0 on virtual bodies, 1.0 on single-wide. */
export function defaultFocalStop(kind: DeviceKind): FocalStop {
  const base = isVirtual(kind) ? VIRTUAL_BASE_MM : SINGLE_BASE_MM;
  return { mm: 26, lensId: 'wide', zoom: 26 / base };
}
