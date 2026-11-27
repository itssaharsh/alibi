/** One plain sentence for each word a newcomer may trip on. Shown on hover or focus and once in "Words used here". */
export const GLOSSARY = {
  'checkout_v2': ['checkout_v2', 'The Flagsmith feature flag that turns the new checkout on for half of the shoppers.'],
  'flagged code': ['Flagged code', "The new checkout's own code, the part that runs only when the flag is on."],
  dependency: ['Dependency', 'Something the checkout calls, such as the database; if it is down, that is not the feature\'s fault.'],
  'plain error-rate rule': ['Plain error-rate rule', 'A simple rule that switches a flag off when too many of its requests fail, whatever the reason.'],
  'arm comparison': ['Arm comparison', 'A simple rule that switches a flag off when requests with the flag on fail clearly more often than requests without it.'],
  exposures: ['Exposures', 'How many shoppers Flagsmith has shown this version to.'],
  'chance to win': ['Chance to win', "Flagsmith's estimate of how likely this version is to beat the other one."],
  p95: ['p95', 'The time that 95 out of 100 requests beat; it shows how slow the slow ones are.'],
} as const;

export type Term = keyof typeof GLOSSARY;
