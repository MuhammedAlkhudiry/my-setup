/** Reproducible, local-only Claude pool installed by my-setup on macOS. */
export const CLAUDE_POOL = {
  version: "8.0.66",
  label: "me.router-for.cliproxyapi",
  port: 8317,
  t3InstanceId: "claudeAgent_pool",
  releaseAssets: {
    arm64: {
      name: "CLIProxyAPI_8.0.66_darwin_aarch64.tar.gz",
      sha256: "638d25401ca319c919b1453530753c0d4812173646035b37fb8b0ccf2d04f7be",
    },
    x64: {
      name: "CLIProxyAPI_8.0.66_darwin_amd64.tar.gz",
      sha256: "76fcabc801e9de05849cd1029d435069911260da477a978aff4aa1fd33a185b9",
    },
  },
} as const;
