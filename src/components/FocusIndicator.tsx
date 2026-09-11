import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

export interface FocusPoint {
  readonly x: number;
  readonly y: number;
  readonly key: number;
}

export interface FocusIndicatorProps {
  readonly point: FocusPoint | null;
  readonly size?: number;
  readonly durationMs?: number;
}

/**
 * Lightweight tap-to-focus indicator: a small frame that pops in at the tapped
 * position and fades out. Purely visual — the actual AF/AE move happens natively.
 */
export const FocusIndicator: React.FC<FocusIndicatorProps> = ({
  point,
  size = 64,
  durationMs = 900,
}: FocusIndicatorProps) => {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1.25)).current;

  useEffect(() => {
    if (!point) return;
    opacity.setValue(0);
    scale.setValue(1.25);
    Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 110, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 8, tension: 160, useNativeDriver: true }),
      ]),
      Animated.delay(durationMs),
      Animated.timing(opacity, { toValue: 0, duration: 280, useNativeDriver: true }),
    ]).start();
  }, [point, opacity, scale, durationMs]);

  if (!point) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      <Animated.View
        style={[
          styles.frame,
          {
            left: point.x - size / 2,
            top: point.y - size / 2,
            width: size,
            height: size,
            opacity,
            transform: [{ scale }],
          },
        ]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  frame: {
    position: 'absolute',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 204, 0, 0.9)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 3,
  },
});
