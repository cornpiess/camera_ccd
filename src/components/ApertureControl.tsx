import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import * as Haptics from 'expo-haptics';

export interface ApertureControlProps {
  currentAperture: number;
  onApertureChange?: (aperture: number) => void;
  isVariableAperture: boolean;
  availableApertures?: readonly number[];
  activeAperture?: number;
}

export const ApertureControl: React.FC<ApertureControlProps> = ({
  currentAperture,
  onApertureChange,
  isVariableAperture,
  availableApertures = [],
  activeAperture,
}: ApertureControlProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Format aperture number cleanly e.g. 1.8 -> ƒ/1.8, 4 -> ƒ/4
  const formatAperture = (val: number) => {
    return val % 1 === 0 ? `ƒ/${val.toFixed(0)}` : `ƒ/${val.toFixed(1)}`;
  };

  /**
   * Handle selecting an aperture in the variable ring
   */
  const handleSelectAperture = (val: number) => {
    if (val !== currentAperture) {
      Haptics.selectionAsync().catch(() => {});
      onApertureChange?.(val);
    }
  };

  // Toggle variable aperture dial
  const toggleExpanded = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setIsExpanded((prev) => !prev);
  };

  /* -------------------------------------------------------------
     CASE 1: Fixed Aperture Fallback (Non-interactive)
     ------------------------------------------------------------- */
  if (!isVariableAperture || availableApertures.length <= 1) {
    const displayVal = activeAperture ?? 1.8;
    return (
      <View style={styles.container} pointerEvents="none">
        <View style={styles.fixedBadge}>
          <Text style={styles.fixedApertureText}>
            Fixed {formatAperture(displayVal)}
          </Text>
        </View>
      </View>
    );
  }

  /* -------------------------------------------------------------
     CASE 2: Variable Aperture Ring / Dial
     ------------------------------------------------------------- */
  return (
    <View style={styles.container}>
      {/* Expanded Variable Dial */}
      {isExpanded ? (
        <View style={styles.expandedDialContainer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
          >
            {availableApertures.map((val) => {
              const isSelected = Math.abs(val - currentAperture) < 0.05;
              return (
                <TouchableOpacity
                  key={val}
                  activeOpacity={0.7}
                  onPress={() => handleSelectAperture(val)}
                  style={[styles.dialItem, isSelected && styles.dialItemSelected]}
                >
                  <View
                    style={[
                      styles.tickMark,
                      isSelected ? styles.tickMarkSelected : styles.tickMarkUnselected,
                    ]}
                  />
                  <Text
                    style={[
                      styles.dialItemText,
                      isSelected && styles.dialItemTextSelected,
                    ]}
                  >
                    {formatAperture(val)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Close / Collapse pill */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={toggleExpanded}
            style={styles.collapseButton}
          >
            <Text style={styles.collapseButtonText}>DONE</Text>
          </TouchableOpacity>
        </View>
      ) : (
        /* Collapsed Aperture Badge (Tappable to expand) */
        <TouchableOpacity
          activeOpacity={0.75}
          onPress={toggleExpanded}
          style={styles.variableBadge}
        >
          <Text style={styles.variableApertureSymbol}>ƒ</Text>
          <Text style={styles.variableApertureValue}>
            {currentAperture % 1 === 0
              ? currentAperture.toFixed(0)
              : currentAperture.toFixed(1)}
          </Text>
          <View style={styles.variableDialHint}>
            <View style={styles.miniTick} />
            <View style={[styles.miniTick, styles.miniTickCenter]} />
            <View style={styles.miniTick} />
          </View>
        </TouchableOpacity>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 4,
  },
  fixedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(25, 25, 28, 0.75)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },
  fixedApertureText: {
    color: '#E6E6E6',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  fixedIndicatorTag: {
    marginLeft: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 6,
  },
  fixedIndicatorTagText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  variableBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(28, 28, 32, 0.85)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  variableApertureSymbol: {
    color: '#FFCC00',
    fontSize: 14,
    fontStyle: 'italic',
    fontWeight: '700',
    marginRight: 2,
  },
  variableApertureValue: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  variableDialHint: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
    gap: 2,
  },
  miniTick: {
    width: 2,
    height: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 1,
  },
  miniTickCenter: {
    height: 10,
    backgroundColor: '#FFCC00',
  },
  expandedDialContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(18, 18, 22, 0.92)',
    borderRadius: 24,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    maxWidth: '92%',
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  dialItem: {
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dialItemSelected: {
    transform: [{ scale: 1.1 }],
  },
  tickMark: {
    width: 2,
    borderRadius: 1,
    marginBottom: 4,
  },
  tickMarkSelected: {
    height: 12,
    backgroundColor: '#FFCC00',
  },
  tickMarkUnselected: {
    height: 7,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  dialItemText: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 11,
    fontWeight: '600',
  },
  dialItemTextSelected: {
    color: '#FFCC00',
    fontWeight: '800',
  },
  collapseButton: {
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  collapseButtonText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});
