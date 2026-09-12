import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { CameraLens } from '../camera/CameraEngine';

export interface LensSwitcherProps {
  readonly lenses: readonly CameraLens[];
  readonly currentId?: string;
  readonly onSelect: (id: string) => void;
}

/**
 * Rear lens selector (0.5× / 1× / 2× chips). Only mounted when the device has more than
 * one rear lens; a quiet row that sits above the bottom controls.
 */
export const LensSwitcher: React.FC<LensSwitcherProps> = ({ lenses, currentId, onSelect }) => {
  if (lenses.length <= 1) return null;

  return (
    <View style={styles.row} pointerEvents="box-none">
      {lenses.map((lens) => {
        const selected = lens.id === currentId;
        return (
          <TouchableOpacity
            key={lens.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Switch to ${lens.label} lens`}
            activeOpacity={0.7}
            onPress={() => {
              if (!selected) onSelect(lens.id);
            }}
            style={[styles.chip, selected && styles.chipSelected]}
          >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{lens.label}</Text>
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
  },
  chip: {
    minWidth: 44,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
  },
  chipSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(255, 255, 255, 0.92)',
  },
  chipText: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 12,
    fontWeight: '700',
  },
  chipTextSelected: {
    color: '#000000',
  },
});
