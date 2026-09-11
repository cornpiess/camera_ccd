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

export interface TopBarProps {
  readonly profileName?: string;
  readonly cameraInfo?: CameraInfo;
  readonly cameraName?: string;
  /** When provided, the camera badge becomes the formal Camera Selection entry point. */
  readonly onPress?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  profileName,
  cameraInfo,
  cameraName,
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
          style={styles.cameraNameBadge}
        >
          <Text style={styles.cameraNameTitle} numberOfLines={1}>
            {displayName.toUpperCase()}
          </Text>
          {onPress ? <Text style={styles.chevron}>⌄</Text> : null}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: 'transparent',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
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
  cameraNameBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20, 20, 24, 0.65)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
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
