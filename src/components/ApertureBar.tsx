import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { hexToRgba } from '../theme/skin';

export interface ApertureBarProps {
  /** Hardware stops in ascending order (f/1.48 … f/4). Empty on fixed-aperture lenses. */
  readonly availableApertures: readonly number[];
  /** Displayed f-stop (hardware-confirmed or optimistic). */
  readonly currentAperture: number;
  readonly isVariableAperture: boolean;
  /** Fired on each detent crossing and again on release-snap (only when variable). */
  readonly onApertureChange: (fStop: number) => void;
  /**
   * Demo mode (fixed-lens devices, on by default): the ring is fully interactive for the
   * wheel feel, but the capture stays at the lens's fixed aperture. Always labeled DEMO
   * so the simulation can never be mistaken for hardware control.
   */
  readonly demoMode?: boolean;
  /** Camera identity accent — pointer, engaged stop and iris ring wear the camera skin. */
  readonly accent?: string;
}

const WHEEL_WIDTH = 210;
const BAR_HEIGHT = 46;
const STOP_SPACING = 58;
/** Drag distance that equals one detent; fast swipes cross multiple stops. */
const DETENT_PX = 26;

const formatF = (f: number): string => `ƒ/${f.toFixed(2).replace(/0$/, '')}`;

/**
 * Aperture bar — the horizontal mechanical ring from a real lens, rendered as:
 *
 *   [ iris glyph ]   f/1.48   f/1.8   f/2   f/2.8   f/4
 *      hole grows ←                     → hole shrinks
 *
 * - Left: an iris whose opening scales with the physical aperture (wide open = big hole).
 * - Right: the ring wheel seen from the side — the stop under the center pointer is the
 *   sharp, enlarged one; neighbours fade and shrink (depth-of-field look).
 * - Interaction: horizontal drag with detents (26 px per 1/3-stop class stop), selection
 *   haptic per detent, snap-to-nearest on release. Drag RIGHT = open up (smaller f-number).
 * - Fixed-aperture lenses render a dimmed, locked bar showing `ƒ/x · FIXED` (honesty: the
 *   physical ring does not exist there, so it must not pretend to move).
 */
export const ApertureBar: React.FC<ApertureBarProps> = ({
  availableApertures,
  currentAperture,
  isVariableAperture,
  onApertureChange,
  demoMode = false,
  accent,
}) => {
  const stops = availableApertures;
  const selectedIndex = useMemo(() => {
    if (stops.length === 0) return 0;
    let best = 0;
    for (let i = 1; i < stops.length; i++) {
      if (Math.abs(stops[i]! - currentAperture) < Math.abs(stops[best]! - currentAperture)) best = i;
    }
    return best;
  }, [stops, currentAperture]);

  // Wheel translation: stop i sits under the center pointer when x = -i * STOP_SPACING.
  const translateX = useRef(new Animated.Value(-selectedIndex * STOP_SPACING)).current;
  const wheelXRef = useRef(-selectedIndex * STOP_SPACING);
  const dragRemainderRef = useRef(0);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (draggingRef.current) return;
    wheelXRef.current = -selectedIndex * STOP_SPACING;
    Animated.spring(translateX, {
      toValue: wheelXRef.current,
      useNativeDriver: true,
      friction: 9,
      tension: 140,
    }).start();
  }, [selectedIndex, translateX]);

  const stepTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(stops.length - 1, index));
      if (clamped === selectedIndex) return;
      Haptics.selectionAsync().catch(() => {});
      onApertureChange(stops[clamped]!);
    },
    [onApertureChange, selectedIndex, stops],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isVariableAperture && stops.length > 1,
        onMoveShouldSetPanResponder: () => isVariableAperture && stops.length > 1,
        onPanResponderGrant: () => {
          draggingRef.current = true;
          setDragging(true);
          dragRemainderRef.current = 0;
        },
        onPanResponderMove: (_evt, gestureState) => {
          if (!isVariableAperture || stops.length < 2) return;
          // dx>0 (drag right) = open up = toward lower f-number = lower index.
          const total = gestureState.dx + dragRemainderRef.current;
          const steps = Math.trunc(total / DETENT_PX);
          if (steps === 0) return;
          dragRemainderRef.current = total - steps * DETENT_PX;
          const next = Math.max(0, Math.min(stops.length - 1, selectedIndex - steps));
          // Free wheel follow while crossing detents: content tracks the finger.
          wheelXRef.current = -next * STOP_SPACING;
          translateX.setValue(wheelXRef.current);
          stepTo(next);
        },
        onPanResponderRelease: () => {
          draggingRef.current = false;
          setDragging(false);
          // Snap hard to the engaged stop — never rest between detents.
          wheelXRef.current = -selectedIndex * STOP_SPACING;
          Animated.spring(translateX, {
            toValue: wheelXRef.current,
            useNativeDriver: true,
            friction: 8,
            tension: 160,
          }).start();
        },
      }),
    [isVariableAperture, selectedIndex, stepTo, stops, translateX],
  );

  // Iris opening: 1 = wide open (first stop), 0 = fully stopped down.
  const openness = stops.length > 1 ? 1 - selectedIndex / (stops.length - 1) : 0.55;
  const holeSize = isVariableAperture ? 9 + openness * 15 : 11;

  return (
    <View style={styles.bar} pointerEvents="box-none">
      {/* Iris glyph: physical aperture cross-section, hole grows/shrinks with the ring */}
      <View style={styles.iris} pointerEvents="none">
        <View style={[styles.irisRing, accent ? { borderColor: hexToRgba(accent, 0.55) } : null]}>
          <View
            style={[
              styles.irisHole,
              accent && !isVariableAperture ? null : { backgroundColor: accent ?? 'rgba(255, 255, 255, 0.9)' },
              { width: holeSize, height: holeSize, borderRadius: holeSize / 2, opacity: isVariableAperture ? 0.95 : 0.4 },
            ]}
          />
        </View>
      </View>

      {/* Ring wheel: center stop sharp, neighbours fade/shrink (side view of a lens ring) */}
      <View
        style={[styles.wheelClip, !isVariableAperture && styles.wheelLocked]}
        {...(isVariableAperture && stops.length > 1 ? panResponder.panHandlers : {})}
      >
        <Animated.View
          style={[styles.wheelTrack, { transform: [{ translateX }], width: WHEEL_WIDTH + stops.length * STOP_SPACING }]}
        >
          {stops.map((f, i) => {
            const distance = Math.abs(i - selectedIndex);
            const focused = distance === 0;
            return (
              <View key={f} style={styles.stopSlot}>
                {/* Tick mark above the value, like a lens ring scale */}
                <View style={[styles.tick, (focused || dragging) && styles.tickBright]} />
                <Text
                  style={[
                    styles.stopLabel,
                    focused && styles.stopLabelFocused,
                    focused && accent ? { color: accent } : null,
                    !focused && { opacity: Math.max(0.18, 0.65 - distance * 0.22), fontSize: Math.max(10, 14 - distance * 2) },
                  ]}
                  numberOfLines={1}
                >
                  {formatF(f)}
                </Text>
              </View>
            );
          })}
        </Animated.View>
        {/* Center pointer */}
        <View
          style={[styles.centerPointer, accent ? { backgroundColor: hexToRgba(accent, 0.9) } : null]}
          pointerEvents="none"
        />
      </View>

      {(!isVariableAperture || demoMode) ? (
        <Text style={[styles.fixedCaption, demoMode && styles.demoCaption, demoMode && accent ? { color: accent } : null]}>
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
    gap: 12,
    height: BAR_HEIGHT,
  },
  iris: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  irisRing: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.4)',
    backgroundColor: 'rgba(10, 10, 10, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  irisHole: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  wheelClip: {
    width: WHEEL_WIDTH,
    height: BAR_HEIGHT,
    overflow: 'hidden',
    alignItems: 'center',
  },
  wheelLocked: {
    opacity: 0.5,
  },
  wheelTrack: {
    position: 'absolute',
    left: 0,
    height: BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  stopSlot: {
    width: STOP_SPACING,
    height: BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tick: {
    width: 1.5,
    height: 5,
    borderRadius: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  tickBright: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  stopLabel: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  stopLabelFocused: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    opacity: 1,
  },
  centerPointer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: 'rgba(255, 214, 10, 0.85)',
    borderRadius: 1,
  },
  fixedCaption: {
    position: 'absolute',
    right: 6,
    bottom: 0,
    color: 'rgba(255, 255, 255, 0.4)',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
  },
  demoCaption: {
    color: 'rgba(255, 214, 10, 0.85)',
  },
});

export default ApertureBar;
