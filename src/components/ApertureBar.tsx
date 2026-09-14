import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { hexToRgba } from '../theme/skin';
import { IrisGlyph } from './IrisGlyph';
import { ApertureSideView } from './ApertureSideView';

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
   * Fired ONCE per gesture on release/terminate with the final f-stop — the single
   * hardware commit point. Per-move updates stay UI-only so the native session queue
   * is never flooded with lockForConfiguration commands mid-drag.
   */
  readonly onApertureSettle?: (fStop: number) => void;
  /**
   * Demo mode (fixed-lens devices, on by default): the ring is fully draggable for the
   * feel, but the capture stays at the lens's fixed aperture. Always labeled DEMO so the
   * simulation can never be mistaken for hardware control.
   */
  readonly demoMode?: boolean;
  /** Camera identity accent — pointer line, value and iris rim wear the camera skin. */
  readonly accent?: string;
  /**
   * Developer-mode extra: show the side-view lens cross-section above the tick scale.
   * OFF by default — the tick scale alone is the control.
   */
  readonly sideViewEnabled?: boolean;
  /** Switch between the tick scale and the side view (the strip's top-right button). */
  readonly onToggleSideView?: () => void;
}

const BAR_HEIGHT = 96;
const TRACK_WIDTH = 252;
/** Drag distance that spans the whole range — deliberately long for a damped, heavy ring feel. */
const FULL_DRAG_PX = 640;
/** Scale band: 3× the visible width so the scroll has travel on both sides. */
const BAND_SPAN = TRACK_WIDTH * 3;
/** Physical ring feel: 24 detents across the full travel (≈0.15 stop at ƒ/1.4–ƒ/4). */
const DETENT_COUNT = 24;
/** Ruler-style scale: 48 ticks per stop — every 1/48 stop, ruler-dense. */
const TICKS_PER_STOP = 48;
/** The tick BASELINE: horizontally level with the iris glyph's center (the aperture hole). */
const TICK_BASELINE = BAR_HEIGHT / 2 - 8; // in trackClip coords (clip starts at top: 8)
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
  onApertureSettle,
  demoMode = false,
  accent,
  sideViewEnabled = false,
  onToggleSideView,
}) => {
  const { width: screenWidth } = useWindowDimensions();
  const topInset = 8;
  const scaleH = BAR_HEIGHT - topInset;
  const lo = Math.min(minAperture, maxAperture);
  const hi = Math.max(minAperture, maxAperture);
  const logLo = toLog(lo);
  const logHi = toLog(hi);
  const span = logHi - logLo || 1;

  /** 0 = stopped down (ƒ/max), 1 = wide open (ƒ/min). Feeds iris hole + scroll direction. */
  const openness = clamp(1 - (toLog(currentAperture) - logLo) / span, 0, 1);

  // Ruler-style tick scale, dense like a straight ruler: three sizes per stop —
  //   full stop  (k % 48 === 0): tallest, labeled
  //   half stop  (k % 24 === 0): medium
  //   1/48 stop  (everything else): small
  const ticks = useMemo(() => {
    const list: { key: string; x: number; major: boolean; half: boolean; label?: string }[] = [];
    if (!(hi > lo)) return list;
    const firstTick = Math.ceil(logLo * TICKS_PER_STOP);
    const lastTick = Math.floor(logHi * TICKS_PER_STOP);
    for (let k = firstTick; k <= lastTick; k++) {
      const log = k / TICKS_PER_STOP;
      const t = (log - logLo) / span;
      const major = k % TICKS_PER_STOP === 0;
      const half = k % (TICKS_PER_STOP / 2) === 0;
      list.push({
        key: `${k}`,
        x: t * BAND_SPAN,
        major,
        half,
        label: major ? String(Number(toF(log).toFixed(1))) : undefined,
      });
    }
    return list;
  }, [logLo, logHi, span, lo, hi]);

  // The band scrolls under the fixed pointer: engaged value always sits at band-x = t*BAND_SPAN,
  // rendered at screen-center via translateX = TRACK_WIDTH/2 - t*BAND_SPAN.
  const translateX = useRef(new Animated.Value(0)).current;

  /**
   * Damped band motion: the band CHASES the target through a critically-damped spring
   * instead of teleporting 1:1 — heavy, mechanical lens-ring inertia. tRef always holds
   * the TARGET (not the animated value) so the committed f-stop is exact.
   */
  const animateBandTo = useCallback(
    (t: number) => {
      const target = TRACK_WIDTH / 2 - t * BAND_SPAN;
      Animated.spring(translateX, {
        toValue: target,
        // Nearly critical damping: follows the finger with a short, heavy lag, no bounce.
        // CONFIG GROUPS ARE MUTEX (RN invariant): tension/friction OR stiffness/damping/
        // mass — never mixed, and `mass` belongs ONLY to the stiffness group. Mixing them
        // throws Invariant Violation at mount = white-screen crash on device (build 57).
        friction: 18,
        tension: 90,
        useNativeDriver: false,
      }).start();
    },
    [translateX],
  );
  const tRef = useRef(0);
  useEffect(() => {
    const t = 1 - openness; // band coordinate: 0 = wide open end (left), 1 = stopped down
    tRef.current = t;
    animateBandTo(t);
  }, [openness, translateX, animateBandTo]);

  const detentIndexFor = useCallback((f: number): number => {
    const t = clamp((toLog(f) - logLo) / span, 0, 1);
    return Math.round(t * DETENT_COUNT);
  }, [logLo, span]);

  const dragState = useRef({ startOpenness: 0, active: false });
  const lastDetentRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const interactive = isVariableAperture && hi > lo;
  const trackLeft = screenWidth / 2 - TRACK_WIDTH / 2;
  const irisLeft = trackLeft - 44 - IRIS_GAP;
  // Side mode (sideViewEnabled): the cross-section replaces the scale, centered on the
  // strip's middle line (level with the iris glyph). Width caps so it never reaches the
  // iris (left) or the mode button (right).
  const sideMode = interactive && sideViewEnabled;
  const sideWidth = Math.min(204, screenWidth - 170);
  const sideViewHeight = (sideWidth * 92) / 260;
  const sideLeft = (screenWidth - sideWidth) / 2;

  // Live values via refs: the PanResponder must be created ONCE per aperture range. It
  // used to rebuild on EVERY currentAperture/openness change (i.e. every drag update),
  // and a fresh PanResponder resets its internal gestureState.dx accumulation — the
  // computed f-stop snapped back to the grab point each frame ("the ring won't drag").
  const dragValuesRef = useRef({ openness, currentAperture, onApertureChange, onApertureSettle, interactive, lo, hi, logLo, span });
  dragValuesRef.current = { openness, currentAperture, onApertureChange, onApertureSettle, interactive, lo, hi, logLo, span };

  /** One hardware commit per gesture: re-derive the f-stop from the band's last position. */
  const settleAtLastPosition = () => {
    const v = dragValuesRef.current;
    if (!v.interactive || v.hi <= v.lo) return;
    const t = clamp(tRef.current, 0, 1);
    v.onApertureSettle?.(Number(toF(v.logLo + (1 - t) * v.span).toFixed(2)));
  };


  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => dragValuesRef.current.interactive,
        onMoveShouldSetPanResponder: () => dragValuesRef.current.interactive,
        onPanResponderGrant: () => {
          dragState.current = { startOpenness: dragValuesRef.current.openness, active: true };
          setDragging(true);
          lastDetentRef.current = detentIndexFor(dragValuesRef.current.currentAperture);
        },
        onPanResponderMove: (_evt, gestureState) => {
          const v = dragValuesRef.current;
          if (!v.interactive || v.hi <= v.lo) return;
          // dx > 0 (drag right) = ring turns toward open = higher openness = smaller f-number.
          const newOpenness = clamp(dragState.current.startOpenness + gestureState.dx / FULL_DRAG_PX, 0, 1);
          const f = toF(v.logLo + (1 - newOpenness) * v.span);
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
          // The band CHASES the finger through the damped spring (target, not 1:1).
          const t = clamp((toLog(f) - v.logLo) / v.span, 0, 1);
          tRef.current = t;
          animateBandTo(t);
          v.onApertureChange(Number(f.toFixed(2)));
        },
        onPanResponderRelease: () => {
          dragState.current.active = false;
          setDragging(false);
          settleAtLastPosition();
        },
        onPanResponderTerminate: () => {
          dragState.current.active = false;
          setDragging(false);
          settleAtLastPosition();
        },
      }),
    [detentIndexFor, animateBandTo],
  );

  return (
    // Whole-bar drag surface (pointerEvents auto): the strip BETWEEN the finder and the
    // shutter is the aperture control. Two visuals, switched by the mode button at the
    // top-right: the tick scale (default) or the side-view cross-section, which sits
    // VERTICALLY LEVEL with the iris glyph (both centered on the strip's middle line).
    // Children that must not grab touches are pointerEvents="none".
    <View style={styles.bar} pointerEvents="auto" {...(interactive ? panResponder.panHandlers : {})}>
      {/* Side-view cross-section (side mode): level with the iris glyph's center line */}
      {sideMode ? (
        <View
          style={[styles.sideSlot, { left: sideLeft, top: (BAR_HEIGHT - sideViewHeight) / 2, width: sideWidth }]}
          pointerEvents="none"
        >
          <ApertureSideView openness={openness} accent={accent} label={formatF(currentAperture)} width={sideWidth} />
        </View>
      ) : null}

      {/* Iris: the physical diaphragm (f/1.4 → big hole; f/4 → tiny hole) */}
      <View style={[styles.iris, { left: irisLeft, top: (BAR_HEIGHT - 44) / 2 }]} pointerEvents="none">
        <IrisGlyph size={44} openness={interactive ? openness : 0.55} accent={accent} />
      </View>

      {/* The tick scale (scale mode) — ruler ticks sit on a baseline LEVEL with the
          iris glyph's center; the band scrolls under the fixed pointer (shutter axis). */}
      {!sideMode ? (
        <View style={[styles.trackClip, { left: trackLeft, top: topInset, height: scaleH }]}>
          <Animated.View style={[styles.band, { height: scaleH, transform: [{ translateX }] }]} pointerEvents="none">
            {ticks.map((tick) => (
              <View key={tick.key} style={[styles.tickSlot, { left: tick.x }]}>
                {tick.label ? <Text style={styles.tickLabel}>{tick.label}</Text> : null}
                <View
                  style={[
                    styles.tick,
                    tick.major && styles.tickMajor,
                    !tick.major && tick.half && styles.tickHalf,
                    dragging && styles.tickBright,
                  ]}
                />
              </View>
            ))}
          </Animated.View>
          {/* engaged value rides above the pointer */}
          <Text style={[styles.valueText, { top: 3 }, accent ? { color: accent } : null]} numberOfLines={1}>
            {formatF(currentAperture)}
          </Text>
          {/* THE pointer: thin, centered on the tick baseline (= the aperture-hole axis) */}
          <View
            pointerEvents="none"
            style={[styles.pointer, accent ? { backgroundColor: accent } : null]}
          />
        </View>
      ) : null}

      {/* Mode switch: tap to swap between tick scale and side view */}
      {onToggleSideView ? (
        <TouchableOpacity
          accessibilityLabel={sideMode ? '切换到光圈刻度' : '切换到光圈侧视图'}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onToggleSideView}
          style={styles.modeButton}
        >
          <Text style={[styles.modeButtonText, accent ? { color: accent, borderColor: hexToRgba(accent, 0.55) } : null]}>
            {sideMode ? '刻度' : '侧视'}
          </Text>
        </TouchableOpacity>
      ) : null}

      {(!isVariableAperture || demoMode) ? (
        <View
          style={[styles.demoBadge, { left: irisLeft }, demoMode && accent ? { borderColor: hexToRgba(accent, 0.55) } : null]}
          pointerEvents="none"
        >
          <Text style={[styles.demoBadgeText, demoMode && accent ? { color: accent } : null]}>
            {demoMode ? 'DEMO' : 'FIXED'}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    height: BAR_HEIGHT,
    width: '100%',
  },
  sideSlot: {
    position: 'absolute',
    justifyContent: 'center',
  },
  trackClip: {
    position: 'absolute',
    // WIDTH IS LOAD-BEARING: an absolute container with only absolute children and no
    // explicit width sizes to ZERO, and overflow:hidden then clips the entire scale
    // (ticks/value/pointer) out of existence.
    width: TRACK_WIDTH,
    overflow: 'hidden',
  },
  band: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: TRACK_WIDTH * 3,
  },
  tickSlot: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  // RULER LAYOUT: every tick's BASE sits exactly on TICK_BASELINE — the horizontal line
  // through the iris glyph's center (the aperture hole) — so ticks and hole are level.
  // Ticks grow UPWARD from the baseline (marginBottom lifts the base); labels stack
  // directly above their major tick.
  tick: {
    marginBottom: TICK_BASELINE,
    width: 1,
    height: 7,
    borderRadius: 0.5,
    backgroundColor: 'rgba(255, 255, 255, 0.30)',
  },
  tickMajor: {
    width: 2,
    height: 18,
    borderRadius: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.85)',
  },
  tickHalf: {
    width: 1.5,
    height: 12,
    borderRadius: 0.75,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  tickBright: {
    backgroundColor: 'rgba(255, 255, 255, 1)',
  },
  tickLabel: {
    marginBottom: 3,
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  valueText: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  pointer: {
    position: 'absolute',
    // Centered on the tick baseline = the horizontal axis through the aperture hole.
    top: TICK_BASELINE - 15,
    left: TRACK_WIDTH / 2 - 0.75,
    width: 1.5,
    height: 30,
    borderRadius: 0.75,
    backgroundColor: '#FFFFFF',
  },
  iris: {
    position: 'absolute',
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButton: {
    position: 'absolute',
    top: 4,
    right: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  modeButtonText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  demoBadge: {
    position: 'absolute',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  demoBadgeText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
});

export default ApertureBar;
