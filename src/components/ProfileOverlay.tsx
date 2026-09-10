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

    // 4. Texture / Vignette approximation
    const vignetteAmount = profile.texture?.vignette?.amount ?? 0;
    const vignetteRadius = profile.texture?.vignette?.radius ?? 0.7;
    const vignetteOpacity = vignetteAmount > 0 ? Math.min(0.65, vignetteAmount * 1.6) : 0;
    const vignetteBorderWidth = Math.round(36 * (1.1 - Math.min(1, Math.max(0.4, vignetteRadius))));

    // 5. Texture / Grain approximation
    const grainAmount = profile.texture?.grain?.amount ?? 0;
    const grainOpacity = grainAmount > 0 ? Math.min(0.2, grainAmount * 0.35) : 0;

    // 6. Texture / Halation approximation
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
      vignetteOpacity,
      vignetteBorderWidth,
      grainOpacity,
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

      {/* Vignette layer */}
      {overlay.vignetteOpacity > 0 && (
        <View
          style={[
            styles.vignetteFrame,
            {
              borderWidth: overlay.vignetteBorderWidth,
              opacity: overlay.vignetteOpacity,
            },
          ]}
        />
      )}

      {/* Film grain layer */}
      {overlay.grainOpacity > 0 && (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            styles.grainLayer,
            { opacity: overlay.grainOpacity },
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
  vignetteFrame: {
    ...StyleSheet.absoluteFillObject,
    borderColor: 'rgba(0, 0, 0, 0.5)',
    zIndex: 1,
  },
  grainLayer: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    zIndex: 2,
  },
});

