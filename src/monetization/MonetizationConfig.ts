/**
 * Monetization — static product catalog + founding-price window.
 *
 * Prices NEVER appear here (StoreKit `displayPrice` is the only price source);
 * USD figures live in App Store Connect and Camera18Pro.storekit only.
 */

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
