import React, { useMemo } from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

export interface IrisGlyphProps {
  /** Rendered size in points (square). */
  readonly size: number;
  /** 0 = fully stopped down (tiny hole), 1 = wide open. Continuous. */
  readonly openness: number;
  /** Accent tint for the blade edges (camera skin); blades themselves stay dark metal. */
  readonly accent?: string;
}

const BLADES = 5;
const VIEW = 100;
const CENTER = VIEW / 2;
const RIM_RADIUS = 47;
const RIM_STROKE = 3;

function polar(radius: number, angleRad: number): [number, number] {
  return [CENTER + radius * Math.cos(angleRad), CENTER + radius * Math.sin(angleRad)];
}

/**
 * A parametric camera iris (the diaphragm icon on a real lens): five overlapping blades
 * whose inner tips sweep inward/outward with the f-stop, plus a slight blade rotation as
 * the ring turns — the way a real manual aperture ring feels under the fingers.
 *
 * Each blade is a curved wedge: an arc along the rim, then a straight edge down to the
 * inner aperture tip, then back along the rim. The inner tips of all N blades form a
 * regular N-gon aperture of radius `holeRadius`, which scales with `openness`.
 */
export const IrisGlyph: React.FC<IrisGlyphProps> = ({ size, openness, accent }) => {
  const t = Math.min(1, Math.max(0, openness));
  const holeRadius = 5 + t * 31;
  // Blades counter-rotate slightly as the aperture opens (real irises pivot on screws).
  const spin = (1 - t) * 0.55;
  const tipShift = 0.35 + (1 - t) * 0.5;
  const rimSpan = (Math.PI * 2) / BLADES;

  const bladePaths = useMemo(() => {
    const paths: string[] = [];
    for (let i = 0; i < BLADES; i++) {
      const start = i * rimSpan + spin;
      const arcEnd = start + rimSpan * 0.92;
      const [ax, ay] = polar(RIM_RADIUS, start);
      const [bx, by] = polar(RIM_RADIUS, arcEnd);
      const [tx, ty] = polar(holeRadius, arcEnd + tipShift);
      paths.push(
        `M ${ax.toFixed(2)} ${ay.toFixed(2)} ` +
        `A ${RIM_RADIUS} ${RIM_RADIUS} 0 0 1 ${bx.toFixed(2)} ${by.toFixed(2)} ` +
        `L ${tx.toFixed(2)} ${ty.toFixed(2)} Z`,
      );
    }
    return paths;
  }, [holeRadius, spin, tipShift, rimSpan]);

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`}>
      {/* Barrel */}
      <Circle cx={CENTER} cy={CENTER} r={RIM_RADIUS} fill="rgba(12, 12, 14, 0.92)" />
      {bladePaths.map((d, i) => (
        <Path
          key={i}
          d={d}
          fill="rgba(46, 46, 52, 0.96)"
          stroke={accent ? `${accent}55` : 'rgba(255, 255, 255, 0.14)'}
          strokeWidth={0.8}
        />
      ))}
      {/* Rim ring on top so blade seams stay inside the barrel */}
      <Circle
        cx={CENTER}
        cy={CENTER}
        r={RIM_RADIUS - RIM_STROKE / 2}
        fill="none"
        stroke={accent ?? 'rgba(255, 255, 255, 0.5)'}
        strokeWidth={RIM_STROKE}
      />
    </Svg>
  );
};

export default IrisGlyph;
