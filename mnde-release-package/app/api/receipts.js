import http from "http";
import { canonicalizeJson, parseStrictJson } from "../shared/json.js";
import { handleReceiptApi } from "./receipts_handlers.js";

const ROUTES = new Set([
    "/receipts/verify",
    "/receipts/replay",
    "/receipts/show",
    "/receipts/index",
    "/receipts/find",
    "/receipts/stats",
    "/receipts/proof",
    "/receipts/export"
]);

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.byteLength;
            if (size > 1048576) {
                reject(new Error("ERR_BODY_TOO_LARGE"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function errorBody(error) {
    return {
        schema_version: "mnde.receipt_api_error.v1",
        status: "FAILED",
        reason_code: error.message.startsWith("ERR_") ? error.message : "ERR_RECEIPT_API_FAILED",
        error: error.message
    };
}

function write(res, status, body) {
    const bytes = Buffer.from(`${canonicalizeJson(body)}\n`, "utf8");
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": bytes.byteLength,
        "cache-control": "no-store"
    });
    res.end(bytes);
}

export function createReceiptsApiServer(options = {}) {
    const allowedRoots = options.allowedRoots ?? (process.env.MNDE_API_ALLOWED_ROOTS ? process.env.MNDE_API_ALLOWED_ROOTS.split(";") : [process.cwd()]);
    return http.createServer(async (req, res) => {
        try {
            const route = new URL(req.url, "http://127.0.0.1").pathname;
            if (!ROUTES.has(route)) throw new Error("ERR_ROUTE_NOT_FOUND");
            if (req.method !== "POST") throw new Error("ERR_METHOD_NOT_ALLOWED");
            const contentType = req.headers["content-type"] ?? "";
            if (!String(contentType).startsWith("application/json")) throw new Error("ERR_JSON_BODY_REQUIRED");
            const parsed = parseStrictJson(await readBody(req));
            if (!parsed.ok) throw new Error(parsed.reason === "duplicate_json_keys" ? "ERR_DUPLICATE_JSON_KEYS" : "ERR_INVALID_JSON");
            const result = await handleReceiptApi(route, parsed.value, allowedRoots);
            write(res, 200, result);
        } catch (error) {
            write(res, 400, errorBody(error));
        }
    });
}

if (process.argv[1] && process.argv[1].endsWith("receipts.js")) {
    const bind = process.env.MNDE_RECEIPTS_API_BIND ?? "127.0.0.1:8790";
    const [host, portText] = bind.split(":");
    createReceiptsApiServer().listen(Number(portText), host, () => {
        process.stdout.write(`${canonicalizeJson({ schema_version: "mnde.receipt_api_start.v1", bind })}\n`);
    });
}
