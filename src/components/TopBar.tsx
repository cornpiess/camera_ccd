import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Platform,
  StatusBar,
} from 'react-native';
import type { CameraInfo } from './types';

export interface TopBarProps {
  readonly profileName?: string;
  readonly cameraInfo?: CameraInfo;
  readonly cameraName?: string;
}

export const TopBar: React.FC<TopBarProps> = ({
  profileName,
  cameraInfo,
  cameraName,
}: TopBarProps) => {
  const displayName = profileName ?? cameraName ?? cameraInfo?.name ?? '';

  if (!displayName) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.cameraNameBadge}>
          <Text style={styles.cameraNameTitle} numberOfLines={1}>
            {displayName.toUpperCase()}
          </Text>
        </View>
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
});

