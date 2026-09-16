import { describe, expect, it } from "vitest";

import { normalizeGitHubRepositoryInput } from "./github-provider";

describe("GitHub repository input normalization", () => {
  it("accepts owner/name and canonical HTTPS GitHub repository URLs", () => {
    expect(normalizeGitHubRepositoryInput("khovan123/LCSP")).toBe("khovan123/LCSP");
    expect(normalizeGitHubRepositoryInput(" https://github.com/khovan123/LCSP ")).toBe("khovan123/LCSP");
    expect(normalizeGitHubRepositoryInput("https://github.com/khovan123/LCSP/")).toBe("khovan123/LCSP");
    expect(normalizeGitHubRepositoryInput("https://github.com/khovan123/LCSP.git")).toBe("khovan123/LCSP");
  });

  it("rejects non-GitHub hosts and non-repository paths", () => {
    expect(() => normalizeGitHubRepositoryInput("https://gitlab.com/khovan123/LCSP")).toThrow(/github\.com/i);
    expect(() => normalizeGitHubRepositoryInput("http://github.com/khovan123/LCSP")).toThrow(/HTTPS github\.com/i);
    expect(() => normalizeGitHubRepositoryInput("https://github.com/khovan123/LCSP/issues/1")).toThrow(/point directly/i);
    expect(() => normalizeGitHubRepositoryInput("https://github.com/khovan123/LCSP?tab=readme")).toThrow(/HTTPS github\.com/i);
  });

  it("rejects malformed repository values", () => {
    expect(() => normalizeGitHubRepositoryInput("")).toThrow(/required/i);
    expect(() => normalizeGitHubRepositoryInput("khovan123")).toThrow(/owner\/name/i);
    expect(() => normalizeGitHubRepositoryInput("https://github.com/khovan123/")).toThrow(/point directly/i);
  });
});
