import { MAX_TOPICS_PER_POST } from '@runningapp/contracts';

const HASHTAG = /(?<![\p{L}\p{N}_&])#([\p{L}\p{N}_]{1,50})/gu;
// The `u` flag is required for \p{..} classes; without it the lookbehind silently never matches.
const MENTION = /(?<![\p{L}\p{N}_.@])@([A-Za-z][A-Za-z0-9_.]{2,29})/gu;
const MAX_MENTIONS = 20;

/** Canonical topic slug: NFKC-normalised, lower-cased, no "#". Returns null if it is not a valid topic. */
export function normalizeTopic(raw: string): string | null {
  const slug = raw.normalize('NFKC').replace(/^#+/, '').toLowerCase();
  return /^[\p{L}\p{N}_]{1,50}$/u.test(slug) ? slug : null;
}

/** Explicit topics plus #hashtags found in the caption, de-duplicated, capped. */
export function collectTopics(caption: string, explicit: readonly string[] = []): string[] {
  const found = new Set<string>();
  for (const t of explicit) {
    const slug = normalizeTopic(t);
    if (slug) found.add(slug);
  }
  for (const m of caption.matchAll(HASHTAG)) {
    const slug = normalizeTopic(m[1] ?? '');
    if (slug) found.add(slug);
  }
  return [...found].slice(0, MAX_TOPICS_PER_POST);
}

/** Usernames referenced as @name (trailing dots trimmed), unique, capped. Case preserved as typed. */
export function extractMentions(text: string): string[] {
  const found = new Map<string, string>();
  for (const m of text.matchAll(MENTION)) {
    const name = (m[1] ?? '').replace(/\.+$/, '');
    if (name.length >= 3 && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), name);
  }
  return [...found.values()].slice(0, MAX_MENTIONS);
}

const SPONSORSHIP_LABELS = {
  PAID_PARTNERSHIP: (b: string) => `Paid partnership with ${b}`,
  GIFTED_PRODUCT: (b: string) => `Gifted product from ${b}`,
  AFFILIATE: (b: string) => `Affiliate partnership with ${b}`,
  AMBASSADOR: (b: string) => `${b} ambassador`,
} as const;

/** The ready-to-display disclosure text. Computed server-side so every client says the same thing. */
export function sponsorshipLabel(type: keyof typeof SPONSORSHIP_LABELS, brand: string): string {
  return SPONSORSHIP_LABELS[type](brand);
}
