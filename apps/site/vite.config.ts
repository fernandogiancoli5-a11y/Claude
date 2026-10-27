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

export default defineConfig({
  plugins: [contactEmail()],
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
