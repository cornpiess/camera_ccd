import React, { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

// Guarded require: expo-glass-effect resolves its native view manager at MODULE LOAD time,
// so importing it unconditionally would crash any build whose native side predates this
// dependency (e.g. loading new JS through Metro into the dev-r2 dev client). If anything
// fails to resolve we run in fallback mode forever — never at the cost of a launch crash.
let GlassViewImpl: React.ComponentType<{
  glassEffectStyle?: 'clear' | 'regular' | 'none';
  tintColor?: string;
  isInteractive?: boolean;
  colorScheme?: 'auto' | 'light' | 'dark';
  style?: StyleProp<ViewStyle>;
}> | null = null;
let availabilityHelpers: { isGlassEffectAPIAvailable: () => boolean; isLiquidGlassAvailable: () => boolean } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const glass = require('expo-glass-effect');
  GlassViewImpl = glass.GlassView;
  availabilityHelpers = {
    isGlassEffectAPIAvailable: glass.isGlassEffectAPIAvailable,
    isLiquidGlassAvailable: glass.isLiquidGlassAvailable,
  };
} catch {
  GlassViewImpl = null;
  availabilityHelpers = null;
}

/**
 * Track the system Reduce Transparency setting: when enabled, glass controls must fall back to
 * a much more solid material instead of holding the effect for the sake of looks.
 */
export function useReduceTransparency(): boolean {
  const [reduceTransparency, setReduceTransparency] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceTransparencyEnabled().then((enabled) => {
      if (active) setReduceTransparency(enabled);
    }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (enabled) => setReduceTransparency(enabled),
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduceTransparency;
}

export interface GlassCardProps {
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: React.ReactNode;
  /** Optional very light accent tint; alpha is provided by the caller from glassTintStrength. */
  readonly tintColor?: string | null;
  /** Interactive glass responds to touches (use for pressable panels). */
  readonly isInteractive?: boolean;
  readonly borderRadius?: number;
}

/**
 * Liquid Glass surface for controls (GOAL: glass serves Controls / Navigation / Selection only).
 * - iOS 26+: the real system material via expo-glass-effect.
 * - Older iOS or Reduce Transparency: a solid system-material-like fallback, never a fake blur.
 */
export const GlassCard: React.FC<GlassCardProps> = ({
  style,
  children,
  tintColor,
  isInteractive = false,
  borderRadius = 18,
}: GlassCardProps) => {
  const reduceTransparency = useReduceTransparency();
  const glassOK =
    GlassViewImpl !== null &&
    availabilityHelpers !== null &&
    availabilityHelpers.isGlassEffectAPIAvailable() &&
    availabilityHelpers.isLiquidGlassAvailable() &&
    !reduceTransparency;

  const tint = useMemo(() => tintColor ?? undefined, [tintColor]);

  if (glassOK && GlassViewImpl) {
    return (
      <View style={[styles.clip, { borderRadius }, style]}>
        <GlassViewImpl
          glassEffectStyle="regular"
          tintColor={tint}
          isInteractive={isInteractive}
          colorScheme="dark"
          style={[StyleSheet.absoluteFillObject, { borderRadius }]}
        />
        <View style={[styles.content, styles.hairline, { borderRadius }]} pointerEvents="box-none">
          {children}
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.clip,
        styles.fallback,
        reduceTransparency && styles.fallbackSolid,
        { borderRadius },
        style,
      ]}
    >
      <View style={[styles.content, styles.hairline, { borderRadius }]} pointerEvents="box-none">
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  content: {
    // flexGrow (not flex:1) so the card auto-sizes to its content when the parent
    // doesn't constrain height, and still fills a fixed-height parent when asked.
    flexGrow: 1,
  },
  hairline: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
  fallback: {
    backgroundColor: 'rgba(24, 24, 28, 0.78)',
  },
  fallbackSolid: {
    backgroundColor: 'rgba(18, 18, 22, 0.97)',
  },
});
