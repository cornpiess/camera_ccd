import React, { useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  PanResponder,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { GlassCard } from './GlassCard';

export interface ApertureControlProps {
  currentAperture: number;
  onApertureChange?: (aperture: number) => void;
  isVariableAperture: boolean;
  availableApertures?: readonly number[];
  activeAperture?: number;
  /** f-number from the active profile's JSON above which real starburst is more likely (✦ hint). */
  starZone?: number;
}

export const ApertureControl: React.FC<ApertureControlProps> = ({
  currentAperture,
  onApertureChange,
  isVariableAperture,
  availableApertures = [],
  activeAperture,
  starZone,
}: ApertureControlProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Format aperture numbers exactly as the hardware reports them, e.g. 1.48 -> ƒ/1.48,
  // 1.8 -> ƒ/1.8, 4 -> ƒ/4. Never round a real stop into one that does not exist.
  const formatAperture = (val: number) => {
    const rounded = Number(val.toFixed(2));
    return `ƒ/${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}`;
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
     Swipe-to-adjust on the collapsed badge (GOAL 9/11: 拖动跟手).
     Values are mirrored into refs so the PanResponder closures never
     act on stale render state. Steps fire DURING the drag — each time
     the finger crosses a 26px threshold — so response feels immediate
     while native calls stay naturally coalesced to one per stop.
     Direction follows the dial metaphor: drag right = stop toward
     ƒ/4 (smaller aperture), drag left = toward ƒ/1.4.
     ------------------------------------------------------------- */
  const apertureStateRef = useRef({ current: currentAperture, stops: availableApertures });
  apertureStateRef.current = { current: currentAperture, stops: availableApertures };
  const dragRef = useRef({ accum: 0, index: 0 });
  const STEP_PX = 26;

  const swipePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt, g) =>
          Math.abs(g.dx) > 18 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderGrant: () => {
          const { current, stops } = apertureStateRef.current;
          const index = stops.findIndex((v) => Math.abs(v - current) < 0.05);
          dragRef.current = { accum: 0, index: index >= 0 ? index : 0 };
        },
        onPanResponderMove: (_evt, g) => {
          const { stops } = apertureStateRef.current;
          if (stops.length <= 1) return;
          dragRef.current.accum += g.dx;
          while (Math.abs(dragRef.current.accum) >= STEP_PX) {
            const step = dragRef.current.accum > 0 ? 1 : -1;
            const nextIndex = Math.min(stops.length - 1, Math.max(0, dragRef.current.index + step));
            dragRef.current.accum = 0;
            if (nextIndex === dragRef.current.index) break;
            dragRef.current.index = nextIndex;
            Haptics.selectionAsync().catch(() => {});
            onApertureChange?.(stops[nextIndex]!);
          }
        },
        onPanResponderRelease: () => {
          dragRef.current.accum = 0;
        },
      }),
    [onApertureChange],
  );

  /* -------------------------------------------------------------
     CASE 1: Fixed Aperture Fallback (Non-interactive)
     ------------------------------------------------------------- */
  if (!isVariableAperture || availableApertures.length <= 1) {
    const displayVal = activeAperture ?? 1.8;
    return (
      <View style={styles.container} pointerEvents="none">
        <GlassCard borderRadius={16}>
          <View style={styles.fixedBadgeInner}>
            <Text style={styles.fixedApertureText}>
              Fixed {formatAperture(displayVal)}
            </Text>
          </View>
        </GlassCard>
      </View>
    );
  }

  /* -------------------------------------------------------------
     CASE 2: Variable Aperture Ring / Dial
     ------------------------------------------------------------- */
  // ✦ on the collapsed badge when the current stop is inside the profile's
  // starburst zone. Hint only — the starburst itself is optical, never software.
  const isInStarZone =
    typeof starZone === 'number' && Number.isFinite(starZone) && currentAperture >= starZone - 0.05;

  return (
    <View style={styles.container}>
      {/* Expanded Variable Dial */}
      {isExpanded ? (
        <GlassCard borderRadius={24} isInteractive style={styles.expandedDialOuter}>
          <View style={styles.expandedDialInner}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.scrollContent}
            >
            {availableApertures.map((val, index) => {
              const isSelected = Math.abs(val - currentAperture) < 0.05;
              // ✦ marks stops where a REAL optical starburst is more likely. The threshold
              // comes from the profile JSON (starZone); without it only the smallest
              // available stop is marked. This is a hint, never a software effect.
              const zone = typeof starZone === 'number' && Number.isFinite(starZone) ? starZone : null;
              const isStarZone = zone !== null
                ? val >= zone - 0.05
                : index === availableApertures.length - 1;
              return (
                <TouchableOpacity
                  key={val}
                  activeOpacity={0.7}
                  onPress={() => handleSelectAperture(val)}
                  accessibilityLabel={`${isStarZone ? 'Starburst more likely. ' : ''}Aperture ${formatAperture(val)}`}
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
                    {isStarZone ? '✦ ' : ''}{formatAperture(val)}
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
        </GlassCard>
      ) : (
        /* Collapsed Aperture Badge (swipe to adjust; tap to expand the precise dial) */
        <View {...swipePanResponder.panHandlers}>
          <GlassCard borderRadius={18} isInteractive>
            <TouchableOpacity
              activeOpacity={0.75}
              onPress={toggleExpanded}
              style={styles.variableBadgeInner}
            >
              <Text style={styles.variableApertureSymbol}>ƒ</Text>
              {isInStarZone ? <Text style={styles.starZoneGlyph}>✦</Text> : null}
              <Text style={styles.variableApertureValue}>
                {formatAperture(currentAperture).replace('ƒ/', '')}
              </Text>
              <View style={styles.variableDialHint}>
                <View style={styles.miniTick} />
                <View style={[styles.miniTick, styles.miniTickCenter]} />
                <View style={styles.miniTick} />
              </View>
            </TouchableOpacity>
          </GlassCard>
        </View>
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
  fixedBadgeInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
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
  variableBadgeInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  variableApertureSymbol: {
    color: '#FFCC00',
    fontSize: 14,
    fontStyle: 'italic',
    fontWeight: '700',
    marginRight: 2,
  },
  starZoneGlyph: {
    color: '#FFCC00',
    fontSize: 12,
    fontWeight: '700',
    marginRight: 3,
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
  expandedDialOuter: {
    maxWidth: '92%',
  },
  expandedDialInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
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
