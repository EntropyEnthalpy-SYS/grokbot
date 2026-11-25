import { existsSync } from "node:fs";
import { request } from "node:http";

/**
 * Client of the browser reader (sidecar/browser_server.py): a page rendered by headless Chromium, for
 * pages that need JavaScript or refuse simple fetches. The reader runs as its own service that can't
 * reach this server's local or private addresses.
 */
export function browserRenderer(socketPath: string): (url: string, signal?: AbortSignal) => Promise<string> {
  return (url, signal) =>
    new Promise((resolve, reject) => {
      if (!existsSync(socketPath)) return reject(new Error("browser reader isn't running"));
      const body = JSON.stringify({ url });
      const req = request(
        { socketPath, path: "/read", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, signal, timeout: 60_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { html?: string; error?: string };
              if (res.statusCode === 200 && reply.html) resolve(reply.html);
              else reject(new Error(reply.error ?? `HTTP ${res.statusCode}`));
            } catch {
              reject(new Error(`bad reply (HTTP ${res.statusCode})`));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("browser reader timed out")));
      req.on("error", reject);
      req.end(body);
    });
}
