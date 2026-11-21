import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import Database from "better-sqlite3";
import { HistoryUnsupportedFormatError, HistoryUsageError } from "./errors.js";
import {
    assertValidIanaTimezone,
    isQceSystemMessage,
    normalizeMessageId,
    normalizeQceTimestamp,
    parsePositiveDecimalUin,
    type QceRawChatInfo,
    type QceRawElement,
    type QceRawExportMeta,
    type QceRawMention,
    type QceRawMessage,
} from "./qce-normalize.js";

const require = createRequire(import.meta.url);
const { parser: createJsonParser } = require("stream-json") as {
    parser: (options?: Record<string, unknown>) => Transform;
};

export type QceExportFormat = "json" | "jsonl-chunked";

export interface QceChunkedManifest {
    exportInfo?: QceRawExportMeta;
    metadata?: QceRawExportMeta;
    chatInfo?: QceRawChatInfo;
    chunked?: {
        format?: string;
        chunksDir?: string;
        totalChunks?: number;
        totalMessages?: number;
        chunks?: Array<{
            index?: unknown;
            file?: unknown;
            path?: unknown;
            fileName?: unknown;
            filename?: unknown;
            messageCount?: unknown;
        }>;
    };
    [key: string]: unknown;
}

export interface QceMalformedLineWarning {
    chunkFile: string;
    lineNumber: number;
    reason: string;
}

export interface QceUidResolutionStats {
    totalDistinctUids: number;
    resolvedUids: number;
    unresolvedUids: number;
    unresolvedExamples: string[];
}

export interface StagedQceExport {
    format: QceExportFormat;
    inputPath: string;
    inputKey: string;
    metadata: QceRawExportMeta;
    chatInfo: QceRawChatInfo;
    uidToUin: Map<string, string>;
    userMapHash: string;
    uidResolution: QceUidResolutionStats;
    totalRawMessages: number;
    validIdMessages: number;
    skippedInvalidId: number;
    intraExportDuplicates: number;
    intraExportConflicts: number;
    malformedLineCount: number;
    malformedLines: QceMalformedLineWarning[];
    hasCursor(tsMs: number, sourceOrdinal: number): boolean;
    iterateMessages(afterCursor?: { tsMs: number; sourceOrdinal: number }): IterableIterator<{
        sourceOrdinal: number;
        rawId: string;
        tsMs: number;
        timeUnknown: boolean;
        raw: QceRawMessage;
    }>;
    cleanup(): void;
}

export interface StageQceOptions {
    userMapPath?: string;
    timezone: string;
    includeSystem?: boolean;
    includeRecalled?: boolean;
    signal?: AbortSignal;
}

const MAX_JSON_DEPTH = 128;
const MAX_KEY_CHARS = 1024;
const MAX_NUMBER_CHARS = 128;
const MAX_RETAINED_STRING_CHARS = 256 * 1024;
const MAX_HEADER_PROJECTED_BYTES = 256 * 1024;
const MAX_MESSAGE_PROJECTED_BYTES = 4 * 1024 * 1024;
const MAX_JSONL_LINE_CHARS = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_USER_MAP_BYTES = 16 * 1024 * 1024;
const MAX_MALFORMED_WARNINGS_STORED = 200;
const SPOOL_FLUSH_BATCH_ROWS = 500;
const SPOOL_FLUSH_BATCH_BYTES = 4 * 1024 * 1024;

const METADATA_KEYS = new Set(["name", "version", "exportTime", "exportedAt", "format"]);
const CHAT_INFO_KEYS = new Set([
    "name",
    "title",
    "type",
    "uid",
    "uin",
    "peerUid",
    "peerUin",
    "selfUid",
    "selfUin",
    "memberCount",
]);
const MESSAGE_KEYS = new Set([
    "id",
    "messageId",
    "seq",
    "timestamp",
    "time",
    "timeStr",
    "type",
    "messageType",
    "recalled",
    "system",
    "isSystem",
    "sender",
    "content",
]);
const SENDER_KEYS = new Set([
    "uid",
    "uin",
    "name",
    "nickname",
    "nick",
    "groupCard",
    "card",
    "remark",
    "title",
    "role",
]);
const CONTENT_KEYS = new Set(["text", "elements", "mentions", "resources"]);

const UNSUPPORTED_EXTENSIONS = new Set([
    ".html",
    ".htm",
    ".txt",
    ".xlsx",
    ".xls",
    ".csv",
    ".zip",
    ".js",
]);

function unsupportedFormatError(detail: string): Error {
    return new HistoryUnsupportedFormatError(detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAbortError(): Error {
    const err = new Error("QCE staging aborted");
    err.name = "AbortError";
    return err;
}

/**
 * Quote unsafe integer literals (>= 16 digits outside JSON strings) before JSON.parse
 * so 64-bit snowflake message IDs / wide QQ UINs never silently lose precision.
 */
export function parseJsonPreservingWideInts(rawText: string): unknown {
    let out = "";
    let lastFlush = 0;
    let inString = false;
    let escaped = false;
    const n = rawText.length;

    for (let i = 0; i < n; i++) {
        const ch = rawText[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === "\"") {
                inString = false;
            }
            continue;
        }
        if (ch === "\"") {
            inString = true;
            continue;
        }

        // Potential start of a JSON number token (outside strings)
        const prev = i > 0 ? rawText[i - 1] : "";
        const isDigitOrMinus = (ch >= "0" && ch <= "9") || ch === "-";
        const isBoundaryBefore = i === 0 || prev === ":" || prev === "[" || prev === "," || prev === " " || prev === "\t" || prev === "\n" || prev === "\r";
        if (isDigitOrMinus && isBoundaryBefore) {
            let j = ch === "-" ? i + 1 : i;
            const digitStart = j;
            while (j < n && rawText[j] >= "0" && rawText[j] <= "9") {
                j++;
            }
            const digitLen = j - digitStart;
            const next = j < n ? rawText[j] : "";
            const isPureInteger = digitLen > 0 && next !== "." && next !== "e" && next !== "E";
            if (isPureInteger && digitLen >= 16) {
                const token = rawText.slice(i, j);
                const numVal = Number(token);
                if (!Number.isSafeInteger(numVal)) {
                    out += rawText.slice(lastFlush, i) + `"${token}"`;
                    lastFlush = j;
                    i = j - 1;
                    continue;
                }
            }
            if (j > i) {
                i = j - 1;
            }
        }
    }

    if (lastFlush === 0) {
        return JSON.parse(rawText);
    }
    out += rawText.slice(lastFlush);
    return JSON.parse(out);
}

function openRegularFileNoFollow(filePath: string, label: string): { fd: number; size: number } {
    const oNoFollow = fs.constants.O_NOFOLLOW ?? 0;
    let fd: number;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | oNoFollow);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ELOOP") {
            throw new Error(`Refusing symlink for ${label}: ${filePath}`);
        }
        throw err;
    }
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) {
            throw new Error(`${label} is not a regular file: ${filePath}`);
        }
        return { fd, size: st.size };
    } catch (err) {
        try {
            fs.closeSync(fd);
        } catch {
            // ignore
        }
        throw err;
    }
}

function readBoundedFileTextFromFd(fd: number, size: number, fileLabel: string, maxBytes: number): { text: string; buffer: Buffer } {
    try {
        if (size > maxBytes) {
            throw new Error(`${fileLabel} exceeds maximum allowed size (${size} > ${maxBytes} bytes)`);
        }
        const buffer = fs.readFileSync(fd);
        if (buffer.length > maxBytes) {
            throw new Error(`${fileLabel} exceeds maximum allowed size (${buffer.length} > ${maxBytes} bytes)`);
        }
        return { text: buffer.toString("utf8"), buffer };
    } finally {
        try {
            fs.closeSync(fd);
        } catch {
            // ignore
        }
    }
}

const HAS_PROC_SELF_FD = process.platform === "linux" && fs.existsSync("/proc/self/fd");

function openExportRootDir(exportRootPath: string): { realRoot: string; rootFd: number } {
    const realRoot = fs.realpathSync(exportRootPath);
    const rootStat = fs.statSync(realRoot);
    if (!rootStat.isDirectory()) {
        throw new Error(`QCE export root is not a directory: ${realRoot}`);
    }
    const oDir = fs.constants.O_DIRECTORY ?? 0;
    const oNoFollow = fs.constants.O_NOFOLLOW ?? 0;
    const rootFd = fs.openSync(realRoot, fs.constants.O_RDONLY | oDir | oNoFollow);
    try {
        const st = fs.fstatSync(rootFd);
        if (!st.isDirectory() || st.dev !== rootStat.dev || st.ino !== rootStat.ino) {
            throw new Error(`QCE export root is not a directory or changed during open: ${realRoot}`);
        }
        return { realRoot, rootFd };
    } catch (err) {
        try {
            fs.closeSync(rootFd);
        } catch {
            // ignore
        }
        throw err;
    }
}

function closeFdQuietly(fd: number): void {
    try {
        fs.closeSync(fd);
    } catch {
        // ignore
    }
}

/**
 * Open a regular file inside an already-opened export root directory descriptor,
 * traversing every relative path segment step-by-step with O_NOFOLLOW (via /proc/self/fd
 * on Linux when available, failing closed on any error without pathname fallback; otherwise
 * lstatSync + O_NOFOLLOW + fstatSync/lstatSync dev/ino verification + realpathSync containment)
 * so ancestor-directory symlink swaps (TOCTOU) cannot escape containment.
 */
function openFileWithinRootDirFd(
    rootFd: number,
    realRoot: string,
    relSegments: readonly string[],
    label: string,
): { fd: number; size: number; realPath: string } {
    if (relSegments.length === 0) {
        throw new Error(`Invalid empty relative path for ${label}`);
    }
    for (const seg of relSegments) {
        if (!seg || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\")) {
            throw new Error(`Unsafe relative path segment "${seg}" in ${label}`);
        }
    }
    const oNoFollow = fs.constants.O_NOFOLLOW ?? 0;
    const oDir = fs.constants.O_DIRECTORY ?? 0;
    const relPathDisplay = relSegments.join("/");

    let curFd = rootFd;
    const openedIntermediateFds: number[] = [];
    let leafFd: number | null = null;

    try {
        if (process.platform === "linux") {
            if (!HAS_PROC_SELF_FD) {
                throw new Error(`Cannot enforce directory-fd containment for ${label} (${relPathDisplay}): /proc/self/fd is unavailable on Linux`);
            }
            for (let i = 0; i < relSegments.length - 1; i++) {
                const seg = relSegments[i];
                let nextFd: number;
                try {
                    nextFd = fs.openSync(`/proc/self/fd/${curFd}/${seg}`, fs.constants.O_RDONLY | oDir | oNoFollow);
                } catch (err) {
                    const code = (err as NodeJS.ErrnoException)?.code;
                    if (code === "ELOOP" || code === "ENOTDIR") {
                        throw new Error(`Refusing symlink or non-directory ancestor in ${label} (${relPathDisplay}): ${seg} escapes containment policy`);
                    }
                    if (code === "ENOENT") {
                        throw new Error(`Missing declared ${label}: ${path.join(realRoot, ...relSegments.slice(0, i + 1))}`);
                    }
                    throw err;
                }
                openedIntermediateFds.push(nextFd);
                curFd = nextFd;
            }

            const leafSeg = relSegments[relSegments.length - 1];
            try {
                leafFd = fs.openSync(`/proc/self/fd/${curFd}/${leafSeg}`, fs.constants.O_RDONLY | oNoFollow);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException)?.code;
                if (code === "ELOOP" || code === "ENOTDIR") {
                    throw new Error(`Refusing symlink in ${label} (${relPathDisplay}): escapes containment policy`);
                }
                if (code === "ENOENT") {
                    throw new Error(`Missing declared ${label}: ${path.join(realRoot, ...relSegments)}`);
                }
                throw err;
            }
        } else {
            let curPath = realRoot;
            for (let i = 0; i < relSegments.length - 1; i++) {
                const seg = relSegments[i];
                curPath = path.join(curPath, seg);
                let lst: fs.Stats;
                try {
                    lst = fs.lstatSync(curPath);
                } catch (err) {
                    const code = (err as NodeJS.ErrnoException)?.code;
                    if (code === "ENOENT") {
                        throw new Error(`Missing declared ${label}: ${curPath}`);
                    }
                    throw err;
                }
                if (lst.isSymbolicLink() || !lst.isDirectory()) {
                    throw new Error(`Refusing symlink or non-directory ancestor in ${label} (${relPathDisplay}): ${seg} escapes containment policy`);
                }
                const dirFd = fs.openSync(curPath, fs.constants.O_RDONLY | oDir | oNoFollow);
                openedIntermediateFds.push(dirFd);
                const dirStat = fs.fstatSync(dirFd);
                if (!dirStat.isDirectory() || dirStat.dev !== lst.dev || dirStat.ino !== lst.ino) {
                    throw new Error(`Ancestor directory changed during open for ${label} (${relPathDisplay}): ${seg} escapes containment policy`);
                }
            }
            const leafPath = path.join(curPath, relSegments[relSegments.length - 1]);
            let leafLst: fs.Stats;
            try {
                leafLst = fs.lstatSync(leafPath);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException)?.code;
                if (code === "ENOENT") {
                    throw new Error(`Missing declared ${label}: ${leafPath}`);
                }
                throw err;
            }
            if (leafLst.isSymbolicLink()) {
                throw new Error(`Refusing symlink in ${label} (${relPathDisplay}): escapes containment policy`);
            }
            if (!leafLst.isFile()) {
                throw new Error(`${label} is not a regular file: ${relPathDisplay}`);
            }
            leafFd = openRegularFileNoFollow(leafPath, label).fd;
            const leafOpenStat = fs.fstatSync(leafFd);
            if (!leafOpenStat.isFile() || leafOpenStat.dev !== leafLst.dev || leafOpenStat.ino !== leafLst.ino) {
                throw new Error(`${label} changed during open (concurrent swap detected): ${relPathDisplay} escapes containment policy`);
            }
        }

        const fdStat = fs.fstatSync(leafFd);
        if (!fdStat.isFile()) {
            throw new Error(`${label} is not a regular file: ${relPathDisplay}`);
        }

        // Cross-check opened inode against non-symlink realpath inside realRoot
        const checkedPath = assertNoSymlinkSegments(realRoot, relPathDisplay, label);
        const realPath = fs.realpathSync(checkedPath);
        if (!isInsideDirectory(realRoot, realPath)) {
            throw new Error(`${label} escapes export root: ${relPathDisplay}`);
        }
        const pathStat = fs.statSync(realPath);
        if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
            throw new Error(`${label} inode mismatch during open (concurrent swap detected): ${relPathDisplay} escapes containment policy`);
        }

        const outFd = leafFd;
        leafFd = null;
        return { fd: outFd, size: fdStat.size, realPath };
    } finally {
        if (leafFd !== null) closeFdQuietly(leafFd);
        for (const dfd of openedIntermediateFds) {
            closeFdQuietly(dfd);
        }
    }
}

export function loadUserMapFile(userMapPath: string | undefined): Map<string, string> {
    const result = new Map<string, string>();
    if (!userMapPath) return result;
    const resolved = path.resolve(userMapPath);
    if (!fs.existsSync(resolved)) {
        throw new HistoryUsageError(`--user-map file not found: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
        throw new HistoryUsageError(`--user-map path is not a regular file: ${resolved}`);
    }
    if (stat.size > MAX_USER_MAP_BYTES) {
        throw new HistoryUsageError(
            `--user-map file exceeds maximum allowed size (${stat.size} > ${MAX_USER_MAP_BYTES} bytes): ${resolved}`,
        );
    }
    const rawText = fs.readFileSync(resolved, "utf8");
    let parsed: unknown;
    try {
        parsed = parseJsonPreservingWideInts(rawText.replace(/^\uFEFF/, ""));
    } catch (err) {
        throw new HistoryUsageError(`Invalid JSON in --user-map file (${resolved}): ${String(err)}`);
    }
    if (!isPlainObject(parsed)) {
        throw new HistoryUsageError(`--user-map file (${resolved}) must contain a JSON object mapping UID -> positive integer QQ UIN`);
    }
    for (const [uidKey, uinVal] of Object.entries(parsed)) {
        const cleanUid = uidKey.trim();
        if (!cleanUid) {
            throw new HistoryUsageError(`Invalid empty UID key in --user-map file (${resolved})`);
        }
        const validUin = parsePositiveDecimalUin(uinVal);
        if (!validUin) {
            throw new HistoryUsageError(`Invalid QQ UIN "${String(uinVal)}" for UID "${cleanUid}" in --user-map file (${resolved})`);
        }
        result.set(cleanUid, validUin);
    }
    return result;
}

export function hashUserMap(userMap: ReadonlyMap<string, string>): string {
    const sorted = [...userMap.entries()].sort(([a], [b]) => a.localeCompare(b));
    return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function projectAndSanitizeRawMessage(raw: QceRawMessage): QceRawMessage {
    const out: QceRawMessage = {};
    for (const key of MESSAGE_KEYS) {
        if (key === "sender" || key === "content") continue;
        if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) {
            out[key] = raw[key];
        }
    }

    if (raw.sender && typeof raw.sender === "object" && !Array.isArray(raw.sender)) {
        const senderCopy: Record<string, unknown> = {};
        for (const key of SENDER_KEYS) {
            if (Object.prototype.hasOwnProperty.call(raw.sender, key) && raw.sender[key] !== undefined) {
                senderCopy[key] = raw.sender[key];
            }
        }
        out.sender = senderCopy as QceRawMessage["sender"];
    }

    // Strip recalled message body content BEFORE spooling so private recalled text never hits temp SQLite!
    if (raw.recalled === true) {
        out.recalled = true;
        return out;
    }

    if (raw.content && typeof raw.content === "object" && !Array.isArray(raw.content)) {
        const contentCopy: Record<string, unknown> = {};
        for (const key of CONTENT_KEYS) {
            if (Object.prototype.hasOwnProperty.call(raw.content, key) && raw.content[key] !== undefined) {
                contentCopy[key] = raw.content[key];
            }
        }
        out.content = contentCopy as QceRawMessage["content"];
    }

    return out;
}

function collectUidUinObservations(
    raw: QceRawMessage,
    recordPair: (uidRaw: unknown, uinRaw: unknown) => void,
): void {
    if (raw.sender && typeof raw.sender === "object") {
        recordPair(raw.sender.uid, raw.sender.uin);
    }
    if (Array.isArray(raw.content?.mentions)) {
        for (const m of raw.content.mentions as QceRawMention[]) {
            if (!m || typeof m !== "object") continue;
            if (m.isAll || m.type === "all" || m.atType === 1) continue;
            recordPair(m.uid, m.uin);
        }
    }
    if (Array.isArray(raw.content?.elements)) {
        for (const el of raw.content.elements as QceRawElement[]) {
            if (!el || typeof el !== "object") continue;
            if (typeof el.type !== "string" || el.type.trim().toLowerCase() !== "at") continue;
            const data = el.data && typeof el.data === "object" ? el.data : undefined;
            if (el.atType === 1 || data?.atType === 1 || data?.type === "all") continue;
            recordPair(el.uid ?? data?.uid, el.uin ?? data?.uin ?? data?.qq);
        }
    }
}

function collectChatInfoObservations(
    chatInfo: QceRawChatInfo,
    recordPair: (uidRaw: unknown, uinRaw: unknown) => void,
): void {
    recordPair(chatInfo.selfUid, chatInfo.selfUin);
    const chatType = typeof chatInfo.type === "string" ? chatInfo.type.trim().toLowerCase() : "";
    if (chatType === "private" || chatType === "temp") {
        recordPair(chatInfo.peerUid ?? chatInfo.uid, chatInfo.peerUin ?? chatInfo.uin);
        if (chatInfo.uid && chatInfo.uid !== chatInfo.peerUid) {
            recordPair(chatInfo.uid, chatInfo.uin ?? chatInfo.peerUin);
        }
    }
}

function resolveUidToUinMapFromSpool(
    spoolDb: Database.Database,
    userMap: Map<string, string>,
): { uidToUin: Map<string, string>; stats: QceUidResolutionStats } {
    const uidToUin = new Map<string, string>();

    const conflictRows = spoolDb.prepare(`
        SELECT uid FROM spool_uid_uin GROUP BY uid HAVING COUNT(*) > 1
    `).all() as Array<{ uid: string }>;
    const selectUinsForUid = spoolDb.prepare(`
        SELECT uin FROM spool_uid_uin WHERE uid = ? ORDER BY uin ASC
    `);

    for (const { uid } of conflictRows) {
        const list = (selectUinsForUid.all(uid) as Array<{ uin: string }>).map(r => r.uin);
        const mappedUin = userMap.get(uid);
        if (!mappedUin) {
            throw new Error(
                `Conflicting QQ UIN observations for UID "${uid}" (${list.join(", ")}); resolve explicitly with --user-map.`,
            );
        }
        if (!list.includes(mappedUin)) {
            throw new Error(
                `--user-map assigns UID "${uid}" to "${mappedUin}", which disagrees with explicit observed UINs (${list.join(", ")}).`,
            );
        }
        uidToUin.set(uid, mappedUin);
    }

    const singleRows = spoolDb.prepare(`
        SELECT uid, MIN(uin) AS uin FROM spool_uid_uin GROUP BY uid HAVING COUNT(*) = 1
    `).iterate() as Iterable<{ uid: string; uin: string }>;
    for (const row of singleRows) {
        const mappedUin = userMap.get(row.uid);
        if (mappedUin && mappedUin !== row.uin) {
            throw new Error(
                `--user-map assigns UID "${row.uid}" to "${mappedUin}", which disagrees with explicit observed UIN "${row.uin}" in export.`,
            );
        }
        uidToUin.set(row.uid, row.uin);
    }

    for (const [uid, uin] of userMap.entries()) {
        if (!uidToUin.has(uid)) {
            uidToUin.set(uid, uin);
        }
    }

    const totalRow = spoolDb.prepare("SELECT COUNT(*) AS cnt FROM spool_uids").get() as { cnt: number };
    const totalDistinctUids = totalRow.cnt;
    const unresolvedExamples: string[] = [];
    let resolvedCount = 0;
    for (const row of spoolDb.prepare("SELECT uid FROM spool_uids ORDER BY uid ASC").iterate() as Iterable<{ uid: string }>) {
        if (uidToUin.has(row.uid)) {
            resolvedCount++;
        } else if (unresolvedExamples.length < 5) {
            unresolvedExamples.push(row.uid);
        }
    }

    return {
        uidToUin,
        stats: {
            totalDistinctUids,
            resolvedUids: resolvedCount,
            unresolvedUids: totalDistinctUids - resolvedCount,
            unresolvedExamples,
        },
    };
}

function isInsideDirectory(rootRealPath: string, candidateRealPath: string): boolean {
    if (candidateRealPath === rootRealPath) return false;
    const prefix = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
    return candidateRealPath.startsWith(prefix);
}

function validateSafeRelativeSegments(relPath: string, label: string, allowDotSelf = false): string[] {
    if (!relPath || relPath.includes("\0")) {
        throw new Error(`Invalid ${label}: empty or null-byte path`);
    }
    const normalizedSlashes = relPath.replace(/\\/g, "/");
    if (path.isAbsolute(relPath) || path.posix.isAbsolute(normalizedSlashes) || /^[a-zA-Z]:/.test(relPath)) {
        throw new Error(`Unsafe absolute ${label} in manifest: "${relPath}"`);
    }
    const rawSegments = normalizedSlashes.split("/").filter(Boolean);
    if (rawSegments.length === 0 || rawSegments.some(seg => seg === "..")) {
        throw new Error(`Unsafe path traversal in ${label}: "${relPath}"`);
    }
    const segments = rawSegments.filter(seg => seg !== ".");
    if (!allowDotSelf && segments.length === 0) {
        throw new Error(`Unsafe path traversal in ${label}: "${relPath}"`);
    }
    return segments;
}

function assertNoSymlinkSegments(baseDir: string, relPath: string, label: string): string {
    const segments = relPath.split("/").filter(Boolean);
    let current = baseDir;
    for (const seg of segments) {
        current = path.join(current, seg);
        let lst: fs.Stats;
        try {
            lst = fs.lstatSync(current);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") {
                throw new Error(`Missing declared ${label}: ${current}`);
            }
            throw err;
        }
        if (lst.isSymbolicLink()) {
            throw new Error(`Refusing symlink in ${label} (${relPath}): ${current} escapes containment policy`);
        }
    }
    return current;
}

interface DetectedSource {
    format: QceExportFormat;
    exportRoot?: string;
    manifestRelSegments?: string[];
    manifestPath?: string;
    jsonPath?: string;
}

function detectQceSource(inputPath: string): DetectedSource {
    if (!fs.existsSync(inputPath)) {
        throw new HistoryUsageError(`Input path does not exist: ${inputPath}`);
    }
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
        const realRoot = fs.realpathSync(inputPath);
        const manifestJson = path.join(realRoot, "manifest.json");
        if (fs.existsSync(manifestJson)) {
            const lst = fs.lstatSync(manifestJson);
            if (lst.isSymbolicLink()) {
                throw new Error(`Refusing symlink manifest.json in export directory: ${manifestJson}`);
            }
            const realManifest = fs.realpathSync(manifestJson);
            if (!isInsideDirectory(realRoot, realManifest) || !lst.isFile()) {
                throw new Error(`manifest.json escapes export directory or is not a regular file: ${manifestJson}`);
            }
            return {
                format: "jsonl-chunked",
                exportRoot: realRoot,
                manifestRelSegments: ["manifest.json"],
                manifestPath: manifestJson,
            };
        }
        const modernManifestJs = path.join(inputPath, "data", "manifest.js");
        const rootManifestJs = path.join(inputPath, "manifest.js");
        if (fs.existsSync(modernManifestJs) || fs.existsSync(rootManifestJs)) {
            throw unsupportedFormatError("qce-modern-html-chunked / manifest.js");
        }
        throw new HistoryUsageError(
            `Directory "${inputPath}" does not contain a QCE manifest.json. Please pass a QCE .json file or chunked JSONL directory.`,
        );
    }

    if (!stat.isFile()) {
        throw new HistoryUsageError(`QCE input path is neither a file nor a directory: ${inputPath}`);
    }

    const base = path.basename(inputPath).toLowerCase();
    const ext = path.extname(inputPath).toLowerCase();
    if (UNSUPPORTED_EXTENSIONS.has(ext)) {
        throw unsupportedFormatError(base === "manifest.js" ? "manifest.js" : ext);
    }
    if (base === "manifest.json") {
        const lst = fs.lstatSync(inputPath);
        if (lst.isSymbolicLink()) {
            throw new Error(`Refusing symlink manifest.json: ${inputPath}`);
        }
        const realRoot = fs.realpathSync(path.dirname(inputPath));
        return {
            format: "jsonl-chunked",
            exportRoot: realRoot,
            manifestRelSegments: [path.basename(inputPath)],
            manifestPath: path.join(realRoot, path.basename(inputPath)),
        };
    }
    if (ext === ".json") {
        return { format: "json", jsonPath: inputPath };
    }
    throw unsupportedFormatError(ext || base);
}

type JsonContainerFrame =
    | {
        kind: "object";
        obj: Record<string, unknown>;
        key: string | null;
        skip: boolean;
    }
    | {
        kind: "array";
        arr: unknown[];
        skip: boolean;
    };

async function streamSingleJsonIntoSpool(
    jsonPath: string,
    onMessage: (raw: QceRawMessage) => void,
    signal?: AbortSignal,
): Promise<{
    inputKey: string;
    metadata: QceRawExportMeta;
    chatInfo: QceRawChatInfo;
}> {
    const hash = createHash("sha256");
    let firstChunk = true;

    const hashAndStripBom = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            let out = chunk;
            if (firstChunk) {
                firstChunk = false;
                if (out.length >= 3 && out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf) {
                    out = out.subarray(3);
                }
            }
            callback(null, out);
        },
    });

    const jsonParser = createJsonParser({
        packStrings: false,
        streamStrings: true,
        packKeys: false,
        streamKeys: true,
        packNumbers: false,
        streamNumbers: true,
    });

    let rootObj: Record<string, unknown> | null = null;
    let metadata: QceRawExportMeta = {};
    let chatInfo: QceRawChatInfo = {};
    let inMessagesArray = false;
    let sawMessagesArray = false;
    let headerProjectedBytes = 0;

    const stack: JsonContainerFrame[] = [];
    let currentKeyActive = false;
    let currentKeyChunks: string[] = [];
    let currentKeyLength = 0;

    let currentStringActive = false;
    let currentStringSkip = false;
    let currentStringChunks: string[] = [];
    let currentStringLength = 0;

    let currentNumberActive = false;
    let currentNumberSkip = false;
    let currentNumberChunks: string[] = [];
    let currentNumberLength = 0;

    let currentMessageBytes = 0;

    const chargeProjectedBytes = (delta: number) => {
        if (inMessagesArray) {
            currentMessageBytes += delta;
            if (currentMessageBytes > MAX_MESSAGE_PROJECTED_BYTES) {
                throw new Error(`Projected QCE message exceeds maximum size (${MAX_MESSAGE_PROJECTED_BYTES} bytes)`);
            }
        } else if (stack.length >= 2) {
            headerProjectedBytes += delta;
            if (headerProjectedBytes > MAX_HEADER_PROJECTED_BYTES) {
                throw new Error(`Projected QCE metadata/chatInfo exceeds maximum size (${MAX_HEADER_PROJECTED_BYTES} bytes)`);
            }
        }
    };

    const shouldSkipValue = (parentFrame: JsonContainerFrame | undefined, key: string | null): boolean => {
        if (!parentFrame) return false;
        if (parentFrame.skip) return true;
        if (parentFrame.kind !== "object" || key === null) return false;

        // Root level (stack.length === 1)
        if (stack.length === 1) {
            return key !== "metadata" && key !== "chatInfo" && key !== "messages";
        }

        // Inside metadata (stack.length === 2, root key === "metadata")
        if (stack.length === 2 && stack[0].kind === "object" && stack[0].key === "metadata") {
            return !METADATA_KEYS.has(key);
        }

        // Inside chatInfo (stack.length === 2, root key === "chatInfo")
        if (stack.length === 2 && stack[0].kind === "object" && stack[0].key === "chatInfo") {
            return !CHAT_INFO_KEYS.has(key);
        }

        // Inside a message element (stack.length >= 3, root key === "messages")
        if (inMessagesArray) {
            if (stack.length === 3) {
                return !MESSAGE_KEYS.has(key);
            }
            if (stack.length === 4 && stack[2].kind === "object" && stack[2].key === "sender") {
                return !SENDER_KEYS.has(key);
            }
            if (stack.length === 4 && stack[2].kind === "object" && stack[2].key === "content") {
                return !CONTENT_KEYS.has(key);
            }
            if (key === "avatarBase64" || key === "avatar" || key === "dataUrl" || key === "rawMessage" || key === "html") {
                return true;
            }
        }

        return false;
    };

    const assignValue = (val: unknown) => {
        const parent = stack[stack.length - 1];
        if (!parent) {
            if (isPlainObject(val)) {
                rootObj = val;
            }
            return;
        }
        if (parent.skip) return;

        if (parent.kind === "object") {
            if (parent.key === null) return;
            if (stack.length === 1) {
                if (parent.key === "metadata" && isPlainObject(val)) {
                    metadata = val as QceRawExportMeta;
                } else if (parent.key === "chatInfo" && isPlainObject(val)) {
                    chatInfo = val as QceRawChatInfo;
                }
                parent.key = null;
                return;
            }
            parent.obj[parent.key] = val;
            parent.key = null;
            return;
        }

        // Inside messages array at depth 2: emit message immediately without keeping in array!
        if (inMessagesArray && stack.length === 2) {
            if (isPlainObject(val)) {
                onMessage(val as QceRawMessage);
            }
            currentMessageBytes = 0;
            return;
        }

        parent.arr.push(val);
    };

    const parseJsonNumberToken = (rawNum: string): number | string => {
        if (/^-?\d+$/.test(rawNum)) {
            const parsed = Number(rawNum);
            if (Number.isSafeInteger(parsed)) return parsed;
            return rawNum;
        }
        const parsed = Number(rawNum);
        return Number.isFinite(parsed) ? parsed : rawNum;
    };

    const consumer = new Transform({
        objectMode: true,
        transform(token: { name: string; value?: unknown }, _encoding, callback) {
            try {
                switch (token.name) {
                    case "startObject": {
                        if (stack.length === 0) {
                            rootObj = {};
                            stack.push({ kind: "object", obj: rootObj, key: null, skip: false });
                            break;
                        }
                        if (stack.length >= MAX_JSON_DEPTH) {
                            throw new Error(`QCE JSON exceeds maximum nesting depth (${MAX_JSON_DEPTH})`);
                        }
                        const parent = stack[stack.length - 1];
                        const skip = shouldSkipValue(parent, parent.kind === "object" ? parent.key : null);
                        if (!skip) chargeProjectedBytes(16);
                        stack.push({
                            kind: "object",
                            obj: {},
                            key: null,
                            skip,
                        });
                        break;
                    }
                    case "endObject": {
                        const frame = stack.pop();
                        if (!frame || frame.kind !== "object") {
                            throw new Error("Malformed JSON token stream: unexpected endObject");
                        }
                        if (stack.length > 0 && !frame.skip) {
                            assignValue(frame.obj);
                        } else if (stack.length > 0 && frame.skip) {
                            const parent = stack[stack.length - 1];
                            if (parent.kind === "object") parent.key = null;
                        }
                        break;
                    }
                    case "startArray": {
                        if (stack.length === 0) {
                            throw new Error("Expected QCE root JSON object, received array");
                        }
                        if (stack.length >= MAX_JSON_DEPTH) {
                            throw new Error(`QCE JSON exceeds maximum nesting depth (${MAX_JSON_DEPTH})`);
                        }
                        const parent = stack[stack.length - 1];
                        const parentKey = parent.kind === "object" ? parent.key : null;
                        if (stack.length === 1 && parentKey === "messages") {
                            inMessagesArray = true;
                            sawMessagesArray = true;
                            currentMessageBytes = 0;
                            stack.push({ kind: "array", arr: [], skip: false });
                            break;
                        }
                        const skip = shouldSkipValue(parent, parentKey);
                        if (!skip) chargeProjectedBytes(16);
                        stack.push({
                            kind: "array",
                            arr: [],
                            skip,
                        });
                        break;
                    }
                    case "endArray": {
                        const frame = stack.pop();
                        if (!frame || frame.kind !== "array") {
                            throw new Error("Malformed JSON token stream: unexpected endArray");
                        }
                        if (inMessagesArray && stack.length === 1) {
                            inMessagesArray = false;
                            const root = stack[0];
                            if (root.kind === "object") root.key = null;
                            break;
                        }
                        if (!frame.skip) {
                            assignValue(frame.arr);
                        } else if (stack.length > 0) {
                            const parent = stack[stack.length - 1];
                            if (parent.kind === "object") parent.key = null;
                        }
                        break;
                    }
                    case "startKey": {
                        const parent = stack[stack.length - 1];
                        currentKeyActive = true;
                        currentKeyChunks = [];
                        currentKeyLength = 0;
                        if (parent && !parent.skip) {
                            chargeProjectedBytes(16);
                        }
                        break;
                    }
                    case "endKey": {
                        if (!currentKeyActive) break;
                        const parent = stack[stack.length - 1];
                        const keyStr = currentKeyChunks.join("");
                        currentKeyActive = false;
                        currentKeyChunks = [];
                        currentKeyLength = 0;
                        if (parent && parent.kind === "object") {
                            parent.key = keyStr;
                        }
                        break;
                    }
                    case "startString": {
                        const parent = stack[stack.length - 1];
                        currentStringActive = true;
                        currentStringSkip = shouldSkipValue(parent, parent?.kind === "object" ? parent.key : null);
                        currentStringChunks = [];
                        currentStringLength = 0;
                        if (!currentStringSkip) chargeProjectedBytes(16);
                        break;
                    }
                    case "stringChunk": {
                        const piece = String(token.value ?? "");
                        if (currentKeyActive) {
                            const parent = stack[stack.length - 1];
                            if (parent && !parent.skip) {
                                if (currentKeyLength + piece.length > MAX_KEY_CHARS) {
                                    throw new Error(`QCE JSON key exceeds maximum length (${MAX_KEY_CHARS} chars)`);
                                }
                                currentKeyChunks.push(piece);
                                currentKeyLength += piece.length;
                                chargeProjectedBytes(piece.length);
                            } else if (currentKeyLength < MAX_KEY_CHARS) {
                                // Still retain short keys inside skipped frames only up to cap? Actually skipped frames never need keys at all!
                                const rem = MAX_KEY_CHARS - currentKeyLength;
                                currentKeyChunks.push(piece.slice(0, rem));
                                currentKeyLength += Math.min(piece.length, rem);
                            }
                            break;
                        }
                        if (!currentStringActive || currentStringSkip) break;
                        if (currentStringLength < MAX_RETAINED_STRING_CHARS) {
                            const remaining = MAX_RETAINED_STRING_CHARS - currentStringLength;
                            const slice = piece.length > remaining ? piece.slice(0, remaining) : piece;
                            currentStringChunks.push(slice);
                            currentStringLength += slice.length;
                            chargeProjectedBytes(slice.length);
                        }
                        break;
                    }
                    case "endString": {
                        if (!currentStringActive) break;
                        const skip = currentStringSkip;
                        const value = skip ? undefined : currentStringChunks.join("");
                        currentStringActive = false;
                        currentStringSkip = false;
                        currentStringChunks = [];
                        currentStringLength = 0;
                        if (skip) {
                            const parent = stack[stack.length - 1];
                            if (parent?.kind === "object") parent.key = null;
                        } else {
                            assignValue(value);
                        }
                        break;
                    }
                    case "startNumber": {
                        const parent = stack[stack.length - 1];
                        currentNumberActive = true;
                        currentNumberSkip = shouldSkipValue(parent, parent?.kind === "object" ? parent.key : null);
                        currentNumberChunks = [];
                        currentNumberLength = 0;
                        if (!currentNumberSkip) chargeProjectedBytes(16);
                        break;
                    }
                    case "numberChunk": {
                        if (!currentNumberActive || currentNumberSkip) break;
                        const piece = String(token.value ?? "");
                        if (currentNumberLength + piece.length > MAX_NUMBER_CHARS) {
                            throw new Error(`QCE JSON number token exceeds maximum length (${MAX_NUMBER_CHARS} chars)`);
                        }
                        currentNumberChunks.push(piece);
                        currentNumberLength += piece.length;
                        chargeProjectedBytes(piece.length);
                        break;
                    }
                    case "endNumber": {
                        if (!currentNumberActive) break;
                        const skip = currentNumberSkip;
                        const rawNum = skip ? "" : currentNumberChunks.join("");
                        currentNumberActive = false;
                        currentNumberSkip = false;
                        currentNumberChunks = [];
                        currentNumberLength = 0;
                        if (skip) {
                            const parent = stack[stack.length - 1];
                            if (parent?.kind === "object") parent.key = null;
                        } else {
                            assignValue(parseJsonNumberToken(rawNum));
                        }
                        break;
                    }
                    case "trueValue":
                    case "falseValue":
                    case "nullValue": {
                        const parent = stack[stack.length - 1];
                        if (shouldSkipValue(parent, parent?.kind === "object" ? parent.key : null)) {
                            if (parent?.kind === "object") parent.key = null;
                            break;
                        }
                        chargeProjectedBytes(16);
                        assignValue(token.value ?? null);
                        break;
                    }
                    default:
                        break;
                }
                callback();
            } catch (err) {
                callback(err instanceof Error ? err : new Error(String(err)));
            }
        },
    });

    const { fd: jsonFd } = openRegularFileNoFollow(jsonPath, "QCE JSON export");
    const fileStream = fs.createReadStream("", { fd: jsonFd, autoClose: true, highWaterMark: 64 * 1024 });
    const streams = [
        fileStream,
        hashAndStripBom,
        jsonParser,
        consumer,
    ] as const;
    if (signal) {
        await pipeline(streams[0], streams[1], streams[2], streams[3], { signal });
    } else {
        await pipeline(streams[0], streams[1], streams[2], streams[3]);
    }

    if (!rootObj || !sawMessagesArray) {
        throw new Error(`Invalid QCE JSON export (${jsonPath}): missing root object or messages array`);
    }

    return {
        inputKey: `qce:sha256:${hash.digest("hex")}`,
        metadata,
        chatInfo,
    };
}

async function streamChunkedJsonlIntoSpool(
    exportRoot: string,
    manifestRelSegments: readonly string[],
    manifestPath: string,
    onMessage: (raw: QceRawMessage) => void,
    malformedLines: QceMalformedLineWarning[],
    incrementMalformedCount: () => void,
    signal?: AbortSignal,
): Promise<{
    inputKey: string;
    metadata: QceRawExportMeta;
    chatInfo: QceRawChatInfo;
}> {
    if (signal?.aborted) throw createAbortError();

    const { realRoot: realExportRoot, rootFd } = openExportRootDir(exportRoot);
    try {
        const { fd: manifestFd, size: manifestSize } = openFileWithinRootDirFd(
            rootFd,
            realExportRoot,
            manifestRelSegments,
            "QCE manifest.json",
        );
        const { text: manifestText, buffer: manifestBytes } = readBoundedFileTextFromFd(
            manifestFd,
            manifestSize,
            `QCE manifest.json (${manifestPath})`,
            MAX_MANIFEST_BYTES,
        );
        let manifest: QceChunkedManifest;
        try {
            manifest = parseJsonPreservingWideInts(manifestText.replace(/^\uFEFF/, "")) as QceChunkedManifest;
        } catch (err) {
            throw new Error(`Invalid JSON in QCE manifest (${manifestPath}): ${String(err)}`);
        }

        if (!isPlainObject(manifest) || !isPlainObject(manifest.chunked) || manifest.chunked.format !== "jsonl") {
            throw new Error(`Invalid QCE manifest (${manifestPath}): expected chunked.format === "jsonl"`);
        }
        if (!Array.isArray(manifest.chunked.chunks) || manifest.chunked.chunks.length === 0) {
            throw new Error(`Invalid QCE manifest (${manifestPath}): chunked.chunks must be a non-empty array`);
        }

        let chunksDirSegments: string[] = [];
        if (typeof manifest.chunked.chunksDir === "string" && manifest.chunked.chunksDir.trim()) {
            chunksDirSegments = validateSafeRelativeSegments(manifest.chunked.chunksDir.trim(), "chunksDir", true);
            if (chunksDirSegments.length > 0) {
                const checkedDir = assertNoSymlinkSegments(realExportRoot, chunksDirSegments.join("/"), "chunksDir");
                const candidateReal = fs.realpathSync(checkedDir);
                if (!isInsideDirectory(realExportRoot, candidateReal) || !fs.statSync(candidateReal).isDirectory()) {
                    throw new Error(`Declared chunksDir escapes export directory or is not a directory: ${manifest.chunked.chunksDir}`);
                }
            }
        }

        const seenIndices = new Set<number>();
        const validatedChunks: Array<{ index: number; relPath: string; relSegments: string[] }> = [];
        for (const chunk of manifest.chunked.chunks) {
            if (!isPlainObject(chunk)) {
                throw new Error(`Invalid chunk entry in QCE manifest (${manifestPath})`);
            }
            const idx = chunk.index;
            if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 1) {
                throw new Error(`Invalid chunk.index "${String(idx)}" in QCE manifest (${manifestPath}): must be a positive integer`);
            }
            if (seenIndices.has(idx)) {
                throw new Error(`Duplicate chunk.index ${idx} in QCE manifest (${manifestPath})`);
            }
            seenIndices.add(idx);

            const rawRel = chunk.file ?? chunk.path ?? chunk.fileName ?? chunk.filename;
            if (typeof rawRel !== "string") {
                throw new Error(`Missing chunk file/path for chunk.index ${idx} in QCE manifest (${manifestPath})`);
            }
            const chunkSegs = validateSafeRelativeSegments(rawRel.trim(), `chunk[${idx}].path`, false);
            const fullRelSegments = [...chunksDirSegments, ...chunkSegs];
            const fullRelPath = fullRelSegments.join("/");
            const checkedPath = assertNoSymlinkSegments(realExportRoot, fullRelPath, `chunk[${idx}].path`);
            const realChunkPath = fs.realpathSync(checkedPath);
            if (!isInsideDirectory(realExportRoot, realChunkPath) || !fs.statSync(realChunkPath).isFile()) {
                throw new Error(`QCE chunk file escapes export root or is not a regular file: ${rawRel}`);
            }
            validatedChunks.push({ index: idx, relPath: chunkSegs.join("/"), relSegments: fullRelSegments });
        }

        validatedChunks.sort((a, b) => a.index - b.index);

        const hash = createHash("sha256");
        hash.update(manifestBytes);

        for (const chunkInfo of validatedChunks) {
            if (signal?.aborted) throw createAbortError();

            const { fd } = openFileWithinRootDirFd(
                rootFd,
                realExportRoot,
                chunkInfo.relSegments,
                `QCE chunk file ${chunkInfo.relPath}`,
            );
            const stream = fs.createReadStream("", { fd, autoClose: true, highWaterMark: 64 * 1024 });
            const decoder = new StringDecoder("utf8");
            let lineNumber = 0;
            let currentLine = "";
            let currentLineOversized = false;

            const recordMalformed = (lineNo: number, reason: string) => {
                incrementMalformedCount();
                if (malformedLines.length < MAX_MALFORMED_WARNINGS_STORED) {
                    malformedLines.push({
                        chunkFile: chunkInfo.relPath,
                        lineNumber: lineNo,
                        reason,
                    });
                }
            };

            const processCompleteLine = (rawLine: string) => {
                lineNumber++;
                let line = rawLine;
                if (lineNumber === 1 && line.startsWith("\uFEFF")) {
                    line = line.slice(1);
                }
                if (line.endsWith("\r")) {
                    line = line.slice(0, -1);
                }
                if (!line.trim()) return;

                let parsed: unknown;
                try {
                    parsed = parseJsonPreservingWideInts(line);
                } catch {
                    recordMalformed(lineNumber, "malformed_json");
                    return;
                }
                if (!isPlainObject(parsed)) {
                    recordMalformed(lineNumber, "non_object_line");
                    return;
                }
                onMessage(parsed as QceRawMessage);
            };

            const appendText = (text: string) => {
                let offset = 0;
                while (offset < text.length) {
                    const nlIdx = text.indexOf("\n", offset);
                    if (nlIdx === -1) {
                        const tail = text.slice(offset);
                        if (!currentLineOversized) {
                            if (currentLine.length + tail.length > MAX_JSONL_LINE_CHARS) {
                                currentLineOversized = true;
                                currentLine = "";
                            } else {
                                currentLine += tail;
                            }
                        }
                        break;
                    }
                    const segment = text.slice(offset, nlIdx);
                    if (currentLineOversized || currentLine.length + segment.length > MAX_JSONL_LINE_CHARS) {
                        lineNumber++;
                        recordMalformed(lineNumber, "oversized_line");
                    } else {
                        processCompleteLine(currentLine + segment);
                    }
                    currentLine = "";
                    currentLineOversized = false;
                    offset = nlIdx + 1;
                }
            };

            try {
                for await (const buf of stream) {
                    if (signal?.aborted) {
                        throw createAbortError();
                    }
                    const buffer = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
                    hash.update(buffer);
                    appendText(decoder.write(buffer));
                }
                if (signal?.aborted) {
                    throw createAbortError();
                }
                appendText(decoder.end());
                if (currentLineOversized) {
                    lineNumber++;
                    recordMalformed(lineNumber, "oversized_line");
                } else if (currentLine.length > 0) {
                    processCompleteLine(currentLine);
                }
            } finally {
                stream.destroy();
            }
        }

        const metadata = isPlainObject(manifest.exportInfo)
            ? (manifest.exportInfo as QceRawExportMeta)
            : (isPlainObject(manifest.metadata) ? (manifest.metadata as QceRawExportMeta) : {});
        const chatInfoRaw = isPlainObject(manifest.chatInfo) ? { ...manifest.chatInfo } : {};
        delete chatInfoRaw.avatar;
        delete chatInfoRaw.avatarBase64;

        return {
            inputKey: `qce:sha256:${hash.digest("hex")}`,
            metadata,
            chatInfo: chatInfoRaw as QceRawChatInfo,
        };
    } finally {
        closeFdQuietly(rootFd);
    }
}

export async function stageQceExport(
    inputPath: string,
    options: StageQceOptions,
): Promise<StagedQceExport> {
    const timezone = assertValidIanaTimezone(options.timezone);
    if (options.signal?.aborted) throw createAbortError();
    const userMap = loadUserMapFile(options.userMapPath);
    const userMapHash = hashUserMap(userMap);
    const detected = detectQceSource(inputPath);

    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-qce-"));
    try {
        fs.chmodSync(spoolDir, 0o700);
    } catch {
        // best effort on non-POSIX
    }
    const spoolPath = path.join(spoolDir, "spool.db");
    let spoolDb: Database.Database | null = null;
    let closed = false;

    const cleanup = () => {
        if (spoolDb && !closed) {
            closed = true;
            try {
                spoolDb.close();
            } catch {
                // ignore
            }
        }
        try {
            fs.rmSync(spoolDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    };

    try {
        spoolDb = new Database(spoolPath);
        try {
            fs.chmodSync(spoolPath, 0o600);
        } catch {
            // best effort on non-POSIX
        }
        spoolDb.pragma("journal_mode = MEMORY");
        spoolDb.pragma("synchronous = OFF");
        spoolDb.exec(`
            CREATE TABLE spool_messages (
                source_ordinal INTEGER PRIMARY KEY,
                raw_id TEXT NOT NULL,
                ts_ms INTEGER NOT NULL,
                time_unknown INTEGER NOT NULL,
                sender_uin TEXT,
                sender_uid TEXT,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX idx_spool_order ON spool_messages(ts_ms ASC, source_ordinal ASC);
            CREATE INDEX idx_spool_raw_id ON spool_messages(raw_id);
            CREATE TABLE spool_uids (
                uid TEXT PRIMARY KEY
            ) WITHOUT ROWID;
            CREATE TABLE spool_uid_uin (
                uid TEXT NOT NULL,
                uin TEXT NOT NULL,
                PRIMARY KEY (uid, uin)
            ) WITHOUT ROWID;
        `);

        const insertStmt = spoolDb.prepare(`
            INSERT INTO spool_messages (source_ordinal, raw_id, ts_ms, time_unknown, sender_uin, sender_uid, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertUidStmt = spoolDb.prepare(`
            INSERT OR IGNORE INTO spool_uids (uid) VALUES (?)
        `);
        const insertUidUinStmt = spoolDb.prepare(`
            INSERT OR IGNORE INTO spool_uid_uin (uid, uin) VALUES (?, ?)
        `);
        const selectByRawIdStmt = spoolDb.prepare(`
            SELECT ts_ms, sender_uin, sender_uid
            FROM spool_messages
            WHERE raw_id = ?
            LIMIT 1
        `);
        const hasCursorStmt = spoolDb.prepare(`
            SELECT 1 FROM spool_messages WHERE ts_ms = ? AND source_ordinal = ? LIMIT 1
        `);

        let totalRawMessages = 0;
        let validIdMessages = 0;
        let skippedInvalidId = 0;
        let intraExportDuplicates = 0;
        let intraExportConflicts = 0;
        let malformedLineCount = 0;
        const malformedLines: QceMalformedLineWarning[] = [];

        const pendingBatch: Array<[number, string, number, number, string | null, string | null, string]> = [];
        let pendingBatchBytes = 0;
        const pendingRawIds = new Map<string, { uin: string | null; uid: string | null; tsMs: number }>();
        const pendingUids = new Set<string>();
        const pendingUidUins: Array<[string, string]> = [];

        const recordUidPair = (uidRaw: unknown, uinRaw: unknown) => {
            const uid = typeof uidRaw === "string" ? uidRaw.trim() : "";
            if (!uid || uid === "all") return;
            pendingUids.add(uid);
            const uin = parsePositiveDecimalUin(uinRaw);
            if (uin) {
                pendingUidUins.push([uid, uin]);
            }
        };

        const flushPendingBatch = spoolDb.transaction((
            rows: typeof pendingBatch,
            uids: string[],
            uidUinPairs: Array<[string, string]>,
        ) => {
            for (const row of rows) {
                insertStmt.run(...row);
            }
            for (const uid of uids) {
                insertUidStmt.run(uid);
            }
            for (const [uid, uin] of uidUinPairs) {
                insertUidUinStmt.run(uid, uin);
            }
        });

        const flushIfReady = (force: boolean) => {
            if (pendingBatch.length === 0 && pendingUids.size === 0 && pendingUidUins.length === 0) return;
            if (!force && pendingBatch.length < SPOOL_FLUSH_BATCH_ROWS && pendingBatchBytes < SPOOL_FLUSH_BATCH_BYTES) {
                return;
            }
            flushPendingBatch(pendingBatch, [...pendingUids], pendingUidUins);
            pendingBatch.length = 0;
            pendingBatchBytes = 0;
            pendingRawIds.clear();
            pendingUids.clear();
            pendingUidUins.length = 0;
        };

        const handleRawMessage = (raw: QceRawMessage) => {
            totalRawMessages++;
            const ordinal = totalRawMessages;
            const projected = projectAndSanitizeRawMessage(raw);

            const rawId = normalizeMessageId(projected.id ?? projected.messageId);
            if (!rawId) {
                skippedInvalidId++;
                return;
            }

            const tsInfo = normalizeQceTimestamp(projected.timestamp, projected.timeStr, timezone, projected.time);
            const senderUin = parsePositiveDecimalUin(projected.sender?.uin) ?? null;
            const senderUid = typeof projected.sender?.uid === "string" && projected.sender.uid.trim()
                ? projected.sender.uid.trim()
                : null;

            const prevPending = pendingRawIds.get(rawId);
            const prevDb = prevPending
                ? undefined
                : (selectByRawIdStmt.get(rawId) as { ts_ms: number; sender_uin: string | null; sender_uid: string | null } | undefined);
            const prev = prevPending ?? (prevDb ? { uin: prevDb.sender_uin, uid: prevDb.sender_uid, tsMs: prevDb.ts_ms } : undefined);

            if (prev) {
                const sameTime = Math.abs(prev.tsMs - tsInfo.ms) <= 1000;
                const sameIdentity = (prev.uin && senderUin && prev.uin === senderUin)
                    || (!prev.uin && !senderUin && prev.uid === senderUid)
                    || (prev.uid && senderUid && prev.uid === senderUid);
                if (sameTime && sameIdentity) {
                    intraExportDuplicates++;
                } else {
                    intraExportConflicts++;
                }
                return;
            }

            // Observe UID -> UIN ONLY from kept eligible non-system / non-skipped-recalled rows
            const isSystemMsg = isQceSystemMessage(projected);
            const isSkippedRecalled = projected.recalled === true && !options.includeRecalled;
            const isSkippedSystem = isSystemMsg && !options.includeSystem;
            if (!isSystemMsg && !isSkippedRecalled && !isSkippedSystem) {
                collectUidUinObservations(projected, recordUidPair);
            }

            validIdMessages++;
            const payloadJson = JSON.stringify(projected);
            pendingRawIds.set(rawId, { uin: senderUin, uid: senderUid, tsMs: tsInfo.ms });
            pendingBatch.push([
                ordinal,
                rawId,
                tsInfo.ms,
                tsInfo.timeUnknown ? 1 : 0,
                senderUin,
                senderUid,
                payloadJson,
            ]);
            pendingBatchBytes += Buffer.byteLength(payloadJson, "utf8") + Buffer.byteLength(rawId, "utf8") + 64;
            flushIfReady(false);
        };

        const streamed = detected.format === "json"
            ? await streamSingleJsonIntoSpool(detected.jsonPath!, handleRawMessage, options.signal)
            : await streamChunkedJsonlIntoSpool(
                detected.exportRoot!,
                detected.manifestRelSegments!,
                detected.manifestPath!,
                handleRawMessage,
                malformedLines,
                () => { malformedLineCount++; },
                options.signal,
            );

        collectChatInfoObservations(streamed.chatInfo, recordUidPair);
        flushIfReady(true);

        const { uidToUin, stats: uidResolution } = resolveUidToUinMapFromSpool(spoolDb, userMap);

        const activeDb = spoolDb;
        const hasCursor = (tsMs: number, sourceOrdinal: number): boolean => {
            return Boolean(hasCursorStmt.get(tsMs, sourceOrdinal));
        };

        const iterateMessages = function* (afterCursor?: { tsMs: number; sourceOrdinal: number }) {
            const stmt = afterCursor
                ? activeDb.prepare(`
                    SELECT source_ordinal, raw_id, ts_ms, time_unknown, payload_json
                    FROM spool_messages
                    WHERE ts_ms > ? OR (ts_ms = ? AND source_ordinal > ?)
                    ORDER BY ts_ms ASC, source_ordinal ASC
                `)
                : activeDb.prepare(`
                    SELECT source_ordinal, raw_id, ts_ms, time_unknown, payload_json
                    FROM spool_messages
                    ORDER BY ts_ms ASC, source_ordinal ASC
                `);
            const iter = afterCursor
                ? stmt.iterate(afterCursor.tsMs, afterCursor.tsMs, afterCursor.sourceOrdinal)
                : stmt.iterate();
            for (const row of iter as Iterable<{
                source_ordinal: number;
                raw_id: string;
                ts_ms: number;
                time_unknown: number;
                payload_json: string;
            }>) {
                yield {
                    sourceOrdinal: row.source_ordinal,
                    rawId: row.raw_id,
                    tsMs: row.ts_ms,
                    timeUnknown: row.time_unknown === 1,
                    raw: JSON.parse(row.payload_json) as QceRawMessage,
                };
            }
        };

        return {
            format: detected.format,
            inputPath,
            inputKey: streamed.inputKey,
            metadata: streamed.metadata,
            chatInfo: streamed.chatInfo,
            uidToUin,
            userMapHash,
            uidResolution,
            totalRawMessages,
            validIdMessages,
            skippedInvalidId,
            intraExportDuplicates,
            intraExportConflicts,
            malformedLineCount,
            malformedLines,
            hasCursor,
            iterateMessages,
            cleanup,
        };
    } catch (err) {
        cleanup();
        throw err;
    }
}
