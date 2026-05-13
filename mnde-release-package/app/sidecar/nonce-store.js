export class MemoryNonceStore {
    constructor(ttlMs = 5 * 60 * 1000) {
        this.ttlMs = ttlMs;
        this.seen = new Map();
    }
    reserve(keyId, nonce, nowMs = Date.now()) {
        this.prune(nowMs);
        const key = `${keyId}:${nonce}`;
        if (this.seen.has(key)) {
            return false;
        }
        this.seen.set(key, nowMs + this.ttlMs);
        return true;
    }
    prune(nowMs = Date.now()) {
        for (const [key, expiresAt] of this.seen.entries()) {
            if (expiresAt <= nowMs) {
                this.seen.delete(key);
            }
        }
    }
}

