/** Client side of the early-access waitlist. The server re-validates everything. */

// Deliberately simple: one "@", a dot in the domain, no spaces. The server applies the strict check.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Enter your email address.";
  if (v.length > 254) return "That email address is too long.";
  if (!EMAIL.test(v)) return "That doesn't look like an email address — check for typos.";
  return null;
}

export type SubmitResult = { ok: true } | { ok: false; message: string };

export async function submitWaitlist(
  input: { email: string; role?: string; website: string; elapsedMs: number },
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: input.email.trim(),
        ...(input.role ? { role: input.role } : {}),
        website: input.website,
        elapsedMs: input.elapsedMs,
      }),
    });
  } catch {
    return {
      ok: false,
      message: "We couldn't reach the server. Check your connection and try again.",
    };
  }
  if (res.ok) {
    // Only the waitlist endpoint's own confirmation counts. A 200 from anything else (an HTML
    // fallback page, a proxy, a misrouted request) must never tell someone they're signed up.
    const body = await res.json().catch(() => null);
    if (body && body.ok === true) return { ok: true };
    return {
      ok: false,
      message: "Something went wrong on our side. Please try again in a moment.",
    };
  }
  if (res.status === 429)
    return {
      ok: false,
      message: "Too many attempts from your network. Please try again in a few minutes.",
    };
  if (res.status === 400)
    return { ok: false, message: "That email address wasn't accepted. Check it and try again." };
  return { ok: false, message: "Something went wrong on our side. Please try again in a moment." };
}
