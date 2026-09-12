import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraProfile } from '../profiles/types';
import { markerGlyph, profileDisplayName } from './types';
import { GlassCard } from './GlassCard';

export interface CameraSelectorProps {
  readonly visible: boolean;
  readonly profiles: readonly CameraProfile[];
  readonly activeProfileId?: string;
  readonly onSelectProfile: (profile: CameraProfile) => void;
  readonly onClose: () => void;
}

const SCREEN_WIDTH = Dimensions.get('window').width;
const ROW_HEIGHT = 56;
const PANEL_MAX_WIDTH = Math.min(320, Math.round(SCREEN_WIDTH * 0.72));
// The morph starts from the TopBar capsule's approximate geometry (centered capsule,
// 44pt tall, sitting just under the status bar) and blooms into the full panel.
const CAPSULE_WIDTH = 210;
const CAPSULE_HEIGHT = 44;
// TopBar's capsule sits just below the SafeArea inset (~55pt on notched devices).
const CAPSULE_TOP = 55;
const PANEL_TOP = 92;

/**
 * Liquid-glass camera selector. Opening is not a fade-in: the panel MORPHS out of the
 * top camera capsule — it blooms from the capsule's width/height/position with a springy
 * overshoot (the "water pop"), while the camera list fades in only once the glass has
 * reached full size. Closing runs the reverse: the panel pours back into the capsule.
 */
export const CameraSelector: React.FC<CameraSelectorProps> = ({
  visible,
  profiles,
  activeProfileId,
  onSelectProfile,
  onClose,
}: CameraSelectorProps) => {
  // `mounted` keeps the tree alive while the close animation pours the panel back.
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    animRef.current?.stop();
    if (visible) {
      setMounted(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      animRef.current = Animated.spring(progress, {
        toValue: 1,
        tension: 120,
        friction: 10,
        useNativeDriver: false,
      });
      animRef.current.start();
    } else {
      animRef.current = Animated.timing(progress, {
        toValue: 0,
        duration: 170,
        useNativeDriver: false,
      });
      animRef.current.start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted || profiles.length === 0) return null;

  const panelHeight = profiles.length * ROW_HEIGHT;
  const width = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [CAPSULE_WIDTH, PANEL_MAX_WIDTH],
    extrapolate: 'clamp',
  });
  const height = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [CAPSULE_HEIGHT, panelHeight],
    extrapolate: 'clamp',
  });
  const top = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [CAPSULE_TOP, PANEL_TOP],
    extrapolate: 'clamp',
  });
  // The capsule look during the morph: capsule width carries its own corner radius.
  const radius = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [22, 20],
    extrapolate: 'clamp',
  });
  const backdropOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.3],
    extrapolate: 'clamp',
  });
  // Rows stay hidden while the glass is still blooming; they surface only once the
  // panel reaches (or overshoots) its full size.
  const contentOpacity = progress.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [0, 0, 1],
    extrapolate: 'clamp',
  });
  const contentScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.94, 1],
    extrapolate: 'clamp',
  });

  const handleSelect = (profile: CameraProfile) => {
    Haptics.selectionAsync().catch(() => {});
    onSelectProfile(profile);
    onClose();
  };

  return (
    <View style={[StyleSheet.absoluteFillObject, styles.root]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFillObject, styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable
          accessibilityLabel="Close camera selector"
          accessibilityRole="button"
          style={styles.backdropPress}
          onPress={onClose}
        />
      </Animated.View>
      {/* Centered morph host: animated top + width/height, horizontally centered */}
      <Animated.View style={[styles.morphHost, { top }]} pointerEvents="box-none">
        <Animated.View style={[styles.morphPanel, { width, height, borderRadius: radius }]}>
          <GlassCard borderRadius={20} isInteractive style={styles.panel}>
            <Animated.View
              style={[styles.content, { opacity: contentOpacity, transform: [{ scale: contentScale }] }]}
            >
              {profiles.map((profile) => {
                const isActive = profile.id === activeProfileId;
                const accent = profile.ui?.accent || '#FFFFFF';
                const displayName = profileDisplayName(profile);
                return (
                  <Pressable
                    key={profile.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                    accessibilityLabel={`${displayName}${isActive ? ', selected' : ''}`}
                    onPress={() => handleSelect(profile)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <Text
                      style={[
                        styles.rowGlyph,
                        { color: isActive ? accent : 'rgba(255, 255, 255, 0.55)' },
                      ]}
                    >
                      {markerGlyph(profile.ui?.markerStyle)}
                    </Text>
                    <Text style={[styles.rowName, isActive && styles.rowNameActive]} numberOfLines={1}>
                      {displayName}
                    </Text>
                    {isActive ? (
                      <View style={[styles.activeDot, { backgroundColor: accent }]} />
                    ) : null}
                  </Pressable>
                );
              })}
            </Animated.View>
          </GlassCard>
        </Animated.View>
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    zIndex: 40,
  },
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  backdropPress: {
    flex: 1,
  },
  morphHost: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  morphPanel: {
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 12,
  },
  panel: {
    flex: 1,
    paddingVertical: 6,
  },
  content: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingHorizontal: 18,
    gap: 12,
  },
  rowPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  rowGlyph: {
    fontSize: 11,
    width: 16,
    textAlign: 'center',
  },
  rowName: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  rowNameActive: {
    fontWeight: '800',
  },
  activeDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
});
