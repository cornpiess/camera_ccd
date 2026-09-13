import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type CameraIconId = 'ricoh-gr' | 'leica-rangefinder' | 'fuji-rangefinder' | 'canon-compact';

export interface CameraIconProps {
  /** One of CameraIconId; anything else renders the generic camera silhouette. */
  readonly icon?: string | null;
  /** Stroke color — normally the camera's ui.accent so the six cameras stay color-d distinct. */
  readonly accent?: string;
  readonly width?: number;
  /** Defaults to width × 22/32 (the viewBox aspect). */
  readonly height?: number;
}

const VIEW_W = 32;
const VIEW_H = 22;

/**
 * Per-camera-model silhouette icons (line art, no logos / no wordmarks):
 *
 *   ricoh-gr          flat pocket compact — slim body, lens left-of-center, grip band on
 *                     the right edge, no viewfinder bump
 *   leica-rangefinder rounded-top rangefinder — centered lens, small round viewfinder
 *                     window top-left, front dot
 *   fuji-rangefinder  boxy stepped top plate (dial block on the left), large triple-ring
 *                     lens, rectangular viewfinder
 *   canon-compact     compact with pop-up flash raised on the top-left
 *   (fallback)        generic camera rectangle + lens
 *
 * The silhouette is selected by `ui.icon` from camera-profiles.json; the stroke wears the
 * camera's own accent so the selector lists stay color-distinct at a glance.
 */
export function CameraIcon({ icon, accent, width = 20, height }: CameraIconProps): React.JSX.Element {
  const stroke = accent ?? 'rgba(255, 255, 255, 0.8)';
  const w = width;
  const h = height ?? (width * VIEW_H) / VIEW_W;
  const sw = 1.4;
  const fill = 'none';

  let art: React.JSX.Element;
  switch (icon) {
    case 'ricoh-gr':
      art = (
        <>
          <Rect x={2.5} y={6.5} width={27} height={10.5} rx={1.6} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={12.5} cy={11.8} r={3.7} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={12.5} cy={11.8} r={1.2} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Path d="M24.5 6.5 v10.5" stroke={stroke} strokeWidth={sw} fill={fill} />
          <Path d="M26.9 6.5 v10.5" stroke={stroke} strokeWidth={sw} fill={fill} />
          <Rect x={5.2} y={8.4} width={3.2} height={1.3} rx={0.4} stroke={stroke} strokeWidth={sw} fill={fill} />
        </>
      );
      break;
    case 'leica-rangefinder':
      art = (
        <>
          <Path
            d="M3 17 v-6.2 q0-2.7 2.7-2.7 h20.6 q2.7 0 2.7 2.7 v6.2 z"
            stroke={stroke}
            strokeWidth={sw}
            fill={fill}
          />
          <Circle cx={16} cy={12.4} r={4.3} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={16} cy={12.4} r={1.9} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={7.4} cy={10.4} r={1.2} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={24.4} cy={10.2} r={0.8} stroke={stroke} strokeWidth={sw} fill={fill} />
        </>
      );
      break;
    case 'fuji-rangefinder':
      art = (
        <>
          <Path
            d="M2.5 17 v-8.4 h6.5 v-2.4 h5.5 v2.4 h15 v8.4 z"
            stroke={stroke}
            strokeWidth={sw}
            fill={fill}
          />
          <Circle cx={17.5} cy={12.6} r={4.6} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={17.5} cy={12.6} r={2.5} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={17.5} cy={12.6} r={0.8} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Rect x={4.6} y={10.3} width={3} height={2} rx={0.5} stroke={stroke} strokeWidth={sw} fill={fill} />
        </>
      );
      break;
    case 'canon-compact':
      art = (
        <>
          <Rect x={3} y={8.5} width={26} height={10} rx={2} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={14.5} cy={13.5} r={4.3} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={14.5} cy={13.5} r={1.9} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Path
            d="M5.8 8.5 v-2 q0-1 1-1 h4.4 q1 0 1 1 v2"
            stroke={stroke}
            strokeWidth={sw}
            fill={fill}
          />
        </>
      );
      break;
    default:
      art = (
        <>
          <Rect x={3} y={7.5} width={26} height={11} rx={2} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Circle cx={16} cy={13} r={4} stroke={stroke} strokeWidth={sw} fill={fill} />
          <Rect x={6} y={9.5} width={3.4} height={1.8} rx={0.5} stroke={stroke} strokeWidth={sw} fill={fill} />
        </>
      );
  }

  return (
    <Svg width={w} height={h} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
      {art}
    </Svg>
  );
}

export default CameraIcon;
