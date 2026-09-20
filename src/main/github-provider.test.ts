import { describe, expect, it } from "vitest";

import { isSelfReviewRejection, normalizeGitHubRepositoryInput, parsePullRequestGate } from "./github-provider";

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

  it("recognizes GitHub self-review rejections without masking unrelated failures", () => {
    expect(isSelfReviewRejection(new Error("Can not approve your own pull request."))).toBe(true);
    expect(isSelfReviewRejection(new Error("Can not request changes on your own pull request."))).toBe(true);
    expect(isSelfReviewRejection(new Error("HTTP 403: Resource not accessible by integration"))).toBe(false);
  });

  it("parses exact-head CI and mergeability from GitHub statusCheckRollup", () => {
    const gate = parsePullRequestGate({
      headRefOid: "a".repeat(40),
      mergeable: "MERGEABLE",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "API unit tests",
          workflowName: "Tests",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://github.com/example/repo/actions/runs/1",
        },
        {
          __typename: "CheckRun",
          name: "API e2e tests",
          workflowName: "Tests",
          status: "IN_PROGRESS",
          conclusion: "",
          detailsUrl: "https://github.com/example/repo/actions/runs/1",
        },
      ],
    });

    expect(gate.headSha).toBe("a".repeat(40));
    expect(gate.mergeable).toBe("MERGEABLE");
    expect(gate.allChecksComplete).toBe(false);
    expect(gate.ciConclusion).toBe("pending");
    expect(gate.checks).toHaveLength(2);
  });

  it("treats completed failures as finished CI, not as pending CI", () => {
    const gate = parsePullRequestGate({
      headRefOid: "b".repeat(40),
      mergeable: "CONFLICTING",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "Tests", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "Lint", workflowName: "CI", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "StatusContext", context: "external/status", state: "SUCCESS", targetUrl: "https://example.com/check" },
      ],
    });

    expect(gate.allChecksComplete).toBe(true);
    expect(gate.ciConclusion).toBe("failure");
    expect(gate.mergeable).toBe("CONFLICTING");
    expect(gate.checks[2]).toMatchObject({ status: "COMPLETED", conclusion: "SUCCESS" });
  });


});
