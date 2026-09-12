import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CameraProfile } from '../profiles/types';
import { markerGlyph, profileDisplayName } from './types';
import { SafeGlassView, isGlassAvailable } from './GlassCard';
import { ProfileConfigModal } from '../calibration/ProfileConfigModal';

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
// The morph starts from the TopBar capsule's geometry (centered capsule, 44pt tall,
// just below the SafeArea inset) and blooms into the full panel.
const CAPSULE_WIDTH = 210;
const CAPSULE_HEIGHT = 44;
const CAPSULE_TOP = 55;
const PANEL_TOP = 92;

/**
 * Liquid-glass camera selector, following Apple's Liquid Glass morph semantics
 * (developer.apple.com — "Applying Liquid Glass to custom views"): the panel is the SAME
 * glass element as the capsule, interpolating its bounds — never a fade-in of a new view.
 * Content surfaces only after the glass reaches full size, and collapses back into the
 * capsule on close.
 *
 * The bounds interpolation runs on the NATIVE driver via scale/translate transforms
 * (width/height would force a JS-driven animation): the panel is laid out at its final
 * size and the transform pins the scaled top edge onto the capsule position, so the glass
 * material tracks the morph on the GPU at full frame rate.
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
  // Per-camera configuration entry (⚙) restored in the liquid-glass list.
  const [configProfileId, setConfigProfileId] = useState<string | null>(null);

  useEffect(() => {
    animRef.current?.stop();
    if (visible) {
      setMounted(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      animRef.current = Animated.spring(progress, {
        toValue: 1,
        // Apple's bouncy spring feel: quick rise, one visible overshoot, settle.
        tension: 150,
        friction: 9,
        useNativeDriver: true,
      });
      animRef.current.start();
    } else {
      animRef.current = Animated.timing(progress, {
        toValue: 0,
        duration: 170,
        useNativeDriver: true,
      });
      animRef.current.start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted || profiles.length === 0) return null;

  const panelHeight = profiles.length * ROW_HEIGHT;
  // Transform-origin math (RN scales around the center): pin the scaled panel's top edge
  // onto the capsule's top edge at progress 0, landing exactly on the final bounds at 1.
  const originTranslateY = CAPSULE_TOP + CAPSULE_HEIGHT / 2 - (PANEL_TOP + panelHeight / 2);
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0],
    extrapolate: 'clamp',
  });
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [originTranslateY, 0],
    extrapolate: 'clamp',
  });
  const scaleX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [CAPSULE_WIDTH / PANEL_MAX_WIDTH, 1],
    extrapolate: 'clamp',
  });
  const scaleY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [CAPSULE_HEIGHT / panelHeight, 1],
    extrapolate: 'clamp',
  });
  const backdropOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.3],
    extrapolate: 'clamp',
  });
  // Content surfaces only once the glass has bloomed to (or overshot) full size.
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
      {/* Centered host at the panel's final position; the glass itself is transformed */}
      <View style={[styles.morphHost, { top: PANEL_TOP }]} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.morphPanel,
            { height: panelHeight, transform: [{ translateX }, { translateY }, { scaleX }, { scaleY }] },
          ]}
          pointerEvents={visible ? 'auto' : 'none'}
        >
          {/* Liquid Glass spec: the panel is ONE GlassView surface — the material IS the
              background. Content sits as a plain sibling on top; no secondary background,
              no border layers stacked over the glass. */}
          <View style={styles.panelClip}>
            <SafeGlassView
              glassEffectStyle="regular"
              isInteractive
              colorScheme="dark"
              style={styles.panelGlass}
            />
            {!isGlassAvailable() ? <View style={[styles.panelGlass, styles.panelFallback]} /> : null}
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
            </Animated.View>
          </View>
        </Animated.View>
      </View>

      {/* Per-camera JSON import / tune sheet */}
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
    width: PANEL_MAX_WIDTH,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 12,
  },
  panelClip: {
    flex: 1,
    borderRadius: 20,
    overflow: 'hidden',
  },
  panelGlass: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 20,
  },
  panelFallback: {
    backgroundColor: 'rgba(24, 24, 28, 0.9)',
  },
  content: {
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
