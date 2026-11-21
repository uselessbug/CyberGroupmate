export interface ProviderHttpError extends Error {
    status?: number;
    retryAfterMs?: number;
    errorCode?: string;
}

type HeaderLike =
    | Headers
    | { get?: (name: string) => string | null | undefined; [key: string]: unknown }
    | undefined;

export function parseRetryAfterHeaderMs(rawHeader: string | null | undefined): number | undefined {
    if (!rawHeader || typeof rawHeader !== "string") return undefined;
    const trimmed = rawHeader.trim();
    if (!trimmed) return undefined;

    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const secs = Number(trimmed);
        return Number.isFinite(secs) && secs >= 0 ? Math.ceil(secs * 1000) : undefined;
    }

    const parsedDateMs = Date.parse(trimmed);
    if (Number.isFinite(parsedDateMs)) {
        return Math.max(0, parsedDateMs - Date.now());
    }
    return undefined;
}

function readHeaderValue(headers: HeaderLike, name: string): string | undefined {
    if (!headers) return undefined;
    if (typeof headers.get === "function") {
        const val = headers.get(name);
        return typeof val === "string" ? val : undefined;
    }
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() !== lower) continue;
        if (typeof v === "string") return v;
        if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    }
    return undefined;
}

export function extractProviderErrorCode(body: string): string | undefined {
    if (!body) return undefined;
    try {
        const parsed = JSON.parse(body) as {
            code?: unknown;
            error?: { code?: unknown; type?: unknown; status?: unknown };
        };
        const cand = parsed?.error?.code ?? parsed?.code ?? parsed?.error?.type ?? parsed?.error?.status;
        if (typeof cand === "string" && cand.trim()) return cand.trim();
        if (typeof cand === "number" && Number.isFinite(cand)) return String(cand);
    } catch {
        // non-JSON error body
    }
    return undefined;
}

export function createProviderHttpError(
    providerLabel: string,
    status: number,
    statusText: string,
    body: string,
    headers?: HeaderLike,
): ProviderHttpError {
    const err = new Error(
        `${providerLabel} API error ${status}: ${statusText} — ${body}`,
    ) as ProviderHttpError;
    err.status = status;
    const retryAfterMs = parseRetryAfterHeaderMs(readHeaderValue(headers, "retry-after"));
    if (retryAfterMs !== undefined) {
        err.retryAfterMs = retryAfterMs;
    }
    const errorCode = extractProviderErrorCode(body);
    if (errorCode !== undefined) {
        err.errorCode = errorCode;
    }
    return err;
}

export function enrichSdkProviderError(err: unknown): Error {
    if (!(err instanceof Error)) {
        return new Error(String(err));
    }
    const rec = err as ProviderHttpError & {
        statusCode?: unknown;
        code?: unknown;
        headers?: HeaderLike;
        error?: { code?: unknown; type?: unknown };
    };
    if (typeof rec.status !== "number" && typeof rec.statusCode === "number") {
        rec.status = rec.statusCode;
    }
    if (rec.retryAfterMs === undefined && rec.headers) {
        const parsedRetry = parseRetryAfterHeaderMs(readHeaderValue(rec.headers, "retry-after"));
        if (parsedRetry !== undefined) {
            rec.retryAfterMs = parsedRetry;
        }
    }
    if (rec.errorCode === undefined) {
        const cand = rec.error?.code ?? rec.code ?? rec.error?.type;
        if (typeof cand === "string" && cand.trim()) {
            rec.errorCode = cand.trim();
        }
    }
    return rec;
}
