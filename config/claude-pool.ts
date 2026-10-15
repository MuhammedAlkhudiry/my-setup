/** Reproducible, local-only Claude pool installed by my-setup on macOS. */
export const CLAUDE_POOL = {
  version: "8.0.28",
  label: "me.router-for.cliproxyapi",
  port: 8317,
  t3InstanceId: "claudeAgent_pool",
  releaseAssets: {
    arm64: {
      name: "CLIProxyAPI_8.0.28_darwin_aarch64.tar.gz",
      sha256: "b70932382334e5388dc25265078cbcdf2e951b3b5fa7cd23d8ab3efb0a9fceef",
    },
    x64: {
      name: "CLIProxyAPI_8.0.28_darwin_amd64.tar.gz",
      sha256: "619e6892b56832d964d989e5be4a23e2277b22e39c160de7ba3ca60d66b2c5fd",
    },
  },
} as const;
