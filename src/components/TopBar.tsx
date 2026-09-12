import React, { useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  Animated,
  Platform,
  StatusBar,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraInfo } from './types';
import { markerGlyph } from './types';
import { GlassCard } from './GlassCard';

export interface TopBarProps {
  readonly profileName?: string;
  readonly cameraInfo?: CameraInfo;
  readonly cameraName?: string;
  /** Abstract selection marker + light accent of the current profile (small dot only, GOAL 3). */
  readonly marker?: string;
  readonly accent?: string;
  /** When provided, the camera badge becomes the formal Camera Selection entry point. */
  readonly onPress?: () => void;
}

const BADGE_RADIUS = 22;

/**
 * Liquid-glass camera capsule (the formal Camera Selection entry point). Sized generously
 * and given a water-like press response: it squeezes on touch and springs back with a
 * slight overshoot, so opening the selector reads as "the capsule pops into the panel".
 * The panel itself (CameraSelector) morphs from this capsule's geometry.
 */
export const TopBar: React.FC<TopBarProps> = ({
  profileName,
  cameraInfo,
  cameraName,
  marker,
  accent,
  onPress,
}: TopBarProps) => {
  const displayName = profileName ?? cameraName ?? cameraInfo?.name ?? '';
  const pressScale = useRef(new Animated.Value(1)).current;

  if (!displayName) return null;

  const pressIn = () => {
    Animated.spring(pressScale, { toValue: 0.93, tension: 320, friction: 18, useNativeDriver: true }).start();
  };
  const pressOut = () => {
    // Overshoot past 1 = the little liquid rebound before the selector takes over.
    Animated.spring(pressScale, { toValue: 1, tension: 160, friction: 8, useNativeDriver: true }).start();
  };
  const press = () => {
    if (!onPress) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onPress();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Animated.View style={{ transform: [{ scale: pressScale }] }}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Current camera ${displayName}. Tap to switch camera.`}
            accessibilityState={{ expanded: false }}
            activeOpacity={1}
            disabled={!onPress}
            onPressIn={pressIn}
            onPressOut={pressOut}
            onPress={press}
            style={styles.badgeWrapper}
          >
            <GlassCard borderRadius={BADGE_RADIUS} isInteractive style={styles.badgeGlass}>
              <View style={styles.badgeInner}>
                {accent ? (
                  <Text style={[styles.markerGlyph, { color: accent }]}>{markerGlyph(marker)}</Text>
                ) : null}
                <Text style={styles.cameraNameTitle} numberOfLines={1}>
                  {displayName.toUpperCase()}
                </Text>
                {onPress ? <Text style={styles.chevron}>⌄</Text> : null}
              </View>
            </GlassCard>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: 'transparent',
    paddingTop: Platform.OS === 'ios' ? 0 : StatusBar.currentHeight ?? 0,
    zIndex: 10,
  },
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    height: 56,
  },
  badgeWrapper: {
    borderRadius: BADGE_RADIUS,
    overflow: 'hidden',
  },
  badgeGlass: {
    minHeight: 44,
  },
  badgeInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 11,
  },
  markerGlyph: {
    fontSize: 11,
    marginRight: 8,
  },
  cameraNameTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  chevron: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 7,
    marginTop: -2,
  },
});
