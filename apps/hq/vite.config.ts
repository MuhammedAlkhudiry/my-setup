import path from "path"
import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@contract": path.resolve(__dirname, "./contract/index.ts"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
