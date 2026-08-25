/**
 * The system under test.
 *
 * Nothing here knows the framework exists -- it is ordinary application code
 * that the specification in `spec.md` describes.
 */

/** Round to cents, away from the float knife-edge. */
const cents = (n: number): number => Math.round(n * 100) / 100;

/** Tax applies to goods; shipping is not taxed in these jurisdictions. */
export function calculateTotal(itemsTotal: number, shipping: number, taxRate: number): number {
  return cents(itemsTotal + shipping + itemsTotal * taxRate);
}

/** Transitions the checkout state machine permits. */
const TRANSITIONS = new Set([
  'Cart>Shipping',
  'Shipping>Payment',
  'Shipping>Cart',
  'Payment>Review',
  'Payment>Shipping',
  'Review>Confirm',
  'Review>Payment',
]);

export async function checkNavigation(from: string, to: string): Promise<boolean> {
  return TRANSITIONS.has(`${from}>${to}`);
}

/** Every transition the machine permits, as `From -> To`. */
export function allowedTransitions(): string[] {
  return [...TRANSITIONS].map((t) => t.split('>').join(' -> '));
}

export interface PaymentMethod {
  settlesImmediately: boolean;
  requiresApproval: boolean;
}

const METHODS: Record<string, PaymentMethod> = {
  card: { settlesImmediately: true, requiresApproval: false },
  wallet: { settlesImmediately: true, requiresApproval: false },
  invoice: { settlesImmediately: false, requiresApproval: true },
  transfer: { settlesImmediately: false, requiresApproval: false },
};

export function paymentMethod(name: string): PaymentMethod | undefined {
  return METHODS[name.toLowerCase()];
}

/** Every payment method the system supports. */
export function paymentMethodNames(): string[] {
  return Object.keys(METHODS);
}

/** Registered tax rates, by jurisdiction code. */
const TAX_RATES: Record<string, number> = {
  'DK': 0.25,
  'DE': 0.19,
  'US-CA': 0.0725,
  'GB': 0.2,
};

export function taxRateFor(code: string): number | undefined {
  return TAX_RATES[code.toUpperCase()];
}

/** Every jurisdiction we have a registered rate for. */
export function taxJurisdictions(): string[] {
  return Object.keys(TAX_RATES);
}
