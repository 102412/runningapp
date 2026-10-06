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

export type TextModerationInput = Parameters<ContentModerator['moderateText']>[0];
export type ImageModerationInput = Parameters<ContentModerator['moderateImage']>[0];

export class AllowAllModerator implements ContentModerator {
  async moderateText(_input: TextModerationInput): Promise<ModerationVerdict> {
    return { verdict: 'ALLOW' };
  }
  async moderateImage(_input: ImageModerationInput): Promise<ModerationVerdict> {
    return { verdict: 'ALLOW' };
  }
}

/**
 * Where automated moderation sends content it wants a human to look at (verdict FLAG). The
 * default implementation files an AUTOMATED report in the moderation queue.
 */
export interface ModerationFlagSink {
  flag(input: {
    targetType: 'POST' | 'COMMENT' | 'USER';
    targetId: string;
    reason: string;
    /** The flagged text, kept with the report in case it is edited or deleted later. */
    text: string;
  }): Promise<void>;
}
