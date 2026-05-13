import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MNDE_UI_PORT || 8080);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function sendText(res, status, text) {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": body.byteLength,
    "content-type": "text/plain; charset=utf-8"
  });
  res.end(body);
}

function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT)) return null;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "method not allowed");
    return;
  }
  const pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  const filePath = resolveFile(pathname);
  if (!filePath) {
    sendText(res, 404, "not found");
    return;
  }
  const stat = statSync(filePath);
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-length": stat.size,
    "content-type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`MNDe UI listening on http://${HOST}:${PORT}\n`);
});
