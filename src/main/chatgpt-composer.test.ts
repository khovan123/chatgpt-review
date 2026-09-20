import { describe, expect, it } from "vitest";

import { composerContentMatches, normalizeComposerSemanticContent } from "./chatgpt-composer";

describe("ChatGPT composer semantic integrity", () => {
  it("accepts ProseMirror block whitespace expansion without treating it as truncation", () => {
    const prompt = "Line one\n\nLine two\n{\"key\": \"value with spaces\"}";
    const innerText = "Line one\n\n\nLine two\n\n{\"key\":  \"value with spaces\"}\n";

    expect(composerContentMatches(prompt, [innerText])).toBe(true);
  });

  it("accepts NBSP and invisible editor markers", () => {
    const prompt = "alpha beta gamma";
    const editor = "alpha\u00a0beta \u200bgamma";

    expect(composerContentMatches(prompt, [editor])).toBe(true);
  });

  it("rejects missing substantive content even when lengths are close", () => {
    const prompt = "abcdef ghi jklmnop";
    const editor = "abcdef ghi jklmXop";

    expect(composerContentMatches(prompt, [editor])).toBe(false);
  });

  it("does not hide meaningful whitespace loss", () => {
    expect(composerContentMatches("alpha beta", ["alphabeta"])).toBe(false);
  });

  it("rejects truncated content", () => {
    const prompt = "prefix important-tail";
    const editor = "prefix important";

    expect(composerContentMatches(prompt, [editor])).toBe(false);
  });

  it("normalizes only editor formatting noise, not substantive characters", () => {
    expect(normalizeComposerSemanticContent(" a\n b\t c ")).toBe("a b c");
    expect(normalizeComposerSemanticContent("abc")).toBe("abc");
    expect(normalizeComposerSemanticContent("abX")).not.toBe("abc");
  });
});
