import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { FocalStop } from '../camera/focalLadder';

export interface FocalApertureDialProps {
  readonly stops: readonly FocalStop[];
  /** Currently engaged focal length in mm; null until the first stop resolves. */
  readonly currentFocalMm: number | null;
  readonly onSelectFocal: (stop: FocalStop) => void;
  /** Displayed f-stop (hardware-confirmed or optimistic). */
  readonly currentAperture: number;
  /** Hardware stops in ascending order; empty on fixed-aperture lenses. */
  readonly availableApertures: readonly number[];
  readonly isVariableAperture: boolean;
  /** Fired on each aperture detent while dragging (only called when variable). */
  readonly onApertureChange: (fStop: number) => void;
}

const DIAL_SIZE = 158;
const RING_RADIUS = 58;
const SLOT_HIT_AREA = 42;
const TEETH_COUNT = 36;
const TEETH_LENGTH = 5;
const TEETH_RADIUS = 72;
/** Vertical drag distance that equals one aperture detent (1/3 stop). */
const APERTURE_DETENT_PX = 16;

const formatF = (f: number): string => `ƒ/${f.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}`;

/**
 * Circular focal-length + aperture dial (iPhone-native-zoom-dial inspired, extended with
 * a real camera's aperture ring):
 * - Focal stops sit around the ring as tappable mm numbers; the engaged stop is enlarged
 *   on a white pill; the center shows the live focal length.
 * - One reserved slot on the ring is the aperture. Fixed-aperture lenses show `ƒ/x` with
 *   a dimmed serrated ring and a FIXED caption (honest no-fake-bokeh contract). Variable
 *   lenses (iPhone 18 Pro class, iOS 27+) arm the ring on tap: dragging vertically rolls
 *   the serrated ring through the hardware stops with a detent haptic on each 1/3 stop —
 *   the knurled feel of a real lens ring.
 */
export const FocalApertureDial: React.FC<FocalApertureDialProps> = ({
  stops,
  currentFocalMm,
  onSelectFocal,
  currentAperture,
  availableApertures,
  isVariableAperture,
  onApertureChange,
}) => {
  // Aperture slot occupies the top of the ring; focal stops follow clockwise.
  const slotCount = stops.length + 1;
  const slotAngle = (index: number): number => -Math.PI / 2 + index * ((2 * Math.PI) / slotCount);

  const [apertureArmed, setApertureArmed] = useState(false);
  const ringRotation = useRef(new Animated.Value(0)).current;
  // Detent bookkeeping across the active drag.
  const dragRemainderRef = useRef(0);
  const apertureIndexRef = useRef(0);
  const rotationRef = useRef(0);

  // Lens switches can turn a variable main lens into a fixed ultra-wide/telephoto —
  // never leave the aperture slot armed with no stops to drag.
  useEffect(() => {
    if (!isVariableAperture) setApertureArmed(false);
  }, [isVariableAperture]);

  const apertureSlotIndex = stops.length;

  const nearestApertureIndex = useCallback((f: number): number => {
    if (availableApertures.length === 0) return 0;
    let best = 0;
    for (let i = 1; i < availableApertures.length; i++) {
      if (Math.abs(availableApertures[i]! - f) < Math.abs(availableApertures[best]! - f)) best = i;
    }
    return best;
  }, [availableApertures]);

  const handleApertureDetent = useCallback(
    (direction: 1 | -1) => {
      if (availableApertures.length === 0) return;
      const next = Math.min(
        availableApertures.length - 1,
        Math.max(0, apertureIndexRef.current + direction),
      );
      if (next === apertureIndexRef.current) return;
      apertureIndexRef.current = next;
      Haptics.selectionAsync().catch(() => {});
      onApertureChange(availableApertures[next]!);
    },
    [availableApertures, onApertureChange],
  );

  const aperturePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isVariableAperture && apertureArmed,
        onMoveShouldSetPanResponder: () => isVariableAperture && apertureArmed,
        onPanResponderGrant: () => {
          dragRemainderRef.current = 0;
          apertureIndexRef.current = nearestApertureIndex(currentAperture);
        },
        onPanResponderMove: (_evt, gestureState) => {
          if (!isVariableAperture || !apertureArmed) return;
          // Both axes accepted (real rings turn horizontally or vertically): the dominant
          // axis wins so diagonal drags don't double-step. Down/right closes the aperture
          // (higher f-number), like pushing the ring toward its stop-down direction.
          const total =
            Math.abs(gestureState.dx) >= Math.abs(gestureState.dy)
              ? gestureState.dx + dragRemainderRef.current
              : gestureState.dy + dragRemainderRef.current;
          const steps = Math.trunc(total / APERTURE_DETENT_PX);
          if (steps === 0) return;
          dragRemainderRef.current = total - steps * APERTURE_DETENT_PX;
          const direction: 1 | -1 = steps > 0 ? 1 : -1;
          for (let s = 0; s < Math.abs(steps); s++) {
            handleApertureDetent(direction);
          }
          // Roll the serrated ring visually, one tooth pitch per detent.
          rotationRef.current += steps * (360 / TEETH_COUNT);
          Animated.spring(ringRotation, {
            toValue: rotationRef.current,
            useNativeDriver: true,
            friction: 8,
            tension: 120,
          }).start();
        },
        onPanResponderRelease: () => {
          dragRemainderRef.current = 0;
        },
      }),
    [apertureArmed, currentAperture, handleApertureDetent, isVariableAperture, nearestApertureIndex, ringRotation],
  );

  const handleApertureSlotPress = useCallback((): void => {
    if (!isVariableAperture) {
      // Honest fixed-aperture lens: acknowledge the tap but do nothing.
      Haptics.selectionAsync().catch(() => {});
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setApertureArmed((armed) => !armed);
  }, [isVariableAperture]);

  const teeth = useMemo(
    () => Array.from({ length: TEETH_COUNT }, (_, i) => (i * 360) / TEETH_COUNT),
    [],
  );

  const centerPrimary = apertureArmed ? formatF(currentAperture) : currentFocalMm != null ? String(Math.round(currentFocalMm)) : '—';
  const centerSecondary = apertureArmed ? 'APERTURE' : 'MM';

  return (
    <View style={styles.dial} pointerEvents="box-none">
      {/* Serrated ring: dimmed decoration on fixed lenses; rolls with detents while
          dragging the aperture on variable lenses. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.teethRing, { transform: [{ rotate: ringRotation }] , opacity: apertureArmed ? 1 : 0.45 }]}
      >
        {teeth.map((angle) => (
          <View
            key={angle}
            style={[
              styles.tooth,
              { transform: [{ rotate: `${angle}deg` }, { translateY: -TEETH_RADIUS }] },
              apertureArmed ? styles.toothActive : null,
            ]}
          />
        ))}
      </Animated.View>

      {/* Focal stops + aperture slot around the ring */}
      {stops.map((stop, index) => {
        const angle = slotAngle(index + 1);
        const posX = Math.cos(angle) * RING_RADIUS;
        const posY = Math.sin(angle) * RING_RADIUS;
        const selected = currentFocalMm != null && Math.round(currentFocalMm) === Math.round(stop.mm);
        return (
          <TouchableOpacity
            key={`${stop.mm}-${stop.lensId}`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Switch to ${Math.round(stop.mm)}mm`}
            activeOpacity={0.7}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setApertureArmed(false);
              onSelectFocal(stop);
            }}
            style={[styles.slot, { transform: [{ translateX: posX - SLOT_HIT_AREA / 2 }, { translateY: posY - SLOT_HIT_AREA / 2 }] }]}
          >
            <View style={[styles.slotPill, selected && styles.slotPillSelected]}>
              <Text style={[styles.slotText, selected && styles.slotTextSelected]}>{Math.round(stop.mm)}</Text>
            </View>
          </TouchableOpacity>
        );
      })}

      {/* Aperture slot (reserved position at the top of the ring) */}
      {(() => {
        const angle = slotAngle(apertureSlotIndex);
        const posX = Math.cos(angle) * RING_RADIUS;
        const posY = Math.sin(angle) * RING_RADIUS;
        return (
          <View
            style={[styles.slot, { transform: [{ translateX: posX - SLOT_HIT_AREA / 2 }, { translateY: posY - SLOT_HIT_AREA / 2 }] }]}
            {...(isVariableAperture && apertureArmed ? aperturePanResponder.panHandlers : {})}
          >
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Aperture ${formatF(currentAperture)}${isVariableAperture ? '' : ', fixed'}`}
              activeOpacity={isVariableAperture ? 0.7 : 0.9}
              onPress={handleApertureSlotPress}
              style={[styles.slotPill, apertureArmed && styles.slotPillArmed]}
            >
              <Text style={[styles.slotText, apertureArmed && styles.slotTextSelected]} numberOfLines={1}>
                {formatF(currentAperture)}
              </Text>
            </TouchableOpacity>
            {!isVariableAperture ? <Text style={styles.fixedCaption}>FIXED</Text> : null}
          </View>
        );
      })()}

      {/* Center readout */}
      <View style={styles.center} pointerEvents="none">
        <Text style={styles.centerPrimary} numberOfLines={1}>{centerPrimary}</Text>
        <Text style={styles.centerSecondary}>{centerSecondary}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  dial: {
    width: DIAL_SIZE,
    height: DIAL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teethRing: {
    position: 'absolute',
    width: DIAL_SIZE,
    height: DIAL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tooth: {
    position: 'absolute',
    width: 2,
    height: TEETH_LENGTH,
    borderRadius: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  toothActive: {
    backgroundColor: 'rgba(255, 214, 10, 0.9)',
  },
  slot: {
    position: 'absolute',
    width: SLOT_HIT_AREA,
    height: SLOT_HIT_AREA,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotPill: {
    minWidth: 34,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20, 20, 20, 0.6)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.22)',
  },
  slotPillSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderColor: 'rgba(255, 255, 255, 0.95)',
  },
  slotPillArmed: {
    backgroundColor: 'rgba(255, 214, 10, 0.95)',
    borderColor: 'rgba(255, 214, 10, 0.95)',
  },
  slotText: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 12,
    fontWeight: '700',
  },
  slotTextSelected: {
    color: '#000000',
  },
  fixedCaption: {
    position: 'absolute',
    bottom: 1,
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 7,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  center: {
    alignItems: 'center',
  },
  centerPrimary: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    maxWidth: 80,
  },
  centerSecondary: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.2,
    marginTop: 1,
  },
});

export default FocalApertureDial;
