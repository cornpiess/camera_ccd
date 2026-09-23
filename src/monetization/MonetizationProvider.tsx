import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  addProChangedListener,
  commitTrialShot,
  fetchIsPro,
  fetchProducts,
  getTrialUsedShots,
  purchase as nativePurchase,
  reserveTrialShot as nativeReserve,
  restorePurchases as nativeRestore,
  rollbackTrialShot as nativeRollback,
  type PurchaseOutcome,
  type RestoreOutcome,
  type StoreProduct,
} from './Monetization';

/**
 * In-memory monetization state (spec §27): isPro and the trial snapshot live in
 * React state; every persistence (Keychain/StoreKit) happens natively and async.
 * NOTHING here runs inside the preview/capture hot path — the shutter gate reads
 * these values synchronously before the capture starts.
 */
export interface MonetizationContextValue {
  readonly isPro: boolean;
  readonly products: StoreProduct[];
  readonly productsLoaded: boolean;
  /** Re-fetch products (StoreKit hiccup / offline at first load → Paywall retry). */
  reloadProducts(): void;
  /** profileId -> permanently consumed trial shots (in-flight reservations excluded). */
  readonly trialUsed: Record<string, number>;
  purchase(productId: string): Promise<PurchaseOutcome>;
  restorePurchases(): Promise<RestoreOutcome>;
  reserveTrialShot(profileId: string): boolean;
  commitTrialShot(profileId: string): void;
  rollbackTrialShot(profileId: string): void;
  refreshTrialState(): void;
}

const MonetizationContext = createContext<MonetizationContextValue | null>(null);

export const MonetizationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isPro, setIsPro] = useState<boolean>(false);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [productsLoaded, setProductsLoaded] = useState<boolean>(false);
  const [trialUsed, setTrialUsed] = useState<Record<string, number>>({});
  const trialUsedRef = useRef<Record<string, number>>({});

  const refreshTrialState = useCallback(() => {
    const snapshot = getTrialUsedShots();
    trialUsedRef.current = snapshot;
    setTrialUsed(snapshot);
  }, []);

  const reloadProducts = useCallback(() => {
    setProductsLoaded(false);
    void fetchProducts()
      .then((list) => {
        setProducts(list);
        setProductsLoaded(true);
      })
      .catch(() => setProductsLoaded(true));
  }, []);

  useEffect(() => {
    // Launch sequence (spec §18): entitlement check + trial snapshot.
    // All best-effort — a StoreKit failure must never block the camera.
    // NOTE: products are NOT fetched here on purpose. Product.products(for:) is the
    // only launch-time call that hits the App Store network, and on first run it
    // triggers the OS network-permission prompt — an offline-first camera must not
    // ask for network just for existing. The paywall loads products on open instead.
    void fetchIsPro().then(setIsPro).catch(() => {});
    refreshTrialState();

    const sub = addProChangedListener((event) => {
      if (typeof event?.isPro === 'boolean') setIsPro(event.isPro);
    });
    // Foreground return: lightweight entitlement refresh (renewals/expiries that
    // happened while backgrounded).
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void fetchIsPro().then(setIsPro).catch(() => {});
    });
    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, [refreshTrialState]);

  const value = useMemo<MonetizationContextValue>(
    () => ({
      isPro,
      products,
      productsLoaded,
      reloadProducts,
      trialUsed,
      purchase: nativePurchase,
      restorePurchases: nativeRestore,
      reserveTrialShot: (profileId: string) => nativeReserve(profileId),
      // After a commit the badge must drop to the new remaining count immediately;
      // rollbacks only matter when a reservation existed (no visible change).
      commitTrialShot: (profileId: string) => {
        commitTrialShot(profileId);
        refreshTrialState();
      },
      rollbackTrialShot: (profileId: string) => {
        nativeRollback(profileId);
        refreshTrialState();
      },
      refreshTrialState,
    }),
    [isPro, products, productsLoaded, reloadProducts, trialUsed, refreshTrialState],
  );

  return <MonetizationContext.Provider value={value}>{children}</MonetizationContext.Provider>;
};

export function useMonetization(): MonetizationContextValue {
  const ctx = useContext(MonetizationContext);
  if (!ctx) throw new Error('useMonetization requires MonetizationProvider');
  return ctx;
}
