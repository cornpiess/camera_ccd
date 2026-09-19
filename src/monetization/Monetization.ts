import { requireNativeModule } from 'expo-modules-core';
import { recordDiag } from '../utils/diagLog';
import { MONETIZATION_ENABLED, MONTHLY_PRODUCT_ID, YEARLY_PRODUCT_ID } from './MonetizationConfig';

/**
 * Guarded access to the native Monetization module (StoreKit 2 + Keychain trial
 * store), mirroring the CameraEngine guarded-resolution pattern: a missing/mismatched
 * native side must degrade to a FREE, still-usable camera — never a launch crash.
 *
 * Degraded-mode semantics (deliberate): isPro=false and trial reservations always
 * succeed. Blocking photography because the entitlement module is missing would be
 * worse than temporarily unenforced premium trials.
 */

export type StoreProduct = {
  id: string;
  displayPrice: string;
  period: 'monthly' | 'yearly';
};

export type PurchaseOutcome =
  | { ok: true; isPro: boolean }
  | { ok: false; reason: 'unverified' | 'failed' }
  | { pending: true }
  | { cancelled: true };

export type RestoreOutcome = { restored: boolean };

type NativeMonetization = {
  isPro(): Promise<boolean>;
  getProducts(): Promise<{ id: string; displayPrice: string; period: string }[]>;
  purchase(productID: string): Promise<Record<string, unknown>>;
  restorePurchases(): Promise<Record<string, unknown>>;
  showManageSubscriptions(): Promise<void>;
  getTrialUsedShots(): Record<string, number>;
  reserveTrialShot(profileID: string): boolean;
  commitTrialShot(profileID: string): void;
  rollbackTrialShot(profileID: string): void;
  resetTrials(): boolean;
  addListener(event: string, cb: (event: unknown) => void): { remove: () => void };
};

let native: NativeMonetization | null = null;
try {
  // Static requireNativeModule would abort the whole JS bundle on failure — resolve
  // once, guarded, exactly like CameraEngine's native resolution.
  native = requireNativeModule<NativeMonetization>('Monetization');
} catch (err) {
  recordDiag('error', `Monetization native resolution failed: ${err instanceof Error ? err.message : String(err)}`);
}

export const monetizationNativeAvailable = native !== null && MONETIZATION_ENABLED;

export function fetchIsPro(): Promise<boolean> {
  return native && MONETIZATION_ENABLED ? native.isPro() : Promise.resolve(false);
}

export async function fetchProducts(): Promise<StoreProduct[]> {
  if (!native || !MONETIZATION_ENABLED) return [];
  try {
    const raw = await native.getProducts();
    return raw
      .filter((p) => p.id === MONTHLY_PRODUCT_ID || p.id === YEARLY_PRODUCT_ID)
      .map((p) => ({
        id: p.id,
        displayPrice: typeof p.displayPrice === 'string' ? p.displayPrice : '',
        period: p.id === YEARLY_PRODUCT_ID ? ('yearly' as const) : ('monthly' as const),
      }));
  } catch {
    return [];
  }
}

function toPurchaseOutcome(payload: Record<string, unknown>): PurchaseOutcome {
  if (payload && typeof payload === 'object') {
    const record = payload as { ok?: unknown; isPro?: unknown; reason?: unknown; pending?: unknown; cancelled?: unknown };
    if (record.pending === true) return { pending: true };
    if (record.cancelled === true) return { cancelled: true };
    if (record.ok === true) return { ok: true, isPro: record.isPro === true };
    if (record.ok === false && (record.reason === 'unverified' || record.reason === 'failed')) {
      return { ok: false, reason: record.reason };
    }
  }
  return { ok: false, reason: 'failed' };
}

export async function purchase(productID: string): Promise<PurchaseOutcome> {
  if (!native) return { ok: false, reason: 'failed' };
  try {
    return toPurchaseOutcome(await native.purchase(productID));
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function restorePurchases(): Promise<RestoreOutcome> {
  if (!native) return { restored: false };
  try {
    const payload = (await native.restorePurchases()) as { restored?: unknown };
    return { restored: payload.restored === true };
  } catch {
    return { restored: false };
  }
}

export function showManageSubscriptions(): Promise<void> {
  return native ? native.showManageSubscriptions() : Promise.reject(new Error('unavailable'));
}

export function getTrialUsedShots(): Record<string, number> {
  if (!native) return {};
  try {
    return native.getTrialUsedShots() ?? {};
  } catch {
    return {};
  }
}

export function reserveTrialShot(profileID: string): boolean {
  if (!native || !MONETIZATION_ENABLED) return true;
  try {
    return native.reserveTrialShot(profileID);
  } catch {
    return true;
  }
}

export function commitTrialShot(profileID: string): void {
  if (!native || !MONETIZATION_ENABLED) return;
  try {
    native.commitTrialShot(profileID);
  } catch {
    // Best-effort: a lost commit only means one extra free shot — never block saving.
  }
}

export function rollbackTrialShot(profileID: string): void {
  if (!native || !MONETIZATION_ENABLED) return;
  try {
    native.rollbackTrialShot(profileID);
  } catch {
    // Same leniency as commit.
  }
}

/** TESTING BUILDS ONLY (native DEBUG/CAMERA18_TESTING gate compiles this out in production). */
export function resetTrials(): boolean {
  try {
    return native?.resetTrials() ?? false;
  } catch {
    return false;
  }
}

export type ProChangedEvent = { readonly isPro: boolean };

export function addProChangedListener(cb: (event: ProChangedEvent) => void): { remove: () => void } {
  if (!native) return { remove: () => {} };
  try {
    return native.addListener('onProChanged', cb as (event: unknown) => void) as { remove: () => void };
  } catch {
    return { remove: () => {} };
  }
}
