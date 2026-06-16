import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  // ⚠️ עדכנו לכתובת האמיתית אחרי שתחברו דומיין (חשוב ל-SEO ול-sitemap)
  site: "https://zebra-loans.netlify.app",
  integrations: [sitemap()],
});
