// Serves Herd's MinIO site on a spare Mac without Herd, the way Herd's nginx does on the main Mac: HTTPS for
// minio.herd.test on 127.0.0.1:443 with the copied Herd site certificate, passed through to MinIO on port 9000.
// mirror-spare-minio.zsh runs it as a root launch daemon, since macOS lets only root listen on port 443, and passes the
// Herd certificates folder.

import { join } from "node:path";

const certificates = process.argv[2];
if (!certificates) throw new Error("Usage: minio-proxy.ts <Herd certificates folder>");

Bun.serve({
  hostname: "127.0.0.1",
  port: 443,
  tls: {
    cert: Bun.file(join(certificates, "minio.herd.test.crt")),
    key: Bun.file(join(certificates, "minio.herd.test.key")),
  },
  fetch(request) {
    const url = new URL(request.url);

    return fetch(`http://127.0.0.1:9000${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      decompress: false,
    });
  },
});
