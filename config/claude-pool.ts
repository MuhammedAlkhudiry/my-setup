/** Reproducible, local-only Claude pool installed by my-setup on macOS. */
export const CLAUDE_POOL = {
  version: "8.0.38",
  label: "me.router-for.cliproxyapi",
  port: 8317,
  t3InstanceId: "claudeAgent_pool",
  releaseAssets: {
    arm64: {
      name: "CLIProxyAPI_8.0.38_darwin_aarch64.tar.gz",
      sha256: "58899af288fc25bf5b9c8a59dc936ca375c331addfa7b4e4ecc1f13fba00d5d3",
    },
    x64: {
      name: "CLIProxyAPI_8.0.38_darwin_amd64.tar.gz",
      sha256: "e7e36545d5badc8d16cccc2e27d776cfe10ae5c2d220274fce22681ec9770ff3",
    },
  },
} as const;
