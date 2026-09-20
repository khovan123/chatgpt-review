const INVISIBLE_EDITOR_CHARS = /[\u200b-\u200d\u2060\ufeff]/gu;

export function normalizeComposerSemanticContent(value: string): string {
  return String(value || "")
    .normalize("NFC")
    .replace(/\u00a0/gu, " ")
    .replace(INVISIBLE_EDITOR_CHARS, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function composerContentMatches(message: string, candidates: string[]): boolean {
  const expected = normalizeComposerSemanticContent(message);
  return candidates.some((candidate) => normalizeComposerSemanticContent(candidate) === expected);
}
