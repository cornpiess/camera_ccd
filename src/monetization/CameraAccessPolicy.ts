import type { CameraProfile } from '../profiles/types';
import { MONETIZATION_ENABLED, TRIAL_LIMIT } from './MonetizationConfig';

/**
 * Pure permission layer (spec §5): the ONLY place capture-vs-paywall decisions are
 * derived. UI badges and the shutter gate both call this, so they can never disagree.
 * Knows nothing about StoreKit — it consumes the in-memory isPro / trial snapshot.
 */

/** GRIT N — the only permanently-free unlimited camera character. */
export const FREE_UNLIMITED_PROFILE_ID = 'ricoh_negative';

export type CameraAccess =
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'trial'; readonly remaining: number }
  | { readonly kind: 'requiresPro' };

/**
 * Rule set (defaults per spec §26.8):
 * - profile JSON may opt OUT with `"accessTier": "free"` (explicit, future cameras);
 * - GRIT N (ricoh_negative) is free-unlimited;
 * - every other profile defaults to premium-metered (3 free shots);
 * - an active Pro subscription unlocks everything.
 */
export function accessFor(
  profileId: string,
  isPro: boolean,
  trialUsed: Record<string, number>,
  profile?: CameraProfile | null,
): CameraAccess {
  // Kill switch (1.0.0 ships as a fully free app): everything is unlimited.
  if (!MONETIZATION_ENABLED) return { kind: 'unlimited' };
  // Explicit config override wins (future free cameras declare themselves here).
  const tier = (profile as { accessTier?: unknown } | null | undefined)?.accessTier;
  if (tier === 'free' || profileId === FREE_UNLIMITED_PROFILE_ID) {
    return { kind: 'unlimited' };
  }
  if (isPro) return { kind: 'unlimited' };
  const used = Math.min(Math.max(trialUsed[profileId] ?? 0, 0), TRIAL_LIMIT);
  const remaining = TRIAL_LIMIT - used;
  if (remaining > 0) return { kind: 'trial', remaining };
  return { kind: 'requiresPro' };
}
