/**
 * Monetization — static product catalog + founding-price window.
 *
 * Prices NEVER appear here (StoreKit `displayPrice` is the only price source);
 * USD figures live in App Store Connect and Camera18Pro.storekit only.
 */

/**
 * MASTER KILL SWITCH. Camera 18 ships 1.0.0 as a fully FREE app (no IAP in the
 * App Store review build). While false, every membership surface is unreachable:
 * the policy grants unlimited access to all cameras, no paywall/badges/Pro row,
 * onboarding drops its trial page, and the JS layer short-circuits all native
 * StoreKit/Keychain calls. The ENTIRE trial/subscription implementation stays in
 * the tree — a later version re-enables it by flipping this to true (plus
 * configuring the products in App Store Connect).
 */
export const MONETIZATION_ENABLED = false;

export const MONTHLY_PRODUCT_ID = 'camera18.pro.monthly';
export const YEARLY_PRODUCT_ID = 'camera18.pro.yearly';

/** Free unlimited shots per premium camera character before Pro is required. */
export const TRIAL_LIMIT = 3;

/**
 * FOUNDING PRICE window end (UTC). Must be set to the SAME instant App Store
 * Connect starts the post-launch prices ($2.99 / $14.99) — planned as public
 * launch + 30 days. TODO(product): replace with the real date before launch;
 * far-future placeholder keeps the badge on until then.
 */
export const FOUNDING_PRICE_END_DATE = '2027-01-01T00:00:00Z';

export function isFoundingPriceActive(now: number = Date.now()): boolean {
  return now < Date.parse(FOUNDING_PRICE_END_DATE);
}

/** Apple account subscriptions page — fallback when the native manage sheet is unavailable. */
export const SUBSCRIPTIONS_MANAGE_URL = 'https://apps.apple.com/account/subscriptions';
