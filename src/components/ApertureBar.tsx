import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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

const BAR_HEIGHT = 64;
const TRACK_WIDTH = 252;
/** Drag distance that spans the whole range. */
const FULL_DRAG_PX = 170;
/** Physical ring feel: 24 detents across the full travel (≈0.15 stop at ƒ/1.4–ƒ/4). */
const DETENT_COUNT = 24;
/** Iris sits to the LEFT of the track so the pointer line stays exactly on the shutter axis. */
const IRIS_GAP = 14;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const toLog = (f: number): number => Math.log2(f);
const toF = (log: number): number => Math.pow(2, log);
const formatF = (f: number): string => `ƒ/${f.toFixed(1).replace(/\.0$/, '')}`;

/**
 * The aperture ring — the product's hero control, modeled on a real lens ring:
 *
 *   [ iris SVG ]   ····|·|····
 *    hole tracks        ▲ thin accent pointer, EXACTLY on the shutter axis
 *    the ring      (the scale BAND scrolls under the fixed pointer, like a real dial)
 *
 * - CONTINUOUS (无极): the API takes an arbitrary f-number, so the ring is stepless.
 *   Detents are a FEEL only: a haptic tick per crossing (light per detent, rigid per
 *   full stop) without ever snapping the value.
 * - The scale scrolls horizontally under the fixed center pointer (scrolls LEFT when
 *   stopping down, RIGHT when opening) — the mechanical ring read the user asked for.
 * - f/1.4 (wide open) → big hole, ring scrolled fully right; f/4 → tiny hole, scrolled
 *   left. Iris SVG blades open/close with the value (direction verified: smaller
 *   f-number = LARGER hole).
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
  const { width: screenWidth } = useWindowDimensions();
  const lo = Math.min(minAperture, maxAperture);
  const hi = Math.max(minAperture, maxAperture);
  const logLo = toLog(lo);
  const logHi = toLog(hi);
  const span = logHi - logLo || 1;

  /** 0 = stopped down (ƒ/max), 1 = wide open (ƒ/min). Feeds iris hole + scroll direction. */
  const openness = clamp(1 - (toLog(currentAperture) - logLo) / span, 0, 1);

  // Scale band: ticks from 1/6-stop minors to labeled full stops, spread over a band
  // 3× the visible width so the scroll has travel on both sides.
  const BAND_SPAN = TRACK_WIDTH * 3;
  const ticks = useMemo(() => {
    const list: Array<{ key: string; x: number; major: boolean; label?: string }> = [];
    if (!(hi > lo)) return list;
    const firstSixth = Math.ceil(logLo * 6);
    const lastSixth = Math.floor(logHi * 6);
    for (let k = firstSixth; k <= lastSixth; k++) {
      const log = k / 6;
      const t = (log - logLo) / span;
      const major = k % 6 === 0;
      list.push({
        key: `${k}`,
        x: t * BAND_SPAN,
        major,
        label: major ? String(Number(toF(log).toFixed(1))) : undefined,
      });
    }
    return list;
  }, [logLo, logHi, span, lo, hi]);

  // The band scrolls under the fixed pointer: engaged value always sits at band-x = t*BAND_SPAN,
  // rendered at screen-center via translateX = TRACK_WIDTH/2 - t*BAND_SPAN.
  const translateX = useRef(new Animated.Value(0)).current;
  const tRef = useRef(0);
  useEffect(() => {
    const t = 1 - openness; // band coordinate: 0 = wide open end (left), 1 = stopped down
    tRef.current = t;
    translateX.setValue(TRACK_WIDTH / 2 - t * BAND_SPAN);
  }, [openness, translateX]);

  const detentIndexFor = useCallback((f: number): number => {
    const t = clamp((toLog(f) - logLo) / span, 0, 1);
    return Math.round(t * DETENT_COUNT);
  }, [logLo, span]);

  const dragState = useRef({ startOpenness: 0, active: false });
  const lastDetentRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isVariableAperture,
        onMoveShouldSetPanResponder: () => isVariableAperture,
        onPanResponderGrant: () => {
          dragState.current = { startOpenness: openness, active: true };
          setDragging(true);
          lastDetentRef.current = detentIndexFor(currentAperture);
        },
        onPanResponderMove: (_evt, gestureState) => {
          if (!isVariableAperture || hi <= lo) return;
          // dx > 0 (drag right) = ring turns toward open = higher openness = smaller f-number.
          const newOpenness = clamp(dragState.current.startOpenness + gestureState.dx / FULL_DRAG_PX, 0, 1);
          const f = toF(logLo + (1 - newOpenness) * span);
          // Ring feel: a tick per detent crossing, a firmer knock on full stops.
          const detent = detentIndexFor(f);
          if (detent !== lastDetentRef.current) {
            const fullStop = Math.abs(f - toF(Math.round(toLog(f)))) < 1e-6;
            lastDetentRef.current = detent;
            if (fullStop) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => {});
            } else {
              Haptics.selectionAsync().catch(() => {});
            }
          }
          // The band tracks the finger 1:1 while dragging (native-driver transform).
          const t = clamp((toLog(f) - logLo) / span, 0, 1);
          tRef.current = t;
          translateX.setValue(TRACK_WIDTH / 2 - t * BAND_SPAN);
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
    [isVariableAperture, openness, currentAperture, lo, hi, logLo, span, onApertureChange, detentIndexFor, translateX],
  );

  const interactive = isVariableAperture && hi > lo;
  const trackLeft = screenWidth / 2 - TRACK_WIDTH / 2;
  const irisLeft = trackLeft - 44 - IRIS_GAP;

  return (
    <View style={styles.bar} pointerEvents="box-none">
      {/* Iris: the physical diaphragm (f/1.4 → big hole; f/4 → tiny hole) */}
      <View style={[styles.iris, { left: irisLeft }]} pointerEvents="none">
        <IrisGlyph size={44} openness={interactive ? openness : 0.55} accent={accent} />
      </View>

      {/* The scale band scrolls under the fixed pointer (pointer == shutter axis) */}
      <View style={[styles.trackClip, { left: trackLeft }]} {...(interactive ? panResponder.panHandlers : {})}>
        <Animated.View style={[styles.band, { transform: [{ translateX }] }]} pointerEvents="none">
          {interactive
            ? ticks.map((tick) => (
                <View key={tick.key} style={[styles.tickSlot, { left: tick.x }]}>
                  <View
                    style={[
                      styles.tick,
                      tick.major && styles.tickMajor,
                      dragging && styles.tickBright,
                    ]}
                  />
                  {tick.label ? <Text style={styles.tickLabel}>{tick.label}</Text> : null}
                </View>
              ))
            : null}
        </Animated.View>
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
    height: BAR_HEIGHT,
    width: '100%',
  },
  iris: {
    position: 'absolute',
    top: (BAR_HEIGHT - 44) / 2,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackClip: {
    position: 'absolute',
    top: 0,
    height: BAR_HEIGHT,
    overflow: 'hidden',
  },
  band: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: BAR_HEIGHT,
    width: TRACK_WIDTH * 3,
  },
  tickSlot: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    alignItems: 'center',
  },
  tick: {
    marginTop: BAR_HEIGHT - 20,
    width: 1,
    height: 5,
    borderRadius: 0.5,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  tickMajor: {
    width: 1.5,
    height: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  tickBright: {
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
  },
  tickLabel: {
    position: 'absolute',
    bottom: 6,
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  valueText: {
    position: 'absolute',
    top: 4,
    left: 0,
    right: 0,
    textAlign: 'center',
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  pointer: {
    position: 'absolute',
    top: BAR_HEIGHT - 24,
    bottom: 8,
    left: TRACK_WIDTH / 2 - 0.75,
    width: 1.5,
    borderRadius: 0.75,
    backgroundColor: '#FFFFFF',
  },
  caption: {
    position: 'absolute',
    right: 10,
    bottom: 2,
    color: 'rgba(255, 255, 255, 0.4)',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
  },
});

export default ApertureBar;
