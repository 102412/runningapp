/**
 * Port for automated content moderation. The default implementation approves everything; a real
 * deployment plugs in a classifier (Hive, AWS Rekognition, OpenAI moderation, an in-house model...)
 * by implementing this interface in the composition root. Nothing else needs to change.
 */
export type ModerationVerdict =
  { verdict: 'ALLOW' } | { verdict: 'FLAG'; reason: string } | { verdict: 'BLOCK'; reason: string };

export interface ContentModerator {
  moderateText(input: {
    text: string;
    context: 'CAPTION' | 'COMMENT' | 'BIO' | 'USERNAME';
  }): Promise<ModerationVerdict>;
  /** Called with a local image file (the poster/medium variant) before media becomes READY. */
  moderateImage(input: { filePath: string; ownerId: string }): Promise<ModerationVerdict>;
}

export class AllowAllModerator implements ContentModerator {
  async moderateText(): Promise<ModerationVerdict> {
    return { verdict: 'ALLOW' };
  }
  async moderateImage(): Promise<ModerationVerdict> {
    return { verdict: 'ALLOW' };
  }
}
