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
 *   zoom(mm) = mm / 13   → 13mm=1.0, 26mm=2.0, 35mm≈2.69, 52mm=4.0, 78mm=6.0, 156mm=12.
 * Single-wide bodies (no ultra-wide constituent) keep the 26mm main at zoom 1.0.
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
  const stops: FocalStop[] = [];
  if (isVirtual(kind)) {
    stops.push({ mm: 13, lensId: 'wide', zoom: 1 });
  }
  const base = isVirtual(kind) ? VIRTUAL_BASE_MM : SINGLE_BASE_MM;
  stops.push({ mm: base * 2, lensId: 'wide', zoom: (base * 2) / VIRTUAL_BASE_MM });
  stops.push({ mm: 35, lensId: 'wide', zoom: 35 / VIRTUAL_BASE_MM });
  stops.push({ mm: base * 4, lensId: 'wide', zoom: (base * 4) / VIRTUAL_BASE_MM });
  if (kind === 'virtual-triple') {
    stops.push({ mm: 78, lensId: 'wide', zoom: 6 });
    stops.push({ mm: 156, lensId: 'wide', zoom: 12 });
  }
  return stops;
}

/** Default stop: the main camera (26mm) — zoom 2.0 on virtual bodies, 1.0 on single-wide. */
export function defaultFocalStop(kind: DeviceKind): FocalStop {
  const mm = SINGLE_BASE_MM;
  return { mm, lensId: 'wide', zoom: mm / (isVirtual(kind) ? VIRTUAL_BASE_MM : SINGLE_BASE_MM) };
}
