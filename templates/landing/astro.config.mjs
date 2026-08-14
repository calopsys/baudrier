// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// No `site` key at scaffold time: a fresh project has no public URL yet.
// /add-domain sets it once a custom domain exists, /seo sets it from the
// container's default URL otherwise - both are the only writers of this key.
export default defineConfig({
  output: "static",
  integrations: [],
  vite: {
    plugins: [tailwindcss()],
  },
});
