/** Reproducible, local-only Claude pool installed by my-setup on macOS. */
export const CLAUDE_POOL = {
  version: "8.0.15",
  label: "me.router-for.cliproxyapi",
  port: 8317,
  t3InstanceId: "claudeAgent_pool",
  releaseAssets: {
    arm64: {
      name: "CLIProxyAPI_8.0.15_darwin_aarch64.tar.gz",
      sha256: "90fe6d309613b33520b9f08746829dd6c4fdfbbbb353f41ac01e4e94f168f7c4",
    },
    x64: {
      name: "CLIProxyAPI_8.0.15_darwin_amd64.tar.gz",
      sha256: "d0f69a00d9ab3a514a96159542dec6632dbfef03e74dc9f8224b7edad9b5ca6f",
    },
  },
} as const;
