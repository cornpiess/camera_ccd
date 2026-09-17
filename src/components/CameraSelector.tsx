import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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
  /**
   * Dim version label at the footer-left (e.g. "v1.0.0"). Also the SECRET TEST-GATE
   * tap target: 7 quick taps reveal the mock aperture menu (App.tsx owns the gesture
   * and the compile-time gating). Absent = no label, no gesture target.
   */
  readonly versionLabel?: string;
  readonly onVersionPress?: () => void;
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
// Legal footer pinned under the profile list (用户协议 / 隐私政策 / 支持).
const FOOTER_HEIGHT = 44;

// 协议页面固定挂在 GitHub Pages。open 前按 https + 精确 host/路径形态校验，只放行
// 本项目自己的三个页面 —— 拼接结果不符合就直接丢弃，绝不交给系统打开。
const LEGAL_PAGES = {
  terms: 'terms.html',
  privacy: 'privacy.html',
  support: 'support.html',
} as const;
const LEGAL_URL_PATTERN = /^https:\/\/cornpiess\.github\.io\/camera18\/[a-z]+\.html$/;

const openLegalPage = (page: string) => {
  const url = `https://cornpiess.github.io/camera18/${page}`;
  if (!LEGAL_URL_PATTERN.test(url)) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  Linking.openURL(url).catch(() => {});
};

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
  versionLabel,
  onVersionPress,
}: CameraSelectorProps) => {
  // `mounted` keeps the tree alive while the close animation pours the panel back.
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  // Per-camera configuration entry (⚙) restored in the liquid-glass list.
  const [configProfileId, setConfigProfileId] = useState<string | null>(null);
  const { height: screenHeight } = useWindowDimensions();
  // Keep the active camera visible when the list overflows (24+ profiles).
  const scrollRef = useRef<ScrollView>(null);
  // 24+ profiles overflow the screen: cap the panel and scroll the rows. The morph math
  // uses the CAPPED height so the glass still lands exactly on the capsule at progress 0.
  // The legal footer is part of the panel — its height counts toward the morph math.
  const maxPanelHeight = Math.round(screenHeight * 0.62);
  const panelHeight = Math.min(profiles.length * ROW_HEIGHT, maxPanelHeight) + FOOTER_HEIGHT;

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

  // Open with the active camera scrolled into view (list can exceed the panel height).
  useEffect(() => {
    if (!visible) return;
    const activeIndex = profiles.findIndex((p) => p.id === activeProfileId);
    if (activeIndex > 0) {
      const y = Math.max(0, activeIndex * ROW_HEIGHT - panelHeight / 2 + ROW_HEIGHT / 2);
      scrollRef.current?.scrollTo({ y, animated: false });
    }
  }, [visible, activeProfileId, profiles, panelHeight]);

  if (!mounted || profiles.length === 0) return null;
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
              <ScrollView
                ref={scrollRef}
                style={styles.list}
                nestedScrollEnabled
                showsVerticalScrollIndicator={false}
              >
              {profiles.map((profile) => {
                const isActive = profile.id === activeProfileId;
                const accent = profile.ui?.accent || '#FFFFFF';
                const displayName = profileDisplayName(profile);
                const preferred = profile.aperture?.preferred;
                return (
                  <Pressable
                    key={profile.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                    accessibilityLabel={`${displayName}${isActive ? ', selected' : ''}${
                      typeof preferred === 'number' ? `, recommended ƒ/${preferred}` : ''
                    }`}
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
                    {typeof preferred === 'number' && Number.isFinite(preferred) ? (
                      // Recommended aperture, snapped-to on selection (Ricoh GR → ƒ/2.8).
                      <Text
                        style={[
                          styles.rowAperture,
                          isActive && { color: accent },
                        ]}
                        numberOfLines={1}
                      >
                        {`ƒ/${preferred.toFixed(1).replace(/\.0$/, '')}`}
                      </Text>
                    ) : null}
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
              </ScrollView>
              {/* 法务入口（固定底栏，不随列表滚动）：用户协议 / 隐私政策 / 支持。
                  全 app 没有独立设置页 —— 相机胶囊 → 本面板是唯一菜单表面。 */}
              <View style={styles.footer}>
                {versionLabel ? (
                  <>
                    <Pressable
                      accessibilityLabel={`Version ${versionLabel}`}
                      accessibilityRole="text"
                      hitSlop={6}
                      style={({ pressed }) => [styles.footerLink, pressed && styles.footerLinkPressed]}
                      onPress={onVersionPress}
                    >
                      <Text style={styles.versionText}>{versionLabel}</Text>
                    </Pressable>
                    <Text style={styles.footerDot}>·</Text>
                  </>
                ) : null}
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="用户协议"
                  hitSlop={6}
                  style={({ pressed }) => [styles.footerLink, pressed && styles.footerLinkPressed]}
                  onPress={() => openLegalPage(LEGAL_PAGES.terms)}
                >
                  <Text style={styles.footerText}>用户协议</Text>
                </Pressable>
                <Text style={styles.footerDot}>·</Text>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="隐私政策"
                  hitSlop={6}
                  style={({ pressed }) => [styles.footerLink, pressed && styles.footerLinkPressed]}
                  onPress={() => openLegalPage(LEGAL_PAGES.privacy)}
                >
                  <Text style={styles.footerText}>隐私政策</Text>
                </Pressable>
                <Text style={styles.footerDot}>·</Text>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="支持页面"
                  hitSlop={6}
                  style={({ pressed }) => [styles.footerLink, pressed && styles.footerLinkPressed]}
                  onPress={() => openLegalPage(LEGAL_PAGES.support)}
                >
                  <Text style={styles.footerText}>支持</Text>
                </Pressable>
              </View>
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
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
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
  rowAperture: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
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
  footer: {
    height: FOOTER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.14)',
  },
  footerLink: {
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  footerLinkPressed: {
    opacity: 0.6,
  },
  footerText: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 12,
    fontWeight: '600',
  },
  footerDot: {
    color: 'rgba(255, 255, 255, 0.35)',
    fontSize: 12,
  },
  versionText: {
    color: 'rgba(255, 255, 255, 0.40)',
    fontSize: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
