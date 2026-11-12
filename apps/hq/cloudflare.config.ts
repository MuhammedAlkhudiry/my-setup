// `hq deploy` runs `cf deploy` here: Vite builds the site and the Worker, cf uploads both.
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
  accountId: "79e2c6100c3c858bea905f9f200823b5",
  worker: {
    name: "housekeeper-hq",
    compatibilityDate: "2026-10-01",
    entrypoint,
    domains: ["hq.harium.app"],
    // Only the custom domain, which Cloudflare Access guards; no workers.dev or preview hostnames.
    workersDev: false,
    previewUrls: false,
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
    env: {
      ASSETS: bindings.assets(),
      DATA: bindings.r2({ name: "housekeeper-hq" }),
      ACCESS_TEAM: bindings.text("raspy-violet-b58c.cloudflareaccess.com"),
      ACCESS_AUD: bindings.text("d496947c195799db8ab30454f51d967fa7a2245b2a644c6a147328f416d142aa"),
      NOTIFY_URL: bindings.secret(),
    },
  },
});
