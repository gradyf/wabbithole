// The focus registry: the optional trivia lenses a user can allow from
// Settings. A focus maps a preference key (`quizFocuses` entries) to the
// question type it produces, the prompt fragment that folds it into the single
// extraction call, and whether it costs money (all free today). Kept
// deliberately small — one real entry — so later lenses (maps, dates) are
// additive: add a row here and the settings whitelist, prompt fold-in, and
// client renderer all pick it up.

export interface Focus {
  /** The `quizFocuses` preference key (what Settings toggles). */
  key: string;
  /** The `article_questions.type` value rows of this focus carry. */
  questionType: string;
  /** Appended to the extraction prompt when this focus's asset is present. */
  promptFragment: string;
  /** Reserved for a future paywalled lens; every focus today is free. */
  premium: boolean;
}

export const FOCUSES: Focus[] = [
  {
    key: 'flags',
    questionType: 'flag',
    premium: false,
    // The exact image URL is substituted at call time (extract.ts passes it to
    // buildExtractionPrompt); this is the invariant instruction.
    promptFragment:
      'Also include exactly one flag-identification question in addition to the questions above: show the country or territory flag pictured and ask which country or territory it belongs to. Set that one question\'s imageUrl to exactly the URL given below and leave imageUrl unset on every other question. If you cannot tell which country the flag belongs to from the article, omit the flag question entirely rather than guess.',
  },
];

/** Every known focus key — the whitelist api/settings.ts validates against. */
export const FOCUS_KEYS = FOCUSES.map((f) => f.key);

export function isKnownFocus(key: unknown): key is string {
  return typeof key === 'string' && FOCUS_KEYS.includes(key);
}

export function focusByKey(key: string): Focus | undefined {
  return FOCUSES.find((f) => f.key === key);
}
