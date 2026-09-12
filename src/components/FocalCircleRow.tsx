import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { FocalStop } from '../camera/focalLadder';
import { hexToRgba, isLightColor } from '../theme/skin';

export interface FocalCircleRowProps {
  readonly stops: readonly FocalStop[];
  /** Currently engaged focal length in mm; null until the ladder resolves. */
  readonly currentFocalMm: number | null;
  /** Camera identity accent — the engaged circle wears the camera's skin color. */
  readonly accent?: string;
  readonly onSelectFocal: (stop: FocalStop) => void;
}

const CIRCLE_SIZE = 46;

/**
 * Focal-length selector: a row of circles (13 / 26 / 35 … mm). The engaged stop is a
 * solid circle in the camera's skin accent with auto-contrast text; the rest are dim
 * glass circles. Sits between the viewfinder and the aperture bar, mirroring the system
 * camera's control stack.
 */
export const FocalCircleRow: React.FC<FocalCircleRowProps> = ({ stops, currentFocalMm, accent, onSelectFocal }) => {
  if (stops.length === 0) return null;
  const selectedBg = accent ?? 'rgba(255, 255, 255, 0.95)';
  const selectedFg = accent && !isLightColor(accent) ? '#FFFFFF' : '#000000';
  return (
    <View style={styles.row} pointerEvents="box-none">
      {stops.map((stop) => {
        const selected = currentFocalMm != null && Math.round(currentFocalMm) === Math.round(stop.mm);
        return (
          <TouchableOpacity
            key={`${stop.mm}-${stop.lensId}`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${Math.round(stop.mm)} millimeter`}
            activeOpacity={0.7}
            onPress={() => {
              if (selected) return;
              Haptics.selectionAsync().catch(() => {});
              onSelectFocal(stop);
            }}
            style={[
              styles.circle,
              selected && { backgroundColor: selectedBg, borderColor: selectedBg },
            ]}
          >
            <Text style={[styles.label, selected && { color: selectedFg }]}>{Math.round(stop.mm)}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  circle: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    backgroundColor: 'rgba(30, 30, 30, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});

export default FocalCircleRow;
