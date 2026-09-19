/**
 * Monetization — static product catalog + founding-price window.
 *
 * Prices NEVER appear here (StoreKit `displayPrice` is the only price source);
 * USD figures live in App Store Connect and Camera18Pro.storekit only.
 */

/**
 * MASTER KILL SWITCH. TRUE as of the 1.0.0 review build (product decision
 * 2026-09-19: ship paid from day one — launch prices $2.99/mo and $14.99/yr,
 * raised to $3.99/mo and $24.99/yr once the product matures, always with "Keep
 * the current price for existing subscribers" so early users keep the launch
 * price). While false every membership surface is unreachable (fully-free
 * build); the trial/subscription implementation stays in the tree either way.
 */
export const MONETIZATION_ENABLED = true;

export const MONTHLY_PRODUCT_ID = 'camera18.pro.monthly';
export const YEARLY_PRODUCT_ID = 'camera18.pro.yearly';

/** Free unlimited shots per premium camera character before Pro is required. */
export const TRIAL_LIMIT = 3;

/**
 * FOUNDING PRICE window end (UTC). The launch prices ($2.99/mo, $14.99/yr) ARE
 * the founding tier; when the mature pricing ($3.99/mo, $24.99/yr — decided
 * 2026-09-19) is scheduled in App Store Connect (with "Keep the current price
 * for existing subscribers"), set this to the SAME UTC instant so old binaries
 * stop advertising the founding badge. TODO(product): replace the far-future
 * placeholder with the real date when the raise is scheduled.
 */
export const FOUNDING_PRICE_END_DATE = '2027-01-01T00:00:00Z';

export function isFoundingPriceActive(now: number = Date.now()): boolean {
  return now < Date.parse(FOUNDING_PRICE_END_DATE);
}

/** Apple account subscriptions page — fallback when the native manage sheet is unavailable. */
export const SUBSCRIPTIONS_MANAGE_URL = 'https://apps.apple.com/account/subscriptions';
