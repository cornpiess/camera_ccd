import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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
  /**
   * The CURRENT profile's signature (recommended) aperture — variable lenses only.
   * Rendered as a special marker tick on the scale; never shown on fixed lenses.
   */
  readonly signatureAperture?: number | null;
  /** Fired continuously while dragging with the exact f-stop under the finger. */
  readonly onApertureChange: (fStop: number) => void;
  /**
   * Fired ONCE per gesture on release/terminate with the final f-stop — the single
   * hardware commit point. Per-move updates stay UI-only so the native session queue
   * is never flooded with lockForConfiguration commands mid-drag.
   */
  readonly onApertureSettle?: (fStop: number) => void;
  /**
   * TRUE (fixed lens): display-only — iris + real f-value + side view; no tick scale,
   * no drag, no signature marker. FALSE (variable lens): all four elements live.
   */
  readonly fixedMode?: boolean;
  /** Camera identity accent — pointer line, value and iris rim wear the camera skin. */
  readonly accent?: string;
}

const BAR_HEIGHT = 96;
/** Drag distance spanning the whole range — short enough that ƒ/1.5→ƒ/4 is one quick flick. */
const FULL_DRAG_PX = 400;
/** Detent grid: one click per 0.1 f-number (ƒ/1.5 → ƒ/1.6 → …), like a tight lens ring. */
const FSTEPS_PER_TENTH = 10;
/** Ruler-style scale: 48 ticks per stop — previous count halved for controllability,
  * while the minimum tick width stays 1px so spacing reads looser, not denser. */
const TICKS_PER_STOP = 48;
/** Iris glyph size (the aperture hole, far left of the strip). */
const IRIS_SIZE = 44;
const IRIS_LEFT = 8;
/** Side-view cross-section width (shown centered; toggles with the tick scale). */
const SIDE_WIDTH = 170;
/** The tick BASELINE: horizontally level with the iris glyph's center (the aperture hole). */
const TICK_BASELINE = BAR_HEIGHT / 2 - 8; // in trackClip coords (clip starts at top: 8)

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const toLog = (f: number): number => Math.log2(f);
const toF = (log: number): number => Math.pow(2, log);
const formatF = (f: number): string => `ƒ/${f.toFixed(1).replace(/\.0$/, '')}`;

/**
 * The aperture strip — the product's hero control. All elements are bound to the ONE
 * ApertureState and the whole strip is a drag surface. 刻度与侧视图互斥（切换展示）：
 *
 * - Variable lens: [ iris hole ]  ····|·|····  — iris + tick scale (scrolls under the
 *   fixed pointer) + engaged f-value + signature marker. No side view.
 * - Fixed lens: [ iris hole ]  [ side view ]  ƒ/x.x — display-only; no ticks, no drag.
 *
 * - CONTINUOUS (无极): detents are a FEEL only (haptic per 0.1 f-number crossing) —
 *   the value itself never snaps.
 */
export const ApertureBar: React.FC<ApertureBarProps> = ({
  minAperture,
  maxAperture,
  currentAperture,
  isVariableAperture,
  signatureAperture,
  onApertureChange,
  onApertureSettle,
  fixedMode = false,
  accent,
}) => {
  const { width: screenWidth } = useWindowDimensions();
  const topInset = 8;
  const scaleH = BAR_HEIGHT - topInset;
  // 刻度与侧视图互斥（切换展示，永不同框）：默认显示刻度条，轻点条带切换到侧视图；
  // 固定光圈只有侧视图。
  const trackWidth = Math.max(140, SIDE_WIDTH);
  // 刻度窗口与侧视图共用同一个水平居中槽位（宽度和位置都一致）：切换时槽位纹丝
  // 不动，只换内容。左对齐排光圈洞右侧是旧布局，用户已要求居中。
  const trackLeft = (screenWidth - trackWidth) / 2;
  const sideLeft = (screenWidth - SIDE_WIDTH) / 2;
  const lo = Math.min(minAperture, maxAperture);
  const hi = Math.max(minAperture, maxAperture);
  const logLo = toLog(lo);
  const logHi = toLog(hi);
  const span = logHi - logLo || 1;

  /** 0 = stopped down (ƒ/max), 1 = wide open (ƒ/min). Feeds the scroll direction. */
  const openness = clamp(1 - (toLog(currentAperture) - logLo) / span, 0, 1);

  // IRIS HOLE (and side-view cone) use an ABSOLUTE f-number mapping — the same f-stop
  // renders the same hole size on variable AND fixed lenses. Reference span is the
  // project's iPhone 18 Pro iris range (f/1.48–f/4); a per-range normalization would
  // make a fixed lens (whose range is the single mechanical stop) disagree with a
  // variable lens at the same f-number.
  const REF_LOG_LO = toLog(1.48);
  const REF_LOG_SPAN = toLog(4) - REF_LOG_LO;
  const irisOpenness = clamp((toLog(4) - toLog(currentAperture)) / REF_LOG_SPAN, 0, 1);

  // BAND_SCALE = band length in screen widths. History: 3 → 1.5 → 0.75 (twice halved to
  // compress tick spacing), then 1.5 by user decision: at 0.75 the ruler (127.5px) was
  // SHORTER than the 170px window and slid within it — visible tick extent swung between
  // 85–127.5px and never matched the side view's full slot. At 1.5 the ruler (255px)
  // overflows both window edges, so the visible scale fills the slot at EVERY value
  // (real lens-ring-through-a-window look) and tick spacing doubles to ~3.7px/tick.
  const BAND_SCALE = 1.5;
  // Ruler-style tick scale: three sizes per stop —
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
        x: t * trackWidth * BAND_SCALE,
        major,
        half,
        label: major ? String(Number(toF(log).toFixed(1))) : undefined,
      });
    }
    return list;
  }, [logLo, logHi, span, lo, hi, trackWidth]);

  // The band scrolls under the fixed pointer: engaged value always sits at band-x = t*BAND_SPAN,
  // rendered at screen-center via translateX = trackWidth/2 - t*BAND_SPAN.
  const BAND_SPAN = trackWidth * BAND_SCALE;
  const translateX = useRef(new Animated.Value(0)).current;

  /**
   * Damped band motion: the band CHASES the target through a critically-damped spring
   * instead of teleporting 1:1 — heavy, mechanical lens-ring inertia. tRef always holds
   * the TARGET (not the animated value) so the committed f-stop is exact.
   */
  const animateBandTo = useCallback(
    (t: number) => {
      const target = trackWidth / 2 - t * BAND_SPAN;
      Animated.spring(translateX, {
        toValue: target,
        // Snappy chase: high tension = tight response, high friction = no bounce.
        // CONFIG GROUPS ARE MUTEX (RN invariant): tension/friction OR stiffness/damping/
        // mass — never mixed, and `mass` belongs ONLY to the stiffness group. Mixing them
        // throws Invariant Violation at mount = white-screen crash on device (build 57).
        friction: 20,
        tension: 130,
        useNativeDriver: false,
      }).start();
    },
    [translateX, trackWidth, BAND_SPAN],
  );
  const tRef = useRef(0);
  useEffect(() => {
    // JUMP FIX: while the finger owns the ring, native settle echoes / capability
    // reloads push a DIFFERENT f-number through props; animating to it mid-drag is
    // what snapped the band between the scale extremes. The finger wins until release.
    if (draggingRef.current) return;
    const t = 1 - openness; // band coordinate: 0 = wide open end (left), 1 = stopped down
    tRef.current = t;
    animateBandTo(t);
  }, [openness, translateX, animateBandTo]);

  // One detent per 0.1 f-number — the user-felt "咔嗒" grid (ƒ/1.5, ƒ/1.6, … ƒ/4.0).
  const detentIndexFor = useCallback((f: number): number => Math.round(f * FSTEPS_PER_TENTH), []);

  const dragState = useRef({ startOpenness: 0, active: false });
  const lastDetentRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // Mirror for stable reads inside effects/handlers.
  const draggingRef = useRef(false);
  const setDraggingState = (value: boolean) => {
    draggingRef.current = value;
    setDragging(value);
  };

  const interactive = isVariableAperture && hi > lo;
  // 刻度⇄侧视图切换：可变光圈默认刻度，轻点条带切换到侧视图（再点切回）；
  // 固定光圈只有侧视图。两者永不同框、也不空档。
  const [viewMode, setViewMode] = useState<'scale' | 'side'>('scale');
  const sideVisible = !interactive || viewMode === 'side';
  const irisLeft = IRIS_LEFT;

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
          setDraggingState(true);
          lastDetentRef.current = detentIndexFor(dragValuesRef.current.currentAperture);
        },
        onPanResponderMove: (_evt, gestureState) => {
          const v = dragValuesRef.current;
          if (!v.interactive || v.hi <= v.lo) return;
          // dx > 0 (drag right) = ring turns toward open = higher openness = smaller f-number.
          const newOpenness = clamp(dragState.current.startOpenness + gestureState.dx / FULL_DRAG_PX, 0, 1);
          const f = toF(v.logLo + (1 - newOpenness) * v.span);
          // Ring feel: a click per 0.1 f-number crossing, a firmer knock on full stops.
          const detent = detentIndexFor(f);
          if (detent !== lastDetentRef.current) {
            const fullStop = Math.abs(f - toF(Math.round(toLog(f)))) < 1e-6;
            lastDetentRef.current = detent;
            if (fullStop) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
            } else {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            }
          }
          // The band CHASES the finger through the damped spring (target, not 1:1).
          const t = clamp((toLog(f) - v.logLo) / v.span, 0, 1);
          tRef.current = t;
          animateBandTo(t);
          v.onApertureChange(Number(f.toFixed(2)));
        },
        onPanResponderRelease: (_evt, gestureState) => {
          dragState.current.active = false;
          setDraggingState(false);
          // 轻点（几乎没移动）= 刻度⇄侧视图切换；拖动才调光圈。
          if (dragValuesRef.current.interactive && Math.abs(gestureState.dx) < 4 && Math.abs(gestureState.dy) < 4) {
            setViewMode((m) => (m === 'scale' ? 'side' : 'scale'));
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          }
          settleAtLastPosition();
        },
        onPanResponderTerminate: () => {
          dragState.current.active = false;
          setDraggingState(false);
          settleAtLastPosition();
        },
      }),
    [detentIndexFor, animateBandTo],
  );

  return (
    // Whole-strip drag surface: iris hole, side view, tick scale and f-value are all
    // bound to the ONE ApertureState — dragging anywhere adjusts the aperture.
    <View style={styles.bar} pointerEvents="auto" {...(interactive ? panResponder.panHandlers : {})}>
      {/* Side-view cross-section: horizontally centered; the f-value sits to its RIGHT.
          Toggles with the tick scale (tap the strip); fixed lenses only ever see this. */}
      {sideVisible ? (
        <View
          style={[styles.sideSlot, { left: sideLeft, top: (BAR_HEIGHT - (SIDE_WIDTH * 92) / 260) / 2, width: SIDE_WIDTH }]}
          pointerEvents="none"
        >
          <ApertureSideView openness={irisOpenness} accent={accent} width={SIDE_WIDTH} />
        </View>
      ) : null}
      {sideVisible ? (
        <Text
          style={[
            styles.sideValueText,
            { left: sideLeft + SIDE_WIDTH + 12 },
            accent ? { color: accent } : null,
          ]}
          numberOfLines={1}
        >
          {formatF(currentAperture)}
        </Text>
      ) : null}

      {/* Iris: the physical diaphragm (element 1; f/1.4 → big hole; f/4 → tiny hole) */}
      <View style={[styles.iris, { left: irisLeft, top: (BAR_HEIGHT - IRIS_SIZE) / 2 }]} pointerEvents="none">
        <IrisGlyph size={IRIS_SIZE} openness={irisOpenness} accent={accent} />
      </View>

      {/* The tick scale — variable lenses, scale view only; the band scrolls under
          the fixed pointer. */}
      {!sideVisible ? (
        <View style={[styles.trackClip, { left: trackLeft, top: topInset, height: scaleH, width: trackWidth }]}>
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
            {/* Signature (recommended) aperture marker for the CURRENT profile */}
            {(() => {
              const sig = signatureAperture;
              if (typeof sig !== 'number' || !Number.isFinite(sig) || !(hi > lo)) return null;
              const sigLog = toLog(sig);
              if (sigLog < logLo - 1e-6 || sigLog > logHi + 1e-6) return null;
              const x = ((sigLog - logLo) / span) * BAND_SPAN;
              return (
                <View style={[styles.signatureMarker, { left: x }]} pointerEvents="none">
                  {['S', 'I', 'G'].map((ch) => (
                    <Text key={ch} style={[styles.signatureLabel, accent ? { color: accent } : null]}>
                      {ch}
                    </Text>
                  ))}
                  <View style={[styles.signatureTick, accent ? { backgroundColor: accent } : null]} />
                </View>
              );
            })()}
          </Animated.View>
          {/* engaged value rides above the pointer (element 2) */}
          <Text style={[styles.valueText, { top: 3 }, accent ? { color: accent } : null]} numberOfLines={1}>
            {formatF(currentAperture)}
          </Text>
          {/* THE pointer: thin, centered on the tick baseline (= the aperture-hole axis) */}
          <View
            pointerEvents="none"
            style={[styles.pointer, { left: trackWidth / 2 - 0.75 }, accent ? { backgroundColor: accent } : null]}
          />
        </View>
      ) : null}

      {
        // Small mode caption: 真实光圈 = variable iris; 固定光圈 = single mechanical aperture.
        <View
          style={[styles.demoBadge, { right: 10 }, accent ? { borderColor: hexToRgba(accent, 0.55) } : null]}
          pointerEvents="none"
        >
          <Text style={[styles.demoBadgeText, accent ? { color: accent } : null]}>
            {fixedMode ? '固定光圈' : '真实光圈'}
          </Text>
        </View>
      }
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
    // WIDTH IS LOAD-BEARING (passed inline as trackWidth): an absolute container with
    // only absolute children and no explicit width sizes to ZERO, and overflow:hidden
    // then clips the entire scale out of existence.
    overflow: 'hidden',
  },
  band: {
    position: 'absolute',
    top: 0,
    left: 0,
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
  signatureMarker: {
    position: 'absolute',
    bottom: TICK_BASELINE,
    width: 10,
    alignItems: 'center',
  },
  // SIG letters stacked top-to-bottom (horizontal "SIG" read like "S-G" on the band).
  signatureLabel: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 9,
  },
  signatureTick: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#FFFFFF',
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
  sideValueText: {
    position: 'absolute',
    top: (BAR_HEIGHT - 20) / 2,
    fontSize: 20,
    fontWeight: '800',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
  pointer: {
    position: 'absolute',
    // Centered on the tick baseline = the horizontal axis through the aperture hole.
    // (left comes inline: trackWidth / 2 - 0.75)
    top: TICK_BASELINE - 15,
    width: 1.5,
    height: 30,
    borderRadius: 0.75,
    backgroundColor: '#FFFFFF',
  },
  iris: {
    position: 'absolute',
    width: IRIS_SIZE,
    height: IRIS_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  demoBadge: {
    position: 'absolute',
    top: 4,
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
    letterSpacing: 1,
  },
});

export default ApertureBar;
