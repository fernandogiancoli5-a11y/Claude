import { describe, expect, it } from "vitest";
import { buildRequestMessages } from "../src/harness/context.js";
import type { ChatMessage } from "../src/harness/provider.js";

const BIG = 240_000;
const FILE = Array.from({ length: 30 }, (_, i) => `${i + 1}| line ${i} of src/cart.js`).join("\n");
let n = 0;
const call = (name: string, args: Record<string, unknown>): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ],
});
const result = (m: ChatMessage, content: string): ChatMessage => ({
  role: "tool",
  tool_call_id: (m as { tool_calls: Array<{ id: string }> }).tool_calls[0]!.id,
  content,
});
const args = (m: ChatMessage) =>
  JSON.parse(
    (m as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0]!.function
      .arguments,
  );

describe("buildRequestMessages", () => {
  it("leaves a single-turn history with nothing stale unchanged", () => {
    const read = call("read_file", { path: "src/cart.js" });
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      read,
      result(read, FILE),
    ];
    expect(buildRequestMessages(msgs, BIG)).toEqual(msgs);
  });

  it("stubs tool outputs and bulky arguments from finished turns but keeps the summaries", () => {
    const read = call("read_file", { path: "src/cart.js" });
    const write = call("write_file", { path: "test/a.test.js", content: FILE });
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "turn one" },
      read,
      result(read, FILE),
      write,
      result(write, "Wrote test/a.test.js (500 bytes)"),
      { role: "assistant", content: "Summary: added tests; npm test passed." },
      { role: "user", content: "turn two" },
    ];
    const out = buildRequestMessages(msgs, BIG);
    expect(out[3]!.content).toMatch(/read_file output from an earlier turn omitted/);
    expect(args(out[4]!)).toEqual({
      path: "test/a.test.js",
      content: `[${FILE.length} chars omitted]`,
    });
    expect(out[5]!.content).toBe("Wrote test/a.test.js (500 bytes)");
    expect(out[6]!.content).toBe("Summary: added tests; npm test passed.");
    expect(out[7]!.content).toBe("turn two");
    // The saved transcript is untouched.
    expect(msgs[3]!.content).toBe(FILE);
    expect(args(msgs[4]!).content).toBe(FILE);
  });

  it("drops a read once the file is read again or rewritten, but not after an edit", () => {
    const r1 = call("read_file", { path: "src/cart.js" });
    const edit = call("edit_file", { path: "src/cart.js", old_string: "a", new_string: "b" });
    const r2 = call("read_file", { path: "./src/cart.js" });
    const other = call("read_file", { path: "README.md" });
    const msgs: ChatMessage[] = [
      { role: "user", content: "task" },
      r1,
      result(r1, FILE),
      edit,
      result(edit, "Edited src/cart.js"),
      other,
      result(other, FILE),
    ];
    // Only an edit since the read: the read is still the model's view of the file.
    expect(buildRequestMessages(msgs, BIG)[2]!.content).toBe(FILE);

    msgs.push(r2, result(r2, FILE + "\nnew"));
    const out = buildRequestMessages(msgs, BIG);
    expect(out[2]!.content).toBe("[stale: src/cart.js was read again or rewritten later]");
    expect(out[6]!.content).toBe(FILE);
    expect(out[8]!.content).toBe(FILE + "\nnew");
  });

  it("drops superseded write_file content and earlier test output", () => {
    const w1 = call("write_file", { path: "t.js", content: FILE });
    const t1 = call("run_tests", {});
    const w2 = call("write_file", { path: "t.js", content: FILE + "!" });
    const t2 = call("run_tests", {});
    const testOut = "$ npm test\nexit code 1\n" + "not ok 1 - discount\n".repeat(20);
    const msgs: ChatMessage[] = [
      { role: "user", content: "task" },
      w1,
      result(w1, "Wrote t.js"),
      t1,
      result(t1, testOut),
      w2,
      result(w2, "Wrote t.js"),
      t2,
      result(t2, testOut),
    ];
    const out = buildRequestMessages(msgs, BIG);
    expect(args(out[1]!).content).toBe(`[${FILE.length} chars omitted]`);
    expect(out[4]!.content).toBe("$ npm test\n[output omitted: tests ran again later]");
    expect(args(out[5]!).content).toBe(FILE + "!");
    expect(out[8]!.content).toBe(testOut);
  });

  it("elides the oldest tool outputs when still over the budget", () => {
    const a = call("read_file", { path: "a.js" });
    const b = call("read_file", { path: "b.js" });
    const msgs: ChatMessage[] = [
      { role: "user", content: "task" },
      a,
      result(a, FILE),
      b,
      result(b, FILE),
    ];
    const budget = JSON.stringify(msgs).length - 100;
    const out = buildRequestMessages(msgs, budget);
    expect(out[2]!.content).toMatch(/older tool output elided/);
    expect(out[4]!.content).toBe(FILE);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(budget);
  });
});
