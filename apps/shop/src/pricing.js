// Cart pricing for the two checkouts. The stable checkout is a plain sum. The new checkout (v2)
// prices every cart line through rules computed over the whole catalogue, which is real CPU work,
// and gives itself a time budget.
import { inSpan } from '@alibi/otel-helpers';

export class PriceBudgetExceeded extends Error {
  constructor(elapsedMs, budgetMs) {
    super(`v2 price rules took ${elapsedMs} ms, the budget is ${budgetMs} ms`);
    this.name = 'PriceBudgetExceeded';
  }
}

export const V2_PRICE_BUDGET_MS = Number(process.env.V2_PRICE_BUDGET_MS ?? 150);
const RULE_ROUNDS = Number(process.env.V2_RULE_ROUNDS ?? 3000);
const CHUNK = 25;

// The stable checkout knows SAVE10. The new checkout ships a new discount table that dropped it.
const STABLE_DISCOUNTS = { SAVE10: { percent: 10 }, WELCOME5: { percent: 5 }, SPRING15: { percent: 15 } };
const V2_DISCOUNTS = { WELCOME5: { percent: 5 }, SPRING15: { percent: 15 } };

function subtotalOf(items, bySku) {
  let cents = 0;
  for (const { sku, qty } of items) {
    const product = bySku.get(sku);
    if (!product) throw new Error(`Unknown product ${sku}`);
    cents += product.price_cents * qty;
  }
  return cents;
}

/** Price rule weight for one product: a smooth curve over its price and category. */
function ruleWeight(product) {
  let x = product.price_cents / 100 + product.category.length;
  for (let round = 0; round < RULE_ROUNDS; round++) {
    x = Math.sqrt(x * x + round) * 0.999 + Math.sin(x) * 0.001;
  }
  return 1 + (x % 1) / 1000;
}

export function stablePrice(items, bySku) {
  return inSpan('checkout_stable.price', {}, () => subtotalOf(items, bySku));
}

export function stableCoupon(subtotal, coupon) {
  return inSpan('checkout_stable.apply_coupon', { 'shop.coupon': coupon ?? 'none' }, () => {
    if (!coupon) return subtotal;
    const discount = STABLE_DISCOUNTS[coupon];
    return discount ? Math.round(subtotal * (1 - discount.percent / 100)) : subtotal;
  });
}

export function v2Price(items, catalogue, bySku) {
  return inSpan('checkout_v2.price', { 'shop.price_budget_ms': V2_PRICE_BUDGET_MS }, () => {
    const started = performance.now();
    const weights = new Map();
    for (let i = 0; i < catalogue.length; i += CHUNK) {
      for (const product of catalogue.slice(i, i + CHUNK)) weights.set(product.sku, ruleWeight(product));
      const elapsed = performance.now() - started;
      if (elapsed > V2_PRICE_BUDGET_MS) throw new PriceBudgetExceeded(Math.round(elapsed), V2_PRICE_BUDGET_MS);
    }
    let cents = 0;
    for (const { sku, qty } of items) {
      const product = bySku.get(sku);
      if (!product) throw new Error(`Unknown product ${sku}`);
      cents += Math.round(product.price_cents * weights.get(sku)) * qty;
    }
    const elapsed = performance.now() - started;
    if (elapsed > V2_PRICE_BUDGET_MS) throw new PriceBudgetExceeded(Math.round(elapsed), V2_PRICE_BUDGET_MS);
    return cents;
  });
}

export function v2Coupon(subtotal, coupon) {
  return inSpan('checkout_v2.apply_coupon', { 'shop.coupon': coupon ?? 'none' }, () => {
    if (!coupon) return subtotal;
    return Math.round(subtotal * (1 - V2_DISCOUNTS[coupon].percent / 100));
  });
}
