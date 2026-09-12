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

const CIRCLE_SIZE = 36;

/**
 * Focal-length selector: a row of circles (13 / 26 / 35 … mm), INSIDE the viewfinder near
 * its bottom edge — system-camera placement and size. The engaged stop is a solid circle
 * in the camera's skin accent with auto-contrast text; the rest are translucent dark
 * chips that stay legible over the picture.
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
    gap: 10,
    padding: 4,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.22)',
  },
  circle: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.32)',
    backgroundColor: 'rgba(24, 24, 26, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: 'rgba(255, 255, 255, 0.88)',
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});

export default FocalCircleRow;
