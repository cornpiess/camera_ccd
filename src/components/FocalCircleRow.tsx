import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { FocalStop } from '../camera/focalLadder';

export interface FocalCircleRowProps {
  readonly stops: readonly FocalStop[];
  /** Currently engaged focal length in mm; null until the ladder resolves. */
  readonly currentFocalMm: number | null;
  readonly onSelectFocal: (stop: FocalStop) => void;
}

const CIRCLE_SIZE = 46;

/**
 * Focal-length selector: a row of circles (13 / 26 / 35 … mm). The engaged stop is a
 * solid white circle with black text; the rest are dim glass circles. Sits between the
 * viewfinder and the aperture bar, mirroring the system camera's control stack.
 */
export const FocalCircleRow: React.FC<FocalCircleRowProps> = ({ stops, currentFocalMm, onSelectFocal }) => {
  if (stops.length === 0) return null;
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
            style={[styles.circle, selected && styles.circleSelected]}
          >
            <Text style={[styles.label, selected && styles.labelSelected]}>{Math.round(stop.mm)}</Text>
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
  circleSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderColor: 'rgba(255, 255, 255, 0.95)',
  },
  label: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  labelSelected: {
    color: '#000000',
  },
});

export default FocalCircleRow;
