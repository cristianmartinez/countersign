import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  publicDir: false,
  plugins: [tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "public/assets",
    minify: true,
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./ui/client.tsx", import.meta.url)),
      formats: ["es"],
      fileName: "ui-client",
      cssFileName: "ui",
    },
  },
});
