import React, { useMemo } from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import type { CameraProfile } from '../profiles/types';

export interface ProfileOverlayProps {
  profile: CameraProfile | null;
  style?: StyleProp<ViewStyle>;
}

export const ProfileOverlay: React.FC<ProfileOverlayProps> = ({
  profile,
  style,
}: ProfileOverlayProps) => {
  const overlay = useMemo(() => {
    if (!profile) {
      return null;
    }

    // 1. Basic tone / exposure approximation
    const exposure = profile.tone?.exposure ?? 0;
    let exposureColor: string | null = null;
    let exposureOpacity = 0;
    if (exposure > 0) {
      exposureColor = '#FFFFFF';
      exposureOpacity = Math.min(0.18, exposure * 0.45);
    } else if (exposure < 0) {
      exposureColor = '#000000';
      exposureOpacity = Math.min(0.22, Math.abs(exposure) * 0.55);
    }

    // 2. Color / Temperature approximation (warm amber vs cool blue)
    const temperature = profile.color?.temperature ?? 0;
    let temperatureColor: string | null = null;
    let temperatureOpacity = 0;
    if (temperature > 0) {
      temperatureColor = '#FFA840';
      temperatureOpacity = Math.min(0.16, (temperature / 800) * 0.16);
    } else if (temperature < 0) {
      temperatureColor = '#4080FF';
      temperatureOpacity = Math.min(0.16, (Math.abs(temperature) / 800) * 0.16);
    }

    // 3. Color / Tint approximation (magenta vs green)
    const tint = profile.color?.tint ?? 0;
    let tintColor: string | null = null;
    let tintOpacity = 0;
    if (tint > 0) {
      tintColor = '#E040B0';
      tintOpacity = Math.min(0.1, (tint / 15) * 0.1);
    } else if (tint < 0) {
      tintColor = '#40D060';
      tintOpacity = Math.min(0.1, (Math.abs(tint) / 15) * 0.1);
    }

    // 4. Texture layers (vignette frame / film grain) were removed from the live preview:
    // they read as translucent gray bands over the viewfinder with no informational value.
    // Texture stays where it belongs — applied to the captured photo in the native pipeline.

    // 5. Texture / Halation approximation (kept: a faint warm glow hint at the highlights)
    const halationAmount = profile.texture?.halation?.amount ?? 0;
    let halationColor: string | null = null;
    let halationOpacity = 0;
    if (halationAmount > 0.05) {
      halationColor = '#FF3020';
      halationOpacity = Math.min(0.12, halationAmount * 0.15);
    }

    return {
      exposureColor,
      exposureOpacity,
      temperatureColor,
      temperatureOpacity,
      tintColor,
      tintOpacity,
      halationColor,
      halationOpacity,
    };
  }, [profile]);

  if (!profile || !overlay) return null;

  return (
    <View style={[StyleSheet.absoluteFillObject, styles.container, style]} pointerEvents="none">
      {/* Exposure / Tone layer */}
      {overlay.exposureColor && overlay.exposureOpacity > 0 && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            {
              backgroundColor: overlay.exposureColor,
              opacity: overlay.exposureOpacity,
            },
          ]}
        />
      )}

      {/* Temperature layer */}
      {overlay.temperatureColor && overlay.temperatureOpacity > 0 && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            {
              backgroundColor: overlay.temperatureColor,
              opacity: overlay.temperatureOpacity,
            },
          ]}
        />
      )}

      {/* Tint layer */}
      {overlay.tintColor && overlay.tintOpacity > 0 && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            {
              backgroundColor: overlay.tintColor,
              opacity: overlay.tintOpacity,
            },
          ]}
        />
      )}

      {/* Halation layer */}
      {overlay.halationColor && overlay.halationOpacity > 0 && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            {
              backgroundColor: overlay.halationColor,
              opacity: overlay.halationOpacity,
            },
          ]}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});

