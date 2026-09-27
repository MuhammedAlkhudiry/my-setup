/** Reproducible, local-only Claude pool installed by my-setup on macOS. */
export const CLAUDE_POOL = {
  version: "8.0.2",
  label: "me.router-for.cliproxyapi",
  port: 8317,
  t3InstanceId: "claudeAgent_pool",
  releaseAssets: {
    arm64: {
      name: "CLIProxyAPI_8.0.2_darwin_aarch64.tar.gz",
      sha256: "305424f9a67e12b1e0e37f772c0f960f946f0e3c385226ab481a12e50f0621ae",
    },
    x64: {
      name: "CLIProxyAPI_8.0.2_darwin_amd64.tar.gz",
      sha256: "7f5d192bd92fd06d24c5e286b673e3fbd0b05fee69983729cdb20792b5a857a1",
    },
  },
} as const;
