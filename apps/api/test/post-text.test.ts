import { describe, expect, it } from 'vitest';
import {
  collectTopics,
  extractMentions,
  normalizeTopic,
  sponsorshipLabel,
} from '../src/modules/posts/text';

describe('post text parsing', () => {
  it('extracts hashtags (unicode-aware), normalises, de-duplicates and caps them', () => {
    expect(collectTopics('Long run #Marathon training #marathon #HalfMarathon!')).toEqual([
      'marathon',
      'halfmarathon',
    ]);
    expect(collectTopics('#ñandú #日本 #run_club #123')).toEqual([
      'ñandú',
      '日本',
      'run_club',
      '123',
    ]);
    expect(collectTopics('no tags here, email a#b.com or c&#amp;')).toEqual([]);
    expect(collectTopics('', ['#Trail', 'trail', 'bad tag', ''])).toEqual(['trail']);
    const many = Array.from({ length: 25 }, (_, i) => `#t${i}`).join(' ');
    expect(collectTopics(many)).toHaveLength(10);
    expect(normalizeTopic('x'.repeat(51))).toBeNull();
  });

  it('extracts @mentions but not email addresses or trailing punctuation', () => {
    expect(extractMentions('Great run with @ava_runs and @Marco.Lopez! cc @ab')).toEqual([
      'ava_runs',
      'Marco.Lopez',
    ]);
    expect(extractMentions('mail me at coach@example.com or @ava_runs.')).toEqual(['ava_runs']);
    expect(extractMentions('@ava_runs @AVA_RUNS @ava_runs')).toEqual(['ava_runs']);
    expect(extractMentions('@1nope @_nope')).toEqual([]);
    expect(
      extractMentions(Array.from({ length: 40 }, (_, i) => `@user${i}x`).join(' ')),
    ).toHaveLength(20);
  });

  it('builds sponsorship labels server-side', () => {
    expect(sponsorshipLabel('PAID_PARTNERSHIP', 'Acme')).toBe('Paid partnership with Acme');
    expect(sponsorshipLabel('GIFTED_PRODUCT', 'Acme')).toBe('Gifted product from Acme');
    expect(sponsorshipLabel('AMBASSADOR', 'Acme')).toBe('Acme ambassador');
  });
});
