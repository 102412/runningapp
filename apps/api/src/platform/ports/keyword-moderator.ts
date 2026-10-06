import type {
  ContentModerator,
  ImageModerationInput,
  ModerationVerdict,
  TextModerationInput,
} from './content-moderation';

/**
 * Baseline text moderation from two operator-managed word lists (MODERATION_BLOCK_TERMS rejects,
 * MODERATION_FLAG_TERMS sends to the review queue). Whole-word, case- and accent-insensitive.
 *
 * This is a safety net and a demonstration of the ContentModerator port, NOT production-grade
 * moderation: it knows nothing about context, languages, obfuscation or images. Plug a real
 * classifier into the same port before launch (see docs/SECURITY.md).
 */
export class KeywordModerator implements ContentModerator {
  private readonly block: RegExp | null;
  private readonly flag: RegExp | null;

  constructor(blockTerms: readonly string[], flagTerms: readonly string[]) {
    this.block = compile(blockTerms);
    this.flag = compile(flagTerms);
  }

  async moderateText(input: TextModerationInput): Promise<ModerationVerdict> {
    const text = normalize(input.text);
    if (this.block?.test(text)) {
      return { verdict: 'BLOCK', reason: 'This text contains language that is not allowed.' };
    }
    if (this.flag?.test(text)) {
      return { verdict: 'FLAG', reason: 'Contains a term on the review list.' };
    }
    return { verdict: 'ALLOW' };
  }

  async moderateImage(_input: ImageModerationInput): Promise<ModerationVerdict> {
    return { verdict: 'ALLOW' };
  }
}

function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
}

function compile(terms: readonly string[]): RegExp | null {
  const cleaned = terms.map((t) => normalize(t).trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return null;
  const alternation = cleaned.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'u');
}
