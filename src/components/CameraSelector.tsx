import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraProfile } from '../profiles/types';

export interface CameraSelectorProps {
  readonly visible: boolean;
  readonly profiles: readonly CameraProfile[];
  readonly activeProfileId?: string;
  readonly onSelectProfile: (profile: CameraProfile) => void;
  readonly onClose: () => void;
}

/**
 * The formal Camera Selection entry point (the radial ring is only a shortcut for
 * expert users): a minimal drop-down list under the top camera badge. Tap a camera
 * to switch, tap the backdrop to dismiss.
 */
export const CameraSelector: React.FC<CameraSelectorProps> = ({
  visible,
  profiles,
  activeProfileId,
  onSelectProfile,
  onClose,
}: CameraSelectorProps) => {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-12)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, friction: 9, tension: 180, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.timing(opacity, { toValue: 0, duration: 120, useNativeDriver: true }).start();
    }
  }, [visible, opacity, translateY]);

  if (!visible) return null;

  const handleSelect = (profile: CameraProfile) => {
    Haptics.selectionAsync().catch(() => {});
    onSelectProfile(profile);
    onClose();
  };

  return (
    <View style={[StyleSheet.absoluteFillObject, styles.root]}>
      <Pressable
        accessibilityLabel="Close camera selector"
        accessibilityRole="button"
        style={styles.backdrop}
        onPress={onClose}
      />
      <Animated.View style={[styles.panel, { opacity, transform: [{ translateY }] }]}>
        {profiles.slice(0, 8).map((profile) => {
          const isActive = profile.id === activeProfileId;
          const accent = profile.ui?.accent || '#FFFFFF';
          const shortName = profile.ui?.shortName || profile.name.slice(0, 4).toUpperCase();
          return (
            <Pressable
              key={profile.id}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              onPress={() => handleSelect(profile)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={[styles.accentDot, { backgroundColor: accent }]} />
              <Text style={[styles.rowName, isActive && styles.rowNameActive]} numberOfLines={1}>
                {profile.name}
              </Text>
              <Text style={[styles.rowShort, isActive && { color: accent }]} numberOfLines={1}>
                {shortName}
              </Text>
              {isActive ? <Text style={styles.check}>✓</Text> : null}
            </Pressable>
          );
        })}
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    zIndex: 40,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  panel: {
    position: 'absolute',
    top: 96,
    alignSelf: 'center',
    width: '72%',
    maxWidth: 320,
    borderRadius: 18,
    backgroundColor: 'rgba(18, 18, 22, 0.97)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 18,
    gap: 10,
  },
  rowPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  accentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
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
  rowShort: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    maxWidth: 90,
    textAlign: 'right',
  },
  check: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
    width: 16,
    textAlign: 'center',
  },
});
