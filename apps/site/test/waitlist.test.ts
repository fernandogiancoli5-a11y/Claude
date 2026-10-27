import { describe, expect, it } from "vitest";
import { submitWaitlist, validateEmail } from "../src/waitlist.js";

describe("validateEmail", () => {
  it("accepts ordinary addresses and trims them", () => {
    expect(validateEmail("ada@example.com")).toBeNull();
    expect(validateEmail("  first.last+tag@sub.example.co.uk ")).toBeNull();
  });
  it("explains what is wrong", () => {
    expect(validateEmail("")).toMatch(/Enter your email/);
    expect(validateEmail("ada@example")).toMatch(/doesn't look like an email/);
    expect(validateEmail("ada example@x.io")).toMatch(/doesn't look like an email/);
    expect(validateEmail(`${"a".repeat(250)}@x.io`)).toMatch(/too long/);
  });
});

describe("submitWaitlist", () => {
  const input = { email: " Ada@Example.com ", role: "engineer", website: "", elapsedMs: 3000 };
  const reply = (status: number) => (async () => new Response("{}", { status })) as typeof fetch;

  it("posts the trimmed address with the spam-check fields", async () => {
    let sent: any;
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await submitWaitlist(input, f)).toEqual({ ok: true });
    expect(sent).toEqual({
      email: "Ada@Example.com",
      role: "engineer",
      website: "",
      elapsedMs: 3000,
    });
  });

  it("maps failures to actionable messages", async () => {
    expect(await submitWaitlist(input, reply(429))).toMatchObject({
      ok: false,
      message: /Too many attempts/,
    });
    expect(await submitWaitlist(input, reply(400))).toMatchObject({
      ok: false,
      message: /wasn't accepted/,
    });
    expect(await submitWaitlist(input, reply(500))).toMatchObject({
      ok: false,
      message: /our side/,
    });
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await submitWaitlist(input, offline)).toMatchObject({
      ok: false,
      message: /couldn't reach/,
    });
  });
});
