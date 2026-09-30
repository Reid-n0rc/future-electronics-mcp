import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { isReleasePr, linkedIssues, policyProblems } from "../../scripts/check-issue-policy.mjs";

type Issue = { labels: string[]; assignees: string[]; isPullRequest?: boolean } | null;
const issues = (entries: Array<[number, Issue]>) => new Map<number, Issue>(entries);
const ok: Issue = { labels: ["plan-approved"], assignees: ["Reid-n0rc"] };

describe("linkedIssues", () => {
  it("finds closing keywords in any case and form", () => {
    expect(linkedIssues("Closes #12")).toEqual([12]);
    expect(linkedIssues("fixes #3 and Resolved #4; closed #5, fix #6")).toEqual([3, 4, 5, 6]);
  });

  it("dedupes and keeps order", () => {
    expect(linkedIssues("Closes #9\nCloses #2\ncloses #9")).toEqual([9, 2]);
  });

  it("ignores plain references and handles empty bodies", () => {
    expect(linkedIssues("See #7, refs #8")).toEqual([]);
    expect(linkedIssues("")).toEqual([]);
    expect(linkedIssues(null)).toEqual([]);
    expect(linkedIssues(undefined)).toEqual([]);
  });
});

describe("isReleasePr", () => {
  it("is true only for dev -> master", () => {
    expect(isReleasePr({ base: { ref: "master" }, head: { ref: "dev" } })).toBe(true);
    expect(isReleasePr({ base: { ref: "dev" }, head: { ref: "issue-1-x" } })).toBe(false);
    expect(isReleasePr({ base: { ref: "master" }, head: { ref: "issue-1-x" } })).toBe(false);
    expect(isReleasePr(undefined)).toBe(false);
  });
});

describe("policyProblems", () => {
  it("requires a linked issue", () => {
    expect(policyProblems([], issues([]))).toHaveLength(1);
  });

  it("passes an approved, assigned issue", () => {
    expect(policyProblems([1], issues([[1, ok]]))).toEqual([]);
  });

  it("flags a missing plan-approved label", () => {
    const p = policyProblems([1], issues([[1, { labels: ["plan-needs-approval"], assignees: ["a"] }]]));
    expect(p).toEqual([expect.stringContaining("plan-approved")]);
  });

  it("flags an unassigned issue", () => {
    const p = policyProblems([1], issues([[1, { labels: ["plan-approved"], assignees: [] }]]));
    expect(p).toEqual([expect.stringContaining("not assigned")]);
  });

  it("reports both problems for one issue", () => {
    expect(policyProblems([1], issues([[1, { labels: [], assignees: [] }]]))).toHaveLength(2);
  });

  it("rejects missing issues and pull requests", () => {
    expect(policyProblems([1], issues([[1, null]]))).toEqual([expect.stringContaining("not an issue")]);
    expect(policyProblems([2], issues([[2, { ...ok!, isPullRequest: true }]]))).toEqual([
      expect.stringContaining("not an issue"),
    ]);
  });

  it("checks every linked issue", () => {
    const p = policyProblems([1, 2], issues([[1, ok], [2, { labels: ["plan-approved"], assignees: [] }]]));
    expect(p).toEqual([expect.stringContaining("#2")]);
  });
});
