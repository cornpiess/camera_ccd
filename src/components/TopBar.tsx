import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  Platform,
  StatusBar,
} from 'react-native';
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

export const TopBar: React.FC<TopBarProps> = ({
  profileName,
  cameraInfo,
  cameraName,
  marker,
  accent,
  onPress,
}: TopBarProps) => {
  const displayName = profileName ?? cameraName ?? cameraInfo?.name ?? '';

  if (!displayName) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Current camera ${displayName}. Tap to switch camera.`}
          accessibilityState={{ expanded: false }}
          activeOpacity={0.75}
          disabled={!onPress}
          onPress={onPress}
          style={styles.badgeWrapper}
        >
          <GlassCard borderRadius={16} style={styles.badgeGlass}>
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
    paddingVertical: 10,
    height: 52,
  },
  badgeWrapper: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  badgeGlass: {
    minHeight: 36,
  },
  badgeInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  markerGlyph: {
    fontSize: 9,
    marginRight: 7,
  },
  cameraNameTitle: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  chevron: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 13,
    fontWeight: '700',
    marginLeft: 6,
    marginTop: -2,
  },
});
