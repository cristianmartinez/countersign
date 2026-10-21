import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { docsSettings } from "./site-settings.ts";

const { docsUrl } = docsSettings();

export default defineConfig({
  site: docsUrl,
  output: "static",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Countersign",
      description: "Agents prepare emails. Humans approve the exact words.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/theme.css"],
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        SocialIcons: "./src/components/AppLink.astro",
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "" },
            { label: "Your first five minutes", slug: "getting-started" },
            { label: "Agent workflow", slug: "agent-workflow" },
          ],
        },
        {
          label: "Build with the API",
          items: [
            { label: "API reference", slug: "api-reference" },
            { label: "React Email example", slug: "react-email" },
          ],
        },
        {
          label: "Engineering",
          items: [{ label: "Project overview", slug: "project/overview" }],
        },
      ],
      expressiveCode: { themes: ["github-dark"], useDarkModeMediaQuery: false },
      credits: false,
    }),
  ],
});
