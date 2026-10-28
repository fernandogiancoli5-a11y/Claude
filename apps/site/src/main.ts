import { submitWaitlist, validateEmail } from "./waitlist.js";

const loadedAt = performance.now();

// ------------------------------------------------------------- waitlist forms

for (const form of document.querySelectorAll<HTMLFormElement>("form[data-waitlist]")) {
  const email = form.elements.namedItem("email") as HTMLInputElement;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const status = form.querySelector<HTMLElement>("[data-status]")!;
  const defaultNote = status.innerHTML;

  const setError = (message: string) => {
    form.classList.add("invalid");
    email.setAttribute("aria-invalid", "true");
    status.classList.add("error");
    status.textContent = message;
  };
  const clearError = () => {
    form.classList.remove("invalid");
    email.removeAttribute("aria-invalid");
    status.classList.remove("error");
    status.innerHTML = defaultNote;
  };
  email.addEventListener("input", () => form.classList.contains("invalid") && clearError());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const problem = validateEmail(email.value);
    if (problem) {
      setError(problem);
      email.focus();
      return;
    }
    clearError();
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Joining…";
    const role = (form.elements.namedItem("role") as HTMLSelectElement | null)?.value || undefined;
    const result = await submitWaitlist({
      email: email.value,
      role,
      website: (form.elements.namedItem("website") as HTMLInputElement).value,
      elapsedMs: Math.round(performance.now() - loadedAt),
    });
    button.disabled = false;
    button.textContent = label;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const done = document.createElement("div");
    done.className = "success";
    done.setAttribute("role", "status");
    done.setAttribute("tabindex", "-1");
    done.innerHTML = `<strong>You're on the list.</strong><p></p>`;
    done.querySelector("p")!.textContent =
      `We'll email ${email.value.trim()} when there's a spot for your team. That's the only email you'll get from us.`;
    form.replaceWith(done);
    done.focus();
  });
}

// ------------------------------------------------------------- motion

const reveals = document.querySelectorAll<HTMLElement>(".reveal");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add("in"));
}

const nav = document.querySelector<HTMLElement>("[data-nav]");
const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

for (const el of document.querySelectorAll("[data-year]"))
  el.textContent = String(new Date().getFullYear());
