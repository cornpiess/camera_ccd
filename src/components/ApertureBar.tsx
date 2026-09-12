import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { hexToRgba } from '../theme/skin';
import { IrisGlyph } from './IrisGlyph';

export interface ApertureBarProps {
  /** Continuous hardware range lower bound (wide open, smallest f-number). */
  readonly minAperture: number;
  /** Continuous hardware range upper bound (stopped down). */
  readonly maxAperture: number;
  /** Displayed f-stop (hardware-confirmed or optimistic). Continuous. */
  readonly currentAperture: number;
  readonly isVariableAperture: boolean;
  /** Fired continuously while dragging with the exact f-stop under the finger. */
  readonly onApertureChange: (fStop: number) => void;
  /**
   * Demo mode (fixed-lens devices, on by default): the ring is fully draggable for the
   * feel, but the capture stays at the lens's fixed aperture. Always labeled DEMO so the
   * simulation can never be mistaken for hardware control.
   */
  readonly demoMode?: boolean;
  /** Camera identity accent — pointer line, value and iris rim wear the camera skin. */
  readonly accent?: string;
}

const BAR_HEIGHT = 56;
const TRACK_WIDTH = 250;
/** Drag distance that spans the whole range. */
const FULL_DRAG_PX = 160;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const toLog = (f: number): number => Math.log2(f);
const toF = (log: number): number => Math.pow(2, log);
const formatF = (f: number): string => `ƒ/${f.toFixed(1).replace(/\.0$/, '')}`;

/**
 * The aperture ring — the product's hero control, modeled on a real lens:
 *
 *   [ iris SVG ]   ƒ/2.8   |·|·|·||·|·|·||  (1/3-stop scale, continuous)
 *    hole tracks                    ─────────
 *    the ring                       thin centered pointer (camera accent)
 *
 * - CONTINUOUS (无极): the underlying API takes an arbitrary f-number
 *   (setExposureModeCustom(lensAperture:) on iOS 27; recommended stops are hints, not
 *   limits), so the ring is stepless. Haptic ticks fire on 1/3-stop crossings for
 *   tactility without snapping.
 * - Drag RIGHT = open up (toward the smaller f-number), like turning a real ring.
 * - Fixed-aperture hardware renders the locked state, honestly labeled FIXED; demo mode
 *   is fully interactive but labeled DEMO and never touches the capture.
 */
export const ApertureBar: React.FC<ApertureBarProps> = ({
  minAperture,
  maxAperture,
  currentAperture,
  isVariableAperture,
  onApertureChange,
  demoMode = false,
  accent,
}) => {
  const lo = Math.min(minAperture, maxAperture);
  const hi = Math.max(minAperture, maxAperture);
  const logLo = toLog(lo);
  const logHi = toLog(hi);

  const openness = clamp((toLog(currentAperture) - logLo) / (logHi - logLo || 1), 0, 1);

  // Scale ticks: every 1/3 stop across the continuous range; full stops get labels.
  const ticks = useMemo(() => {
    const list: Array<{ key: string; t: number; major: boolean; label?: string }> = [];
    if (!(hi > lo)) return list;
    const firstThird = Math.ceil(logLo * 3);
    const lastThird = Math.floor(logHi * 3);
    for (let k = firstThird; k <= lastThird; k++) {
      const log = k / 3;
      const t = (log - logLo) / (logHi - logLo);
      const major = k % 3 === 0;
      list.push({
        key: `${k}`,
        t: clamp(t, 0, 1),
        major,
        label: major ? String(Number(toF(log).toFixed(1))) : undefined,
      });
    }
    return list;
  }, [logLo, logHi, lo, hi]);

  const dragState = useRef({ startT: 0, active: false });
  const lastTickRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const tickIndexFor = useCallback(
    (f: number): number => Math.round(toLog(f) * 3),
    [],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isVariableAperture,
        onMoveShouldSetPanResponder: () => isVariableAperture,
        onPanResponderGrant: () => {
          dragState.current = { startT: openness, active: true };
          setDragging(true);
          lastTickRef.current = tickIndexFor(currentAperture);
        },
        onPanResponderMove: (_evt, gestureState) => {
          if (!isVariableAperture || hi <= lo) return;
          // dx > 0 (drag right) = open up = toward the smaller f-number = lower log value.
          const deltaT = -gestureState.dx / FULL_DRAG_PX;
          const t = clamp(dragState.current.startT + deltaT, 0, 1);
          const f = toF(logLo + t * (logHi - logLo));
          const tick = tickIndexFor(f);
          if (tick !== lastTickRef.current) {
            lastTickRef.current = tick;
            Haptics.selectionAsync().catch(() => {});
          }
          onApertureChange(Number(f.toFixed(2)));
        },
        onPanResponderRelease: () => {
          dragState.current.active = false;
          setDragging(false);
        },
        onPanResponderTerminate: () => {
          dragState.current.active = false;
          setDragging(false);
        },
      }),
    [isVariableAperture, openness, currentAperture, lo, hi, logLo, logHi, onApertureChange, tickIndexFor],
  );

  const interactive = isVariableAperture && hi > lo;

  return (
    <View style={styles.bar} pointerEvents="box-none">
      {/* Iris: the physical diaphragm, opening/closing with the ring */}
      <View style={styles.iris} pointerEvents="none">
        <IrisGlyph size={44} openness={interactive ? openness : 0.55} accent={accent} />
      </View>

      {/* Continuous scale track with the thin centered pointer (camera accent) */}
      <View style={styles.trackClip} {...(interactive ? panResponder.panHandlers : {})}>
        {/* scale ticks */}
        {interactive
          ? ticks.map((tick) => (
              <View
                key={tick.key}
                pointerEvents="none"
                style={[
                  styles.tick,
                  tick.major ? styles.tickMajor : null,
                  { left: tick.t * TRACK_WIDTH },
                  dragging ? styles.tickBright : null,
                ]}
              />
            ))
          : null}
        {/* engaged value rides above the pointer */}
        <Text style={[styles.valueText, accent ? { color: accent } : null]} numberOfLines={1}>
          {formatF(currentAperture)}
        </Text>
        {/* THE pointer: thin, exactly centered, camera accent */}
        <View
          pointerEvents="none"
          style={[styles.pointer, accent ? { backgroundColor: accent } : null]}
        />
      </View>

      {(!isVariableAperture || demoMode) ? (
        <Text style={[styles.caption, demoMode && accent ? { color: accent } : null]}>
          {demoMode ? 'DEMO' : 'FIXED'}
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    height: BAR_HEIGHT,
  },
  iris: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackClip: {
    width: TRACK_WIDTH,
    height: BAR_HEIGHT,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  tick: {
    position: 'absolute',
    bottom: Math.round(BAR_HEIGHT / 2) - 11,
    width: 1,
    height: 5,
    borderRadius: 0.5,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  tickMajor: {
    height: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  tickBright: {
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
  },
  valueText: {
    position: 'absolute',
    top: 2,
    left: 0,
    right: 0,
    textAlign: 'center',
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  pointer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: TRACK_WIDTH / 2 - 0.75,
    width: 1.5,
    borderRadius: 0.75,
    backgroundColor: '#FFFFFF',
  },
  caption: {
    position: 'absolute',
    right: 6,
    bottom: 0,
    color: 'rgba(255, 255, 255, 0.4)',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
  },
});

export default ApertureBar;
