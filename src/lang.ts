let defaultCode = "zh-tw";

/** Language for translations and cards in new groups and private chats (DEFAULT_LANGUAGE, default zh-tw). */
export function defaultLanguage(): string {
  return defaultCode;
}

export function setDefaultLanguage(code: string): void {
  if (!(code in LANGUAGES)) throw new Error(`Unknown DEFAULT_LANGUAGE "${code}". Choose: ${Object.keys(LANGUAGES).join(", ")}.`);
  defaultCode = code;
}

/** Languages offered by /lang, with the name Grok is told to write in. */
export const LANGUAGES: Record<string, string> = {
  "zh-tw": "Traditional Chinese (Taiwan)",
  "zh-cn": "Simplified Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  off: "the language of the source",
};

export function languageName(code: string): string {
  return LANGUAGES[code] ?? code;
}
