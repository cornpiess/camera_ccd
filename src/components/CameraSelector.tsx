import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraProfile } from '../profiles/types';
import { markerGlyph, profileDisplayName } from './types';
import { GlassCard } from './GlassCard';
import { ProfileConfigModal } from '../calibration/ProfileConfigModal';

export interface CameraSelectorProps {
  readonly visible: boolean;
  readonly profiles: readonly CameraProfile[];
  readonly activeProfileId?: string;
  readonly onSelectProfile: (profile: CameraProfile) => void;
  readonly onClose: () => void;
}

/**
 * The formal Camera Selection entry point (the radial ring is only a shortcut for
 * expert users): a Liquid Glass strip under the top camera badge. Each item is an
 * abstract marker glyph + its own production name — no real-camera imagery, no logos.
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
  // Per-camera configuration entry: the gear opens the JSON tune sheet for that camera.
  const [configProfileId, setConfigProfileId] = useState<string | null>(null);

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
      <Animated.View style={[styles.panelPosition, { opacity, transform: [{ translateY }], height: profiles.length * 56 }]}>
        <GlassCard borderRadius={20} isInteractive style={styles.panel}>
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
                <Pressable
                  accessibilityLabel={`Configure ${displayName}`}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    setConfigProfileId(profile.id);
                  }}
                  style={({ pressed }) => [styles.configButton, pressed && styles.configButtonPressed]}
                >
                  <Text style={[styles.configGlyph, { color: accent }]}>⚙</Text>
                </Pressable>
              </Pressable>
            );
          })}
        </GlassCard>
      </Animated.View>

      {/* Per-camera JSON import / tune sheet (stays open over the selector) */}
      <ProfileConfigModal
        visible={configProfileId !== null}
        profileId={configProfileId}
        onClose={() => setConfigProfileId(null)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    zIndex: 40,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  panelPosition: {
    position: 'absolute',
    top: 92,
    alignSelf: 'center',
    width: '72%',
    maxWidth: 320,
  },
  panel: {
    flex: 1,
    paddingVertical: 6,
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
  configButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  configButtonPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  configGlyph: {
    fontSize: 17,
  },
});
