import React, { useMemo } from 'react';
import Svg, { Line, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { hexToRgba } from '../theme/skin';

export interface ApertureSideViewProps {
  /** 0 = fully stopped down (tiny slit), 1 = wide open (full cone). Continuous. */
  readonly openness: number;
  /** Camera skin accent for the light cone + blade edges. */
  readonly accent?: string;
  /** Current f-number, shown as a small chip inside the diagram. */
  readonly label?: string;
  /** Rendered width in points; height follows the fixed VIEW aspect. */
  readonly width: number;
}

const VIEW_W = 260;
const VIEW_H = 92;
/** Barrel rail y positions (the lens cross-section outline). */
const RAIL_TOP = 14;
const RAIL_BOTTOM = 78;
const MID = (RAIL_TOP + RAIL_BOTTOM) / 2;
/** Aperture plate x (the diaphragm plane seen edge-on). */
const PLATE_X = 128;
const PLATE_W = 9;
/** Half-gap of the blade slit at fully-stopped-down vs wide-open. */
const HALF_GAP_MIN = 3;
const HALF_GAP_MAX = 30;

/**
 * Side-view aperture simulation (the "cut the lens in half" diagram):
 *
 *   incoming rays ▶  │blade│  ▶ converging cone ▶ sensor
 *
 * - The two dark plates are the iris blades seen EDGE-ON; the slit between them is the
 *   aperture opening, its height tracking the f-stop 1:1 with the ring drag.
 * - The light cone narrows as the ring stops down — the honest geometry behind why small
 *   apertures deepen focus and produce real diffraction starbursts on variable hardware.
 * - Pure visualization (DEMO): it never claims to change the capture on fixed-lens
 *   devices, matching the ApertureBar demo contract.
 */
export const ApertureSideView: React.FC<ApertureSideViewProps> = ({ openness, accent = '#FFFFFF', label, width }) => {
  const t = Math.min(1, Math.max(0, openness));
  const halfGap = HALF_GAP_MIN + t * (HALF_GAP_MAX - HALF_GAP_MIN);
  const gapTop = MID - halfGap;
  const gapBottom = MID + halfGap;
  // Cone half-angle at the sensor side ∝ openness (small aperture = narrow cone).
  const outHalf = 6 + t * 26;
  const scale = width / VIEW_W;

  const bladeFill = '#26262b';
  // hexToRgba instead of 8-digit-hex concat: survives accents that are not 6-digit hex
  // (validation only enforces a non-empty string). Same alphas as before (0x26/0x66).
  const accentSoft = hexToRgba(accent, 0.15); // ~15% alpha
  const accentLine = hexToRgba(accent, 0.4); // ~40% alpha

  // Incoming ray bundle (left) tapers into the slit; outgoing cone diverges to the sensor.
  const incomingTop = useMemo(() => `0,${MID - 34} ${PLATE_X},${gapTop} ${PLATE_X},${gapBottom} 0,${MID + 34}`, [gapTop, gapBottom]);
  const outgoing = useMemo(
    () => `${PLATE_X + PLATE_W},${gapTop} ${VIEW_W},${MID - outHalf} ${VIEW_W},${MID + outHalf} ${PLATE_X + PLATE_W},${gapBottom}`,
    [gapTop, gapBottom, outHalf],
  );

  return (
    <Svg width={width} height={VIEW_H * scale} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
      {/* Barrel rails (lens cross-section outline) */}
      <Line x1={0} y1={RAIL_TOP} x2={VIEW_W} y2={RAIL_TOP} stroke="#3c3c42" strokeWidth={2} />
      <Line x1={0} y1={RAIL_BOTTOM} x2={VIEW_W} y2={RAIL_BOTTOM} stroke="#3c3c42" strokeWidth={2} />

      {/* Light path */}
      <Polygon points={incomingTop} fill={accentSoft} />
      <Polygon points={outgoing} fill={accentSoft} />
      <Line x1={0} y1={MID - 34} x2={PLATE_X} y2={gapTop} stroke={accentLine} strokeWidth={1} />
      <Line x1={0} y1={MID + 34} x2={PLATE_X} y2={gapBottom} stroke={accentLine} strokeWidth={1} />
      <Line x1={PLATE_X + PLATE_W} y1={gapTop} x2={VIEW_W} y2={MID - outHalf} stroke={accentLine} strokeWidth={1} />
      <Line x1={PLATE_X + PLATE_W} y1={gapBottom} x2={VIEW_W} y2={MID + outHalf} stroke={accentLine} strokeWidth={1} />

      {/* Iris blades edge-on: above and below the slit */}
      <Rect x={PLATE_X} y={RAIL_TOP} width={PLATE_W} height={Math.max(0, gapTop - RAIL_TOP)} fill={bladeFill} />
      <Rect
        x={PLATE_X}
        y={gapBottom}
        width={PLATE_W}
        height={Math.max(0, RAIL_BOTTOM - gapBottom)}
        fill={bladeFill}
      />
      {/* Blade edges (the light-cutting surfaces) wear the accent */}
      <Line x1={PLATE_X} y1={gapTop} x2={PLATE_X} y2={gapBottom} stroke={accent} strokeWidth={1.5} />

      {/* Optical axis */}
      <Line
        x1={0}
        y1={MID}
        x2={VIEW_W}
        y2={MID}
        stroke="#ffffff20"
        strokeWidth={0.75}
        strokeDasharray="3 5"
      />

      {label ? (
        <SvgText x={VIEW_W - 6} y={RAIL_TOP + 12} fontSize={11} fontWeight="700" fill="#ffffffaa" textAnchor="end">
          {label}
        </SvgText>
      ) : null}
    </Svg>
  );
};

export default ApertureSideView;
