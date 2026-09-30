import { describe, expect, it } from "vitest";
import {
  BUDGET_EXCEEDED,
  budgetChars,
  budgetedResult,
  estimateTokens,
  fitToBudget,
  isBudgetError,
  toText,
} from "../src/output.js";

/** Pad `value.pad` so the serialized value is exactly `chars` long. */
function padTo<T extends Record<string, unknown>>(value: T, chars: number): T & { pad: string } {
  const base = toText({ ...value, pad: "" }).length;
  if (chars < base) throw new Error("target too small");
  return { ...value, pad: "x".repeat(chars - base) };
}

const HINT = "trimmed";
const len = (v: unknown) => toText(v).length;

describe("toText", () => {
  it("serializes without whitespace", () => {
    expect(toText({ a: [1, 2], b: { c: "d e" } })).toBe('{"a":[1,2],"b":{"c":"d e"}}');
  });

  it("is smaller than pretty-printed JSON", () => {
    const v = { rows: [[1, "a"], [2, "b"]], nested: { x: 1 } };
    expect(toText(v).length).toBeLessThan(JSON.stringify(v, null, 2).length);
    expect(JSON.parse(toText(v))).toEqual(v);
  });
});

describe("estimateTokens / budgetChars", () => {
  it("estimates chars / 4, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("converts a token budget to characters", () => {
    expect(budgetChars(1000)).toBe(4000);
    expect(budgetChars(8000)).toBe(32000);
  });
});

describe("fitToBudget", () => {
  const rows = Array.from({ length: 20 }, (_, i) => [`ROW-${i}`, i]);

  it("returns the same object when it fits exactly at the budget", () => {
    const value = padTo({ rows }, 400);
    expect(len(value)).toBe(400);
    expect(fitToBudget(value, ["rows"], 100, HINT)).toBe(value);
  });

  it("trims when one character over the budget, and records the omission", () => {
    const value = padTo({ rows }, 401);
    const out = fitToBudget(value, ["rows"], 100, HINT) as any;
    expect(len(out)).toBeLessThanOrEqual(400);
    expect(out.truncated).toEqual({ omitted: 20 - out.rows.length, hint: HINT });
    expect(out.truncated.omitted).toBeGreaterThan(0);
    expect(out.rows).toEqual(rows.slice(0, out.rows.length));
    expect(out.pad).toBe(value.pad);
  });

  it("drops the fewest rows that fit, for every budget", () => {
    const value = { title: "t", rows };
    const full = len(value);
    for (let chars = 4; chars <= full + 8; chars += 4) {
      const out = fitToBudget(value, ["rows"], chars / 4, HINT) as any;
      if (isBudgetError(out)) {
        // Only when even the emptied form is too big.
        const emptied = { ...value, rows: [], truncated: { omitted: rows.length, hint: HINT } };
        expect(len(emptied)).toBeGreaterThan(chars);
        continue;
      }
      expect(len(out)).toBeLessThanOrEqual(chars);
      if (!out.truncated) {
        expect(out).toBe(value);
        continue;
      }
      // Keeping one more row would not fit.
      const kept = out.rows.length;
      const more = {
        ...value,
        rows: rows.slice(0, kept + 1),
        truncated: { omitted: out.truncated.omitted - 1, hint: HINT },
      };
      if (out.truncated.omitted > 0) expect(len(more)).toBeGreaterThan(chars);
    }
  });

  it("fits at the exact boundary where every row must go", () => {
    // Pick a pad so the all-rows-dropped form is a whole number of tokens.
    const emptied = (pad: string) =>
      len({ head: "h", rows: [], pad, truncated: { omitted: 2, hint: HINT } });
    let pad = "";
    while (emptied(pad) % 4 !== 0) pad += "x";
    const value = { head: "h", rows: [["a".repeat(50)], ["b".repeat(50)]], pad };
    const limit = emptied(pad);

    const out = fitToBudget(value, ["rows"], limit / 4, HINT) as any;
    expect(out.rows).toEqual([]);
    expect(out.truncated).toEqual({ omitted: 2, hint: HINT });
    expect(len(out)).toBe(limit);
    // One token less and even the emptied form is too big.
    expect(isBudgetError(fitToBudget(value, ["rows"], limit / 4 - 1, HINT))).toBe(true);
  });

  it("returns a small error object, never partial JSON, when the fixed part is too big", () => {
    const value = { big: "x".repeat(5000), rows };
    const out = fitToBudget(value, ["rows"], 1000, HINT);
    expect(isBudgetError(out)).toBe(true);
    expect(out).toEqual({ error: BUDGET_EXCEEDED, message: expect.stringMatching(/1000 tokens/) });
    expect(JSON.parse(toText(out))).toEqual(out);
    expect(len(out)).toBeLessThan(4000);
  });

  it("returns the budget error when there are no trimmable arrays", () => {
    expect(isBudgetError(fitToBudget({ big: "x".repeat(50) }, [], 1))).toBe(true);
    expect(isBudgetError(fitToBudget({ big: "x".repeat(50) }, ["missing"], 1))).toBe(true);
  });

  it("trims arrays at dot paths, emptying the last listed field first", () => {
    const row = (s: string) => [s.repeat(40)];
    const value = {
      a: { rows: [row("a"), row("b"), row("c")], keep: 1 },
      b: { rows: [row("d"), row("e"), row("f")] },
    };
    // Room for the note plus four of the six rows (each row is about 45 characters).
    const out = fitToBudget(value, ["a.rows", "b.rows"], Math.floor((len(value) - 40) / 4), HINT) as any;
    expect(out.truncated).toEqual({ omitted: 2, hint: HINT });
    expect(out.a).toEqual({ rows: value.a.rows, keep: 1 });
    expect(out.b.rows).toEqual([row("d")]);
  });

  it("moves on to earlier fields once the last is empty", () => {
    const a = "a".repeat(100);
    const value = { a: [a, a], b: ["b".repeat(100)] };
    const target = len({ a: [a], b: [], truncated: { omitted: 2, hint: HINT } });
    const out = fitToBudget(value, ["a", "b"], Math.ceil(target / 4), HINT) as any;
    expect(out.b).toEqual([]);
    expect(out.a).toEqual([a]);
    expect(out.truncated.omitted).toBe(2);
  });

  it("ignores listed paths that are not arrays", () => {
    const value = { note: "n", rows: ["r1", "r2", "r3", "r4"], obj: { x: 1 } };
    const out = fitToBudget(value, ["note", "obj.x", "nope.deep", "rows"], 20, HINT) as any;
    expect(out.note).toBe("n");
    expect(out.obj).toEqual({ x: 1 });
    expect(out.nope).toBeUndefined();
  });

  it("never mutates its input", () => {
    const value = { t: { rows: [["a", 1], ["b", 2], ["c", 3]] }, rows: [1, 2, 3] };
    const copy = structuredClone(value);
    fitToBudget(value, ["t.rows", "rows"], 10, HINT);
    fitToBudget(value, ["t.rows", "rows"], 1, HINT);
    expect(value).toEqual(copy);
  });

  it("uses a default hint", () => {
    const out = fitToBudget({ pad: "x".repeat(10), rows: Array(100).fill("r") }, ["rows"], 100) as any;
    expect(out.truncated.hint).toMatch(/output budget/);
  });
});

describe("isBudgetError", () => {
  it("recognizes only the budget error shape", () => {
    expect(isBudgetError({ error: BUDGET_EXCEEDED, message: "m" })).toBe(true);
    expect(isBudgetError({ error: BUDGET_EXCEEDED, message: "m", rows: [] })).toBe(false);
    expect(isBudgetError({ error: "other", message: "m" })).toBe(false);
    expect(isBudgetError(null)).toBe(false);
    expect(isBudgetError([BUDGET_EXCEEDED])).toBe(false);
  });
});

describe("budgetedResult", () => {
  it("returns compact text for a result that fits", () => {
    const res = budgetedResult({ a: [1, 2] }, ["a"], 1000);
    expect(res).toEqual({ content: [{ type: "text", text: '{"a":[1,2]}' }] });
  });

  it("returns trimmed text with a truncation note", () => {
    const res = budgetedResult({ a: Array(5000).fill(1) }, ["a"], 1000, HINT);
    const text = (res.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(JSON.parse(text).truncated.hint).toBe(HINT);
    expect(res.isError).toBeUndefined();
  });

  it("flags isError for the budget error", () => {
    const res = budgetedResult({ big: "x".repeat(5000) }, [], 1000);
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text).error).toBe(BUDGET_EXCEEDED);
  });
});
