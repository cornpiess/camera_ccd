import React, { useRef } from 'react';
import {
  ActivityIndicator,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from 'react-native';
import * as Haptics from 'expo-haptics';

interface ShutterButtonProps {
  onPress: () => void;
  disabled?: boolean;
  /** Camera identity accent for the outer ring (same color system as the rest of the UI). */
  accent?: string;
  isCapturing?: boolean;
}

/**
 * System-camera-style shutter: press = squeeze animation + heavy haptic; while the
 * capture promise is in flight the inner core goes translucent with a thin spinner
 * (never a stuck colored block — the shape stays a circle and springs back the moment
 * the capture settles). Re-press is gated by isCapturing.
 */
export const ShutterButton: React.FC<ShutterButtonProps> = ({
  onPress,
  disabled = false,
  isCapturing = false,
  accent,
}: ShutterButtonProps) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const innerScaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    if (disabled || isCapturing) return;
    Animated.parallel([
      Animated.spring(scaleAnim, { toValue: 0.92, tension: 300, friction: 20, useNativeDriver: true }),
      Animated.spring(innerScaleAnim, { toValue: 0.88, tension: 300, friction: 20, useNativeDriver: true }),
    ]).start();
  };

  const handlePressOut = () => {
    Animated.parallel([
      Animated.spring(scaleAnim, { toValue: 1, tension: 300, friction: 15, useNativeDriver: true }),
      Animated.spring(innerScaleAnim, { toValue: 1, tension: 300, friction: 15, useNativeDriver: true }),
    ]).start();
  };

  const handlePress = () => {
    if (disabled || isCapturing) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    onPress();
  };

  return (
    <Animated.View
      style={[
        styles.outerRing,
        disabled && styles.disabled,
        accent ? { borderColor: accent } : null,
        { transform: [{ scale: scaleAnim }] },
      ]}
    >
      <TouchableOpacity
        activeOpacity={1}
        disabled={disabled || isCapturing}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={handlePress}
        style={styles.touchableArea}
      >
        <Animated.View
          style={[
            styles.innerCore,
            isCapturing && styles.innerCoreCapturing,
            { transform: [{ scale: innerScaleAnim }] },
          ]}
        >
          {isCapturing ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
        </Animated.View>
      </TouchableOpacity>
    </Animated.View>
  );
};

const OUTER_SIZE = 76;
const INNER_SIZE = 64;

const styles = StyleSheet.create({
  outerRing: {
    width: OUTER_SIZE,
    height: OUTER_SIZE,
    borderRadius: OUTER_SIZE / 2,
    borderWidth: 4,
    borderColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  disabled: {
    opacity: 0.4,
  },
  touchableArea: {
    width: OUTER_SIZE,
    height: OUTER_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  innerCore: {
    width: INNER_SIZE,
    height: INNER_SIZE,
    borderRadius: INNER_SIZE / 2,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  // Translucent core + spinner while the capture promise runs — reads as "working",
  // not "stuck". Shape and size never change, so nothing jumps.
  innerCoreCapturing: {
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
});
