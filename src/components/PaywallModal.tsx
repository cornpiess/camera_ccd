import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { t } from '../i18n';
import { useMonetization } from '../monetization/MonetizationProvider';
import { showManageSubscriptions } from '../monetization/Monetization';
import {
  isFoundingPriceActive,
  MONTHLY_PRODUCT_ID,
  YEARLY_PRODUCT_ID,
} from '../monetization/MonetizationConfig';
import { recordDiag } from '../utils/diagLog';

export type PaywallSource = 'trialExhausted' | 'proBadge' | 'settings';

export interface PaywallModalProps {
  readonly visible: boolean;
  /** Analytics-free but kept for diagnostics: why the paywall appeared. */
  readonly source: PaywallSource | null;
  readonly onClose: () => void;
}

const LEGAL_URLS = {
  terms: 'https://cornpiess.github.io/camera18/terms.html',
  privacy: 'https://cornpiess.github.io/camera18/privacy.html',
} as const;

const MANAGE_FALLBACK_URL = 'https://apps.apple.com/account/subscriptions';

/**
 * Camera 18 Pro paywall (spec §15). Prices ALWAYS come from StoreKit
 * `displayPrice` — the USD launch figures never appear in code. Yearly is the
 * default selection; during the founding window the yearly card carries the
 * FOUNDING PRICE badge, which hides itself automatically once the configured
 * end date passes (old binaries stop advertising a dead offer).
 */
export const PaywallModal: React.FC<PaywallModalProps> = ({ visible, source, onClose }) => {
  const { isPro, products, productsLoaded, reloadProducts, purchase, restorePurchases } = useMonetization();
  const [selected, setSelected] = useState<string>(YEARLY_PRODUCT_ID);
  const [busy, setBusy] = useState<boolean>(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);

  // The paywall closes itself the moment Pro is active (purchase succeeded here,
  // or entitlement landed via the Transaction.updates listener).
  useEffect(() => {
    if (visible && isPro) onClose();
  }, [visible, isPro, onClose]);

  useEffect(() => {
    if (visible) {
      setStatusLine(null);
      setBusy(false);
      // Products load HERE, not at app launch: Product.products(for:) is the one
      // StoreKit call that hits the App Store network, and the OS network-permission
      // prompt must only ever appear when the user actually opens the paywall.
      if (!productsLoaded) reloadProducts();
      if (source) recordDiag('info', `paywall: presented (source=${source})`);
    }
  }, [visible, source, productsLoaded, reloadProducts]);

  const founding = useMemo(() => isFoundingPriceActive(), []);
  const yearly = products.find((p) => p.id === YEARLY_PRODUCT_ID) ?? null;
  const monthly = products.find((p) => p.id === MONTHLY_PRODUCT_ID) ?? null;
  // StoreKit hiccup / offline at load: offer an explicit retry instead of empty
  // price cards (the camera itself is unaffected — this is paywall-surface only).
  const productsEmpty = productsLoaded && products.length === 0;

  // AUTO-RETRY (user-reported 2026-09-24): on the FIRST paywall open the OS
  // network-permission dialog appears mid-request and that fetch fails even though
  // the user then grants permission — the price cards stayed empty until a manual
  // Retry tap. Two automatic backoff reloads (800ms / 2.5s) swallow that failure
  // window; the manual Retry button only remains after both come back empty.
  const autoRetryRef = useRef(0);
  useEffect(() => {
    if (!visible) {
      autoRetryRef.current = 0;
      return;
    }
    if (!productsEmpty || autoRetryRef.current >= 2) return;
    const delay = autoRetryRef.current === 0 ? 800 : 2500;
    const timer = setTimeout(() => {
      autoRetryRef.current += 1;
      reloadProducts();
    }, delay);
    return () => clearTimeout(timer);
  }, [visible, productsEmpty, reloadProducts]);

  const handlePurchase = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatusLine(null);
    const result = await purchase(selected);
    if ('pending' in result) {
      setStatusLine(t('paywallPending'));
    } else if ('cancelled' in result) {
      // Silent by design — cancellation is not an error.
    } else if (result.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Entitlement state flows in via onProChanged / provider; effect closes the modal.
    } else {
      setStatusLine(result.reason === 'unverified' ? t('paywallVerificationFailed') : t('paywallPurchaseFailed'));
    }
    setBusy(false);
  }, [busy, purchase, selected]);

  const handleRestore = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const result = await restorePurchases();
    setStatusLine(result.restored ? t('paywallRestored') : t('paywallNoSubscription'));
    setBusy(false);
  }, [busy, restorePurchases]);

  const handleManage = useCallback(() => {
    showManageSubscriptions().catch(() => {
      Linking.openURL(MANAGE_FALLBACK_URL).catch(() => {});
    });
  }, []);

  const renderCard = (
    kind: 'yearly' | 'monthly',
    productId: string,
    price: string | null,
    active: boolean,
  ) => (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        setSelected(productId);
      }}
      style={[styles.card, active && styles.cardActive]}
    >
      <View style={styles.cardHead}>
        <Text style={styles.cardPeriod}>{kind === 'yearly' ? t('paywallYearly') : t('paywallMonthly')}</Text>
        {kind === 'yearly' && founding ? (
          <View style={styles.foundingBadge}>
            <Text style={styles.foundingBadgeText}>{t('paywallFoundingPrice')}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.cardPrice}>{price ?? (productsLoaded ? '' : t('paywallLoading'))}</Text>
      {kind === 'yearly' && founding ? (
        <Text style={styles.cardNote}>{t('paywallKeepFounding')}</Text>
      ) : null}
    </Pressable>
  );

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close paywall" accessibilityRole="button" style={StyleSheet.absoluteFillObject} onPress={onClose} />
        <View style={styles.sheet}>
          <Pressable accessibilityLabel="Close" accessibilityRole="button" hitSlop={12} onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeGlyph}>✕</Text>
          </Pressable>

          <Text style={styles.title}>{t('paywallTitle')}</Text>
          <Text style={styles.subtitle}>{t('paywallSubtitle')}</Text>

          {renderCard('yearly', YEARLY_PRODUCT_ID, yearly?.displayPrice ?? null, selected === YEARLY_PRODUCT_ID)}
          {renderCard('monthly', MONTHLY_PRODUCT_ID, monthly?.displayPrice ?? null, selected === MONTHLY_PRODUCT_ID)}

          {productsEmpty ? (
            <View style={styles.retryBlock}>
              <Text style={styles.retryHint}>{t('paywallOfflineHint')}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => reloadProducts()}
                style={({ pressed }) => [styles.retryRow, pressed && styles.ctaPressed]}
              >
                <Text style={styles.retryText}>{t('paywallRetry')}</Text>
              </Pressable>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => { void handlePurchase(); }}
            style={({ pressed }) => [styles.cta, (busy || pressed) && styles.ctaPressed]}
          >
            <Text style={styles.ctaText}>{t('paywallUnlockCta')}</Text>
          </Pressable>

          {statusLine ? <Text style={styles.statusLine}>{statusLine}</Text> : null}

          <View style={styles.footerRow}>
            {isPro ? (
              <Pressable hitSlop={6} onPress={handleManage}>
                <Text style={styles.footerLink}>{t('proRowManage')}</Text>
              </Pressable>
            ) : (
              <Pressable hitSlop={6} disabled={busy} onPress={() => { void handleRestore(); }}>
                <Text style={styles.footerLink}>{t('paywallRestore')}</Text>
              </Pressable>
            )}
            <Text style={styles.footerDot}>·</Text>
            <Pressable hitSlop={6} onPress={() => Linking.openURL(LEGAL_URLS.terms).catch(() => {})}>
              <Text style={styles.footerLink}>{t('legalTerms')}</Text>
            </Pressable>
            <Text style={styles.footerDot}>·</Text>
            <Pressable hitSlop={6} onPress={() => Linking.openURL(LEGAL_URLS.privacy).catch(() => {})}>
              <Text style={styles.footerLink}>{t('legalPrivacy')}</Text>
            </Pressable>
          </View>
          <Text style={styles.autoRenewNote}>{t('paywallAutoRenewNote')}</Text>
        </View>
      </View>
    </Modal>
  );
};

const ACCENT = '#E8B84B';

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 24,
    backgroundColor: 'rgba(22, 22, 26, 0.98)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    paddingTop: 28,
    paddingBottom: 18,
    paddingHorizontal: 20,
  },
  closeButton: {
    position: 'absolute',
    top: 10,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 16,
    fontWeight: '700',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  subtitle: {
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 20,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.16)',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  cardActive: {
    borderColor: ACCENT,
    backgroundColor: 'rgba(232, 184, 75, 0.10)',
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardPeriod: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  foundingBadge: {
    backgroundColor: ACCENT,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  foundingBadgeText: {
    color: '#141414',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  cardPrice: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    marginTop: 8,
    fontVariant: ['tabular-nums'],
  },
  cardNote: {
    color: 'rgba(232, 184, 75, 0.85)',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  cta: {
    borderRadius: 16,
    backgroundColor: ACCENT,
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 8,
  },
  ctaPressed: {
    opacity: 0.75,
  },
  ctaText: {
    color: '#141414',
    fontSize: 15,
    fontWeight: '800',
  },
  statusLine: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 12,
  },
  retryBlock: {
    width: '100%',
    alignItems: 'center',
  },
  retryHint: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 2,
  },
  retryRow: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 4,
    marginBottom: 4,
  },
  retryText: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 13,
    fontWeight: '700',
  },
  footerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 18,
  },
  footerLink: {
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: 12,
    fontWeight: '600',
  },
  footerDot: {
    color: 'rgba(255, 255, 255, 0.35)',
    fontSize: 12,
  },
  autoRenewNote: {
    color: 'rgba(255, 255, 255, 0.40)',
    fontSize: 10,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 14,
  },
});
