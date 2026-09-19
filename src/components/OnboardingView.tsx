import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { t } from '../i18n';
import type { CameraProfile } from '../profiles/types';
import { MONETIZATION_ENABLED } from '../monetization/MonetizationConfig';
import { markerGlyph } from './types';

export const CURRENT_ONBOARDING_VERSION = 1;

export interface OnboardingViewProps {
  readonly visible: boolean;
  readonly profiles: readonly CameraProfile[];
  /** Live hardware aperture range (honesty: page 1 shows what the product supports). */
  readonly apertureRange: { min: number; max: number } | null;
  readonly onComplete: () => void;
}

const fLabel = (value: number | undefined | null): string =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? `ƒ/${value.toFixed(1).replace(/\.0$/, '')}`
    : 'ƒ/x';

/**
 * First-launch onboarding (spec §8–§10): exactly 3 pages, NO purchase button, and
 * NO paywall afterwards — the user reaches the camera and the real product first.
 * Completion (or Skip) persists completedOnboardingVersion and never shows again.
 */
export const OnboardingView: React.FC<OnboardingViewProps> = ({
  visible,
  profiles,
  apertureRange,
  onComplete,
}) => {
  const [page, setPage] = useState<number>(0);
  const marker = useRef(new Animated.Value(0)).current;
  // Free 1.0.0 build (MONETIZATION_ENABLED off): page 3 IS the free-model page —
  // it ships only with membership enabled, so onboarding runs as 2 pages.
  const pageCount = MONETIZATION_ENABLED ? 3 : 2;

  useEffect(() => {
    if (!visible) return;
    setPage(0);
  }, [visible]);

  // Page 1 ambient motion: the aperture marker sweeps the continuous range forever.
  useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(marker, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(marker, { toValue: 0, duration: 2600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, marker, page]);

  const finish = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onComplete();
  };

  const advance = () => {
    Haptics.selectionAsync().catch(() => {});
    if (page >= pageCount - 1) {
      finish();
    } else {
      setPage(page + 1);
    }
  };

  // Page 2 grid: the 8 camera characters (icon glyph + short name + own accent).
  const gridProfiles = useMemo(() => profiles.slice(0, 8), [profiles]);
  const markerLeft = marker.interpolate({
    inputRange: [0, 1],
    outputRange: ['8%', '88%'],
    extrapolate: 'clamp',
  });

  return (
    <Modal animationType="fade" onRequestClose={finish} statusBarTranslucent visible={visible}>
      <View style={styles.root}>
        {page < pageCount - 1 ? (
          <Pressable accessibilityLabel={t('onbSkip')} accessibilityRole="button" hitSlop={12} onPress={finish} style={styles.skip}>
            <Text style={styles.skipText}>{t('onbSkip')}</Text>
          </Pressable>
        ) : null}

        <View style={styles.dotsRow}>
          {Array.from({ length: pageCount }, (_, i) => (
            <View key={i} style={[styles.dot, i === page && styles.dotActive]} />
          ))}
        </View>

        {page === 0 ? (
          <View style={styles.page}>
            <Text style={styles.title}>{t('onbApertureTitle')}</Text>
            <Text style={styles.subtitle}>{t('onbApertureSubtitle')}</Text>
            {/* Continuous-aperture visual in the product's own language: a real
                marker sweeping between the REAL supported f-stops of this build. */}
            <View style={styles.apertureStage}>
              <Text style={styles.apertureEnd}>{fLabel(apertureRange?.min)}</Text>
              <View style={styles.apertureTrack}>
                <View style={styles.apertureLine} />
                <Animated.View style={[styles.apertureMarker, { left: markerLeft }]} />
              </View>
              <Text style={styles.apertureEnd}>{fLabel(apertureRange?.max)}</Text>
            </View>
          </View>
        ) : null}

        {page === 1 ? (
          <View style={styles.page}>
            <Text style={styles.title}>{t('onbCharactersTitle')}</Text>
            <Text style={styles.subtitle}>{t('onbCharactersSubtitle')}</Text>
            <View style={styles.characterGrid}>
              {gridProfiles.map((profile) => (
                <View key={profile.id} style={styles.characterCell}>
                  <Text style={[styles.characterGlyph, { color: profile.ui?.accent || '#FFFFFF' }]}>
                    {markerGlyph(profile.ui?.markerStyle)}
                  </Text>
                  <Text style={styles.characterName}>{profile.ui?.shortName ?? profile.id}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {page === 2 ? (
          <View style={styles.page}>
            <Text style={styles.title}>{t('onbTrialTitle')}</Text>
            <Text style={styles.subtitle}>{t('onbTrialGritYours')}</Text>
            <Text style={styles.subtitle}>{t('onbTrialTryOthers')}</Text>
            <View style={[styles.tierCard, styles.tierCardGrit]}>
              <Text style={styles.tierCardName}>GRIT N</Text>
              <Text style={styles.tierCardMeta}>{t('onbTrialUnlimited')}</Text>
            </View>
            <View style={styles.tierCard}>
              <Text style={styles.tierCardNameDim}>{t('onbTrialFreeShots')}</Text>
              <View style={styles.shotDotsRow}>
                <View style={styles.shotDot} />
                <View style={styles.shotDot} />
                <View style={styles.shotDot} />
              </View>
            </View>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={advance}
          style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
        >
          <Text style={styles.ctaText}>{page >= pageCount - 1 ? t('onbStartShooting') : t('onbContinue')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
};

const ACCENT = '#E8B84B';

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A0A0C',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  skip: {
    position: 'absolute',
    top: 64,
    right: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  skipText: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 14,
    fontWeight: '600',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 36,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
  },
  dotActive: {
    backgroundColor: ACCENT,
  },
  page: {
    alignItems: 'center',
    width: '100%',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 36,
    letterSpacing: 0.2,
  },
  subtitle: {
    color: 'rgba(255, 255, 255, 0.64)',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 20,
  },
  apertureStage: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    maxWidth: 320,
    marginTop: 56,
    gap: 12,
  },
  apertureEnd: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  apertureTrack: {
    flex: 1,
    height: 40,
    justifyContent: 'center',
  },
  apertureLine: {
    height: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 1,
  },
  apertureMarker: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: ACCENT,
    top: 13,
    shadowColor: ACCENT,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 8,
  },
  characterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 44,
    maxWidth: 320,
    gap: 18,
  },
  characterCell: {
    alignItems: 'center',
    width: 64,
  },
  characterGlyph: {
    fontSize: 20,
    marginBottom: 6,
  },
  characterName: {
    color: 'rgba(255, 255, 255, 0.78)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  tierCard: {
    width: '100%',
    maxWidth: 280,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.16)',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 16,
  },
  tierCardGrit: {
    borderColor: 'rgba(232, 184, 75, 0.6)',
    backgroundColor: 'rgba(232, 184, 75, 0.08)',
  },
  tierCardName: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 1,
  },
  tierCardNameDim: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  tierCardMeta: {
    color: ACCENT,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginTop: 6,
  },
  shotDotsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  shotDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.85)',
  },
  cta: {
    position: 'absolute',
    bottom: 72,
    borderRadius: 18,
    backgroundColor: ACCENT,
    paddingVertical: 16,
    paddingHorizontal: 48,
  },
  ctaPressed: {
    opacity: 0.75,
  },
  ctaText: {
    color: '#141414',
    fontSize: 16,
    fontWeight: '800',
  },
});
