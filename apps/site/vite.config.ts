import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const api = process.env.PAIRLOOM_API ?? "http://127.0.0.1:8787";

/**
 * The privacy note must name a real contact for access and deletion requests. It comes from
 * PAIRLOOM_CONTACT_EMAIL at build time; a production build without it says so loudly.
 */
function contactEmail(): Plugin {
  const email = process.env.PAIRLOOM_CONTACT_EMAIL?.trim();
  return {
    name: "pairloom-contact-email",
    configResolved(config) {
      if (!email && config.command === "build")
        config.logger.warn(
          "\n[site] PAIRLOOM_CONTACT_EMAIL is not set: the privacy page will say no contact address is configured. Set it before publishing.\n",
        );
    },
    transformIndexHtml(html) {
      const value = email
        ? `<a href="mailto:${email}">${email}</a>`
        : "<strong>[no contact address configured — set PAIRLOOM_CONTACT_EMAIL before publishing]</strong>";
      return html.replaceAll("<!--CONTACT_EMAIL-->", value);
    },
  };
}

/**
 * Where waitlist signups are stored differs by deployment, and the privacy page must describe
 * the one actually in use. PAIRLOOM_WAITLIST_BACKEND=server (default: the Pairloom server's
 * SQLite database) or supabase (the Netlify function; see docs/DEPLOY_FREE.md).
 */
const STORAGE_TEXT = {
  server: `<p>
          That's all. We don't store your IP address, browser details or any tracking identifiers
          with your signup, and this site loads no analytics, advertising or third-party scripts.
          Your IP address is held briefly in server memory to limit repeated attempts, and is never
          written to the database.
        </p>`,
  supabase: `<p>
          That's all for your signup. This site loads no analytics, advertising or third-party
          scripts, and we don't store your IP address or browser details with your signup.
        </p>
        <p>
          To stop automated abuse, each attempt to join records a <strong>salted one-way hash</strong>
          of your IP address (for IPv6, of its network prefix) — not the address itself — so we can
          limit repeated attempts (5 per 10 minutes). These hashes are kept separately from signups and deleted after
          <strong>one hour</strong>.
        </p>
        <p>
          The site is hosted by Netlify, which handles your request, and signups are stored in a
          database run by Supabase.
        </p>`,
} as const;

function deploymentText(): Plugin {
  const backend = (process.env.PAIRLOOM_WAITLIST_BACKEND ?? "server").trim();
  if (backend !== "server" && backend !== "supabase")
    throw new Error(`PAIRLOOM_WAITLIST_BACKEND must be "server" or "supabase", not "${backend}"`);
  // Only link to the app when one is actually deployed at a known address.
  const appUrl = process.env.PAIRLOOM_APP_URL?.trim();
  if (appUrl && !/^(https:\/\/[^\s"<>]+|\/[^\s"<>]*)$/.test(appUrl))
    throw new Error("PAIRLOOM_APP_URL must be an https:// URL or a path such as /app/");
  return {
    name: "pairloom-deployment-text",
    transformIndexHtml(html) {
      return html
        .replaceAll("<!--WAITLIST_STORAGE-->", STORAGE_TEXT[backend])
        .replaceAll("<!--APP_SIGNIN-->", appUrl ? `<a href="${appUrl}">Sign in</a>` : "");
    },
  };
}

export default defineConfig({
  plugins: [contactEmail(), deploymentText()],
  server: {
    port: 5174,
    // The waitlist endpoint lives on the Pairloom server.
    proxy: { "/api": { target: api, changeOrigin: false } },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        notFound: resolve(import.meta.dirname, "404.html"),
      },
    },
  },
});
