import path from "node:path";
import type { MessageMention } from "../core/message-provenance.js";
import { cleanDisplayName, type ChatNameObservation } from "../memory-v2/chat-names.js";
import { computeStatsHour, type IngestMessage } from "../memory-v2/history-store.js";
import { HistoryUsageError } from "./errors.js";
import { assertValidIanaTimezone, parseTimeStrInZone } from "./time-utils.js";

export { assertValidIanaTimezone };

export interface QceRawExportMeta {
    name?: string;
    version?: string;
    exportTime?: string | number;
    exportedAt?: string | number;
    format?: string;
    [key: string]: unknown;
}

export interface QceRawChatInfo {
    name?: string;
    title?: string;
    type?: string;
    uid?: string;
    uin?: string | number;
    peerUid?: string;
    peerUin?: string | number;
    selfUid?: string;
    selfUin?: string | number;
    memberCount?: number;
    [key: string]: unknown;
}

export interface QceRawSender {
    uid?: string;
    uin?: string | number;
    name?: string;
    nickname?: string;
    nick?: string;
    groupCard?: string;
    card?: string;
    remark?: string;
    title?: string;
    role?: string;
    [key: string]: unknown;
}

export interface QceRawResource {
    type?: string;
    fileName?: string;
    filename?: string;
    name?: string;
    fileSize?: number;
    size?: number;
    width?: number;
    height?: number;
    duration?: number;
    md5?: string;
    url?: string;
    localPath?: string;
    path?: string;
    [key: string]: unknown;
}

export interface QceRawMention {
    uid?: string;
    uin?: string | number;
    name?: string;
    nickname?: string;
    nick?: string;
    groupCard?: string;
    card?: string;
    displayName?: string;
    type?: string;
    atType?: number;
    isAll?: boolean;
    [key: string]: unknown;
}

export interface QceRawForwardMessage {
    sender?: QceRawSender;
    senderName?: string;
    timestamp?: number | string;
    timeStr?: string;
    content?: {
        text?: string;
        elements?: QceRawElement[];
        [key: string]: unknown;
    };
    text?: string;
    elements?: QceRawElement[];
    [key: string]: unknown;
}

export interface QceRawElement {
    type?: string;
    text?: string;
    content?: string;
    data?: Record<string, unknown>;
    uid?: string;
    uin?: string | number;
    name?: string;
    nickname?: string;
    groupCard?: string;
    card?: string;
    displayName?: string;
    atType?: number;
    referencedMessageId?: string | number;
    messageId?: string | number;
    id?: string | number;
    messages?: QceRawForwardMessage[];
    resource?: QceRawResource;
    title?: string;
    summary?: string;
    url?: string;
    locationName?: string;
    address?: string;
    faceName?: string;
    faceId?: number | string;
    [key: string]: unknown;
}

export interface QceRawMessage {
    id?: string | number;
    messageId?: string | number;
    seq?: string | number;
    timestamp?: number | string;
    time?: number | string;
    timeStr?: string;
    sender?: QceRawSender;
    content?: {
        text?: string;
        elements?: QceRawElement[];
        mentions?: QceRawMention[];
        resources?: QceRawResource[];
        [key: string]: unknown;
    };
    type?: string | number;
    messageType?: string | number;
    recalled?: boolean;
    system?: boolean;
    isSystem?: boolean;
    [key: string]: unknown;
}

export interface QceMessageMeta {
    uid?: string;
    uin?: string;
    groupCard?: string;
    nickname?: string;
    name?: string;
    title?: string;
    seq?: string;
    messageType?: string;
    timeUnknown?: boolean;
    recalled?: boolean;
    system?: boolean;
    hasForward?: boolean;
    evidenceText?: string;
    [key: string]: unknown;
}

export type UidUinMap = ReadonlyMap<string, string>;

export interface QceNormalizeOptions {
    chatId: string;
    isDirectMessage: boolean;
    timezone: string;
    uidToUin: UidUinMap;
    selfUserId?: string;
    includeSystem?: boolean;
    includeRecalled?: boolean;
}

export type QceSkipReason = "invalid_message_id" | "recalled" | "system";

export type QceNormalizedResult =
    | { status: "ok"; message: QceNormalizedMessage }
    | { status: "skip"; reason: QceSkipReason };

export interface QceNormalizedMessage extends IngestMessage {
    timestampMs: number;
    timeUnknown: boolean;
    isSystem: boolean;
    isRecalled: boolean;
    qceMeta: QceMessageMeta;
}

export interface ResolvedOneBotUser {
    userId: string;
    rawUserId: string;
    resolvedBy: "uin" | "uid_map" | "opaque_uid";
}

export interface QceChatTarget {
    chatId: string;
    chatKind: "group" | "private";
    isDirectMessage: boolean;
    chatTitle: string;
    isOpaquePeerChat: boolean;
}

const MAX_META_STRING_LEN = 200;
const MAX_FORWARD_DEPTH = 3;
const MAX_FORWARD_ITEMS_PER_LEVEL = 5;
const MAX_FORWARD_SUMMARY_CHARS = 480;
const MAX_MEDIA_ITEMS = 10;

export function cleanOptionalText(value: unknown, maxLen = MAX_META_STRING_LEN): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

export function parsePositiveDecimalUin(value: unknown): string | undefined {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return /^[1-9]\d*$/.test(trimmed) ? trimmed : undefined;
    }
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
    }
    return undefined;
}

export function normalizeMessageId(value: unknown): string | undefined {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed || trimmed === "0") return undefined;
        return trimmed;
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value <= 0) return undefined;
        return String(value);
    }
    return undefined;
}

export function isQceSystemMessage(raw: QceRawMessage): boolean {
    if (raw.recalled === true) return false;
    if (raw.system === true || raw.isSystem === true) return true;
    if (typeof raw.type === "string" && raw.type.trim().toLowerCase() === "system") return true;
    if (typeof raw.messageType === "string" && raw.messageType.trim().toLowerCase() === "system") return true;
    const elements = Array.isArray(raw.content?.elements) ? raw.content.elements : [];
    return elements.length > 0 && elements.every(el => typeof el?.type === "string" && el.type.trim().toLowerCase() === "system");
}

export function resolveOneBotUserId(
    uin: unknown,
    uid: unknown,
    uidToUin: UidUinMap,
): ResolvedOneBotUser | undefined {
    const cleanUid = typeof uid === "string" ? uid.trim() : "";
    const validUin = parsePositiveDecimalUin(uin);

    // Authoritative adjudicated UID -> UIN mapping takes precedence so a resolved conflict
    // never leaves the same UID split across two different userIds.
    if (cleanUid) {
        const mappedUin = parsePositiveDecimalUin(uidToUin.get(cleanUid));
        if (mappedUin) {
            return {
                userId: `onebot:${mappedUin}`,
                rawUserId: mappedUin,
                resolvedBy: validUin === mappedUin ? "uin" : "uid_map",
            };
        }
    }

    if (validUin) {
        return {
            userId: `onebot:${validUin}`,
            rawUserId: validUin,
            resolvedBy: "uin",
        };
    }

    if (!cleanUid) return undefined;

    return {
        userId: `onebot:uid:${encodeURIComponent(cleanUid)}`,
        rawUserId: cleanUid,
        resolvedBy: "opaque_uid",
    };
}

export function normalizeSelfIdOption(
    selfId: string | undefined,
    uidToUin?: UidUinMap,
): string | undefined {
    if (!selfId) return undefined;
    const trimmed = selfId.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("onebot:uid:")) {
        const rawUid = trimmed.slice("onebot:uid:".length);
        let decoded = rawUid;
        try {
            decoded = decodeURIComponent(rawUid);
        } catch {
            // keep rawUid
        }
        const mapped = parsePositiveDecimalUin(uidToUin?.get(decoded) ?? uidToUin?.get(rawUid));
        return mapped ? `onebot:${mapped}` : trimmed;
    }
    if (trimmed.startsWith("onebot:")) {
        return trimmed;
    }
    const uin = parsePositiveDecimalUin(trimmed);
    if (uin) return `onebot:${uin}`;
    const mapped = parsePositiveDecimalUin(uidToUin?.get(trimmed));
    if (mapped) return `onebot:${mapped}`;
    return `onebot:uid:${encodeURIComponent(trimmed)}`;
}

export function resolveQceChatTarget(
    chatInfo: QceRawChatInfo | undefined,
    uidToUin: UidUinMap,
    chatIdOverride?: string,
): QceChatTarget {
    const rawType = typeof chatInfo?.type === "string" ? chatInfo.type.trim().toLowerCase() : "";
    let chatKind: "group" | "private" | undefined;
    if (rawType === "group") {
        chatKind = "group";
    } else if (rawType === "private" || rawType === "temp") {
        chatKind = "private";
    }

    const chatTitle = cleanDisplayName(chatInfo?.name) ?? cleanDisplayName(chatInfo?.title) ?? "";

    if (chatIdOverride !== undefined) {
        const override = chatIdOverride.trim();
        const isGroupOverride = override.startsWith("onebot:group:");
        const isPrivateOverride = override.startsWith("onebot:private:");
        if (!isGroupOverride && !isPrivateOverride) {
            throw new HistoryUsageError(
                `Invalid --chat-id "${override}": must start with "onebot:group:" or "onebot:private:"`,
            );
        }
        const peerPart = override.slice(isGroupOverride ? "onebot:group:".length : "onebot:private:".length).trim();
        if (!peerPart) {
            throw new HistoryUsageError(`Invalid --chat-id "${override}": missing peer identifier`);
        }
        const overrideKind: "group" | "private" = isGroupOverride ? "group" : "private";
        if (chatKind && chatKind !== overrideKind) {
            throw new HistoryUsageError(
                `--chat-id "${override}" (${overrideKind}) does not match QCE chatInfo.type "${rawType}" (${chatKind})`,
            );
        }
        return {
            chatId: override,
            chatKind: overrideKind,
            isDirectMessage: overrideKind === "private",
            chatTitle,
            isOpaquePeerChat: !parsePositiveDecimalUin(peerPart),
        };
    }

    if (!chatKind) {
        throw new HistoryUsageError(
            `Cannot determine QCE chat kind from chatInfo.type "${chatInfo?.type ?? ""}"; expected "group", "private", or "temp" (or pass --chat-id).`,
        );
    }

    // Prefer upstream QCE v6.4.3 peerUin / peerUid first, falling back to legacy uin / uid aliases.
    const peerUin = parsePositiveDecimalUin(chatInfo?.peerUin) ?? parsePositiveDecimalUin(chatInfo?.uin);
    const rawPeerUid = typeof chatInfo?.peerUid === "string" && chatInfo.peerUid.trim()
        ? chatInfo.peerUid.trim()
        : undefined;
    const rawLegacyUid = typeof chatInfo?.uid === "string" && chatInfo.uid.trim()
        ? chatInfo.uid.trim()
        : undefined;
    const peerUid = rawPeerUid ?? rawLegacyUid;

    // QCE v6.4.3 group exports supply the group number in chatInfo.peerUid when peerUin is omitted.
    const decimalGroupUid = chatKind === "group" ? parsePositiveDecimalUin(peerUid) : undefined;
    const mappedPeerUin = peerUid ? parsePositiveDecimalUin(uidToUin.get(peerUid)) : undefined;
    const chosenPeer = peerUin ?? decimalGroupUid ?? mappedPeerUin ?? (peerUid ? encodeURIComponent(peerUid) : undefined);
    if (!chosenPeer) {
        throw new HistoryUsageError(
            "Cannot determine peer ID from QCE chatInfo (missing peerUin/uin and peerUid/uid); pass --chat-id explicitly.",
        );
    }

    const chatId = chatKind === "group" ? `onebot:group:${chosenPeer}` : `onebot:private:${chosenPeer}`;
    return {
        chatId,
        chatKind,
        isDirectMessage: chatKind === "private",
        chatTitle,
        isOpaquePeerChat: !(peerUin ?? decimalGroupUid ?? mappedPeerUin),
    };
}

export function normalizeQceTimestamp(
    timestamp: unknown,
    timeStr: unknown,
    timezone: string,
    fallbackTime?: unknown,
): { iso: string; ms: number; timeUnknown: boolean } {
    const tz = assertValidIanaTimezone(timezone);

    const tryNumeric = (num: number): number | null => {
        if (!Number.isFinite(num) || num <= 0) return null;
        if (num >= 1_000_000_000 && num < 10_000_000_000) {
            return Math.trunc(num * 1000);
        }
        if (num >= 10_000_000_000 && num <= 8_640_000_000_000_000) {
            return Math.trunc(num);
        }
        // Small positive numbers (e.g. 1..999_999_999) are invalid/ambiguous epoch timestamps; let time/timeStr resolve if present.
        return null;
    };

    const tryCandidate = (val: unknown): number | null => {
        let parsed: number | null = null;
        if (typeof val === "number") {
            parsed = tryNumeric(val);
        } else if (typeof val === "string") {
            const trimmed = val.trim();
            if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
                parsed = tryNumeric(Number(trimmed));
            } else if (trimmed) {
                parsed = parseTimeStrInZone(trimmed, tz);
            }
        }
        return parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };

    const ms = tryCandidate(timestamp) ?? tryCandidate(fallbackTime) ?? tryCandidate(timeStr);

    if (ms === null || !Number.isFinite(ms) || ms <= 0) {
        return {
            iso: "1970-01-01T00:00:00.000Z",
            ms: 0,
            timeUnknown: true,
        };
    }

    return {
        iso: new Date(ms).toISOString(),
        ms,
        timeUnknown: false,
    };
}

type CanonicalMediaType = "photo" | "sticker" | "video" | "audio" | "document";

interface SafeMediaItem {
    type: CanonicalMediaType;
    fileName?: string;
    fileSize?: number;
    width?: number;
    height?: number;
    duration?: number;
    title?: string;
}

function safeBasename(rawName: unknown): string | undefined {
    if (typeof rawName !== "string") return undefined;
    const trimmed = rawName.trim();
    if (!trimmed) return undefined;
    const base = path.posix.basename(trimmed.replace(/\\/g, "/"));
    return base && base !== "." && base !== ".." ? base.slice(0, 180) : undefined;
}

/**
 * Strip userinfo/credentials, query strings, and fragments from card URLs.
 * Only `origin + pathname` is retained.
 */
function safeHttpUrl(rawUrl: unknown): string | undefined {
    if (typeof rawUrl !== "string") return undefined;
    const trimmed = rawUrl.trim();
    if (!/^https?:\/\//i.test(trimmed)) return undefined;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return undefined;
        }
        return `${parsed.origin}${parsed.pathname}`.slice(0, 500);
    } catch {
        return undefined;
    }
}

function mapMediaKind(rawType: unknown): CanonicalMediaType | undefined {
    if (typeof rawType !== "string") return undefined;
    const t = rawType.trim().toLowerCase();
    if (t === "image" || t === "pic" || t === "photo") return "photo";
    if (t === "sticker" || t === "market_face" || t === "mface" || t === "emoji") return "sticker";
    if (t === "video" || t === "short_video") return "video";
    if (t === "audio" || t === "voice" || t === "ptt" || t === "record") return "audio";
    if (t === "file" || t === "document") return "document";
    return undefined;
}

/**
 * QCE exports stickers as `image` elements tagged `data.subType: "sticker"`
 * (numeric 1 in older exports), so the element type alone is not enough.
 */
function resolveElementMediaKind(elem: QceRawElement, t: string): CanonicalMediaType | undefined {
    const kind = mapMediaKind(t);
    if (kind !== "photo") return kind;
    const data = elem.data && typeof elem.data === "object" ? (elem.data as Record<string, unknown>) : undefined;
    const sub = data?.subType ?? (elem as Record<string, unknown>).subType;
    return sub === "sticker" || sub === 1 || sub === "1" ? "sticker" : "photo";
}

function elementFileName(elem: QceRawElement): string | undefined {
    const data = elem.data && typeof elem.data === "object" ? (elem.data as Record<string, unknown>) : undefined;
    return safeBasename(
        elem.resource?.fileName ?? elem.resource?.name
        ?? data?.fileName ?? data?.filename ?? data?.name,
    );
}

/** QCE face names are already bracketed (`[流泪]`) or slash-prefixed (`/骰子`). */
function renderFaceLabel(elem: QceRawElement): string {
    const data = elem.data && typeof elem.data === "object" ? (elem.data as Record<string, unknown>) : undefined;
    const faceName = extractStringField(elem as Record<string, unknown>, ["faceName", "name", "text"])
        ?? extractStringField(data, ["faceName", "name", "text"]);
    if (!faceName) return "[表情]";
    return /^\[.+\]$/.test(faceName) || faceName.startsWith("/") ? faceName.slice(0, 40) : `[表情:${faceName.slice(0, 40)}]`;
}

const RECONSTRUCTABLE_ELEMENT_TYPES = new Set([
    "text", "at", "face", "market_face", "mface", "emoji", "sticker",
    "image", "pic", "photo", "video", "short_video",
    "audio", "voice", "ptt", "record", "file", "document",
    "json", "ark", "location", "forward", "multimsg", "reply",
    "system", "wallet", "red_packet", "live_gift",
]);

function isReconstructableElement(elem: QceRawElement | undefined | null): boolean {
    if (!elem || typeof elem !== "object" || typeof elem.type !== "string") return false;
    return RECONSTRUCTABLE_ELEMENT_TYPES.has(elem.type.trim().toLowerCase());
}

function sanitizeResourceItem(rawType: CanonicalMediaType, res: QceRawResource | Record<string, unknown> | undefined): SafeMediaItem {
    const r = (res ?? {}) as QceRawResource;
    const fileName = safeBasename(r.fileName ?? r.filename ?? r.name);
    const fileSize = typeof r.fileSize === "number" && Number.isFinite(r.fileSize) && r.fileSize >= 0
        ? Math.trunc(r.fileSize)
        : (typeof r.size === "number" && Number.isFinite(r.size) && r.size >= 0 ? Math.trunc(r.size) : undefined);
    const width = typeof r.width === "number" && Number.isFinite(r.width) && r.width > 0 ? Math.trunc(r.width) : undefined;
    const height = typeof r.height === "number" && Number.isFinite(r.height) && r.height > 0 ? Math.trunc(r.height) : undefined;
    const duration = typeof r.duration === "number" && Number.isFinite(r.duration) && r.duration >= 0 ? r.duration : undefined;
    return {
        type: rawType,
        ...(fileName ? { fileName } : {}),
        ...(fileSize !== undefined ? { fileSize } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(duration !== undefined ? { duration } : {}),
    };
}

function extractStringField(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!obj) return undefined;
    for (const key of keys) {
        const val = obj[key];
        if (typeof val === "string" && val.trim()) return val.trim();
    }
    return undefined;
}

function isForwardElement(elem: QceRawElement | undefined | null): boolean {
    if (!elem || typeof elem !== "object") return false;
    const t = typeof elem.type === "string" ? elem.type.trim().toLowerCase() : "";
    return t === "forward" || t === "multimsg";
}

/**
 * Speakers inside forwarded records get a stable anonymous label per forward.
 * QCE names them from the exporter's own view, so a friend's private remark
 * (often a real name) is indistinguishable from a public nickname here.
 */
function forwardSpeakerLabel(nested: QceRawForwardMessage, speakers: Map<string, string>): string {
    const senderObj = nested.sender;
    // QCE stamps one placeholder uin/uid on every speaker it cannot resolve, so the
    // account ID alone does not tell speakers apart; the name is only used as a key.
    const account = cleanOptionalText(senderObj?.uin !== undefined ? String(senderObj.uin) : undefined)
        ?? cleanOptionalText(senderObj?.uid)
        ?? "";
    const key = `${account}\0${cleanDisplayName(senderObj?.name ?? nested.senderName) ?? ""}`;
    const known = speakers.get(key);
    if (known) return known;
    const index = speakers.size;
    const label = `成员${index < 26 ? String.fromCharCode(65 + index) : index + 1}`;
    speakers.set(key, label);
    return label;
}

function renderForwardSummary(
    rawMessages: QceRawForwardMessage[],
    depth: number,
    speakers: Map<string, string> = new Map(),
): string {
    if (depth > MAX_FORWARD_DEPTH || rawMessages.length === 0) return "";
    const snippets: string[] = [];
    let totalChars = 0;

    for (const nested of rawMessages.slice(0, MAX_FORWARD_ITEMS_PER_LEVEL)) {
        if (!nested || typeof nested !== "object") continue;
        const senderLabel = forwardSpeakerLabel(nested, speakers);
        const nestedElements = Array.isArray(nested.content?.elements)
            ? nested.content.elements
            : (Array.isArray(nested.elements) ? nested.elements : []);
        const nestedHasForward = nestedElements.some(isForwardElement);
        // Prefer structured elements: QCE's flattened text embeds file hashes and,
        // for nested forwards, unbounded forwarded bodies.
        let body = nestedElements.length > 0 ? renderNestedElementsText(nestedElements, depth + 1, speakers) : "";
        if (!body && !nestedHasForward) {
            body = typeof nested.content?.text === "string"
                ? nested.content.text.trim()
                : (typeof nested.text === "string" ? nested.text.trim() : "");
        }
        if (!body) body = "[消息]";
        const line = `${senderLabel}: ${body.replace(/\s+/g, " ").slice(0, 120)}`;
        if (totalChars + line.length > MAX_FORWARD_SUMMARY_CHARS) break;
        snippets.push(line);
        totalChars += line.length;
    }

    const header = `[转发聊天记录: ${rawMessages.length}条]`;
    return snippets.length > 0 ? `${header} (${snippets.join(" | ")})` : header;
}

function renderNestedElementsText(elements: QceRawElement[], depth: number, forwardSpeakers?: Map<string, string>): string {
    const parts: string[] = [];
    for (const elem of elements) {
        if (!elem || typeof elem !== "object") continue;
        const t = typeof elem.type === "string" ? elem.type.trim().toLowerCase() : "";
        const data = elem.data && typeof elem.data === "object" ? elem.data : undefined;
        if (t === "text") {
            const txt = elem.text ?? elem.content ?? (typeof data?.text === "string" ? data.text : "");
            if (txt) parts.push(txt);
        } else if (t === "at") {
            const label = forwardSpeakers
                ? undefined
                : cleanDisplayName(elem.displayName ?? elem.groupCard ?? elem.card ?? elem.nickname ?? elem.name ?? (typeof data?.name === "string" ? data.name : undefined));
            parts.push(label ? `@${label}` : "@成员");
        } else if (t === "forward" || t === "multimsg") {
            const nestedMsgs = Array.isArray(elem.messages)
                ? elem.messages
                : (Array.isArray(data?.messages) ? (data.messages as QceRawForwardMessage[]) : []);
            if (depth <= MAX_FORWARD_DEPTH) {
                parts.push(renderForwardSummary(nestedMsgs, depth, forwardSpeakers));
            } else {
                parts.push(`[转发聊天记录: ${nestedMsgs.length}条]`);
            }
        } else {
            const mediaKind = resolveElementMediaKind(elem, t);
            if (mediaKind === "photo") parts.push("[📷 图片]");
            else if (mediaKind === "sticker") parts.push("[🎭 表情包]");
            else if (mediaKind === "video") parts.push("[🎬 视频]");
            else if (mediaKind === "audio") parts.push("[🎵 语音]");
            else if (mediaKind === "document") {
                const name = elementFileName(elem);
                parts.push(name ? `[📎 文件: ${name}]` : "[📎 文件]");
            } else if (t === "json" || t === "ark") {
                const title = extractStringField(elem as Record<string, unknown>, ["title", "summary"]) ?? extractStringField(data, ["title", "summary"]);
                parts.push(title ? `[🔗 卡片: ${title.slice(0, 80)}]` : "[🔗 卡片]");
            } else if (t === "location") {
                const loc = extractStringField(elem as Record<string, unknown>, ["locationName", "address", "name"]) ?? extractStringField(data, ["locationName", "address", "name"]);
                parts.push(loc ? `[📍 位置: ${loc.slice(0, 80)}]` : "[📍 位置]");
            } else if (t === "face") {
                parts.push(renderFaceLabel(elem));
            } else {
                const fallbackText = typeof elem.text === "string" ? elem.text : (typeof elem.summary === "string" ? elem.summary : "");
                if (fallbackText) parts.push(fallbackText);
            }
        }
    }
    return parts.join("").trim();
}

function appendMissingPlaceholder(baseText: string, placeholder: string): string {
    if (!placeholder) return baseText;
    if (baseText.includes(placeholder)) return baseText;
    return baseText ? `${baseText} ${placeholder}` : placeholder;
}

function stripForwardMarkersInline(text: string): string {
    if (!text) return "";
    return text.replace(/\[转发(?:聊天记录|消息)[\s\S]*/g, "[转发聊天记录]");
}

export function normalizeQceMessage(
    raw: QceRawMessage,
    options: QceNormalizeOptions,
): QceNormalizedResult {
    const messageId = normalizeMessageId(raw.id ?? raw.messageId);
    if (!messageId) {
        return { status: "skip", reason: "invalid_message_id" };
    }

    const elements = Array.isArray(raw.content?.elements) ? raw.content.elements : [];
    const rawMentions = Array.isArray(raw.content?.mentions) ? raw.content.mentions : [];
    const rawResources = Array.isArray(raw.content?.resources) ? raw.content.resources : [];

    const isRecalled = raw.recalled === true;
    if (isRecalled && !options.includeRecalled) {
        return { status: "skip", reason: "recalled" };
    }

    const isSystem = isQceSystemMessage(raw);
    if (isSystem && !options.includeSystem) {
        return { status: "skip", reason: "system" };
    }

    const tsInfo = normalizeQceTimestamp(raw.timestamp, raw.timeStr, options.timezone, raw.time);

    const sender = raw.sender ?? {};
    const senderUin = parsePositiveDecimalUin(sender.uin);
    const senderUid = typeof sender.uid === "string" && sender.uid.trim() ? sender.uid.trim() : undefined;
    const senderCard = cleanDisplayName(sender.groupCard ?? sender.card);
    const senderNickname = cleanDisplayName(sender.nickname ?? sender.nick);
    const rawSenderName = cleanDisplayName(sender.name);
    // The exporter's private remark for this person (often a real name). It is only
    // compared against `name` below and is never stored: the agent's shell can read memory.db.
    const senderRemark = cleanOptionalText(sender.remark);
    const safeSenderName = rawSenderName && (!senderRemark || rawSenderName !== senderRemark)
        ? rawSenderName
        : undefined;
    const senderTitle = cleanOptionalText(sender.title);
    const seqStr = raw.seq !== undefined && raw.seq !== null ? cleanOptionalText(String(raw.seq), 64) : undefined;
    const rawMsgType = raw.messageType ?? raw.type;
    const messageTypeStr = rawMsgType !== undefined && rawMsgType !== null
        ? cleanOptionalText(String(rawMsgType), 64)
        : undefined;

    const hasForwardElement = elements.some(isForwardElement);
    const rawContentText = typeof raw.content?.text === "string" ? raw.content.text.trim() : "";
    const hasForwardMarkerInElementText = elements.some((elem) => {
        if (!elem || typeof elem !== "object") return false;
        const data = elem.data && typeof elem.data === "object" ? elem.data : undefined;
        const candidate = [
            elem.text,
            elem.content,
            elem.summary,
            data?.text,
        ].find((v): v is string => typeof v === "string" && (v.includes("[转发聊天记录") || v.includes("[转发消息")));
        return Boolean(candidate);
    });
    const hasForwardMarkerInText = rawContentText.includes("[转发聊天记录")
        || rawContentText.includes("[转发消息")
        || hasForwardMarkerInElementText;
    const hasForward = hasForwardElement || hasForwardMarkerInText;

    const qceMeta: QceMessageMeta = {
        ...(senderUid ? { uid: senderUid.slice(0, MAX_META_STRING_LEN) } : {}),
        ...(senderUin ? { uin: senderUin } : {}),
        ...(senderCard ? { groupCard: senderCard.slice(0, MAX_META_STRING_LEN) } : {}),
        ...(senderNickname ? { nickname: senderNickname.slice(0, MAX_META_STRING_LEN) } : {}),
        ...(safeSenderName ? { name: safeSenderName.slice(0, MAX_META_STRING_LEN) } : {}),
        ...(senderTitle ? { title: senderTitle } : {}),
        ...(seqStr ? { seq: seqStr } : {}),
        ...(messageTypeStr ? { messageType: messageTypeStr } : {}),
        ...(tsInfo.timeUnknown ? { timeUnknown: true } : {}),
        ...(isRecalled ? { recalled: true } : {}),
        ...(isSystem ? { system: true } : {}),
        ...(hasForward ? { hasForward: true } : {}),
    };

    if (isRecalled) {
        const resolvedSender = resolveOneBotUserId(senderUin, senderUid, options.uidToUin);
        const userId = resolvedSender?.userId ?? "system";
        const displayName = senderCard || senderNickname || safeSenderName || resolvedSender?.rawUserId || "unknown";
        return {
            status: "ok",
            message: {
                messageId,
                chatId: options.chatId,
                userId,
                displayName,
                text: "[已撤回消息]",
                timestamp: tsInfo.iso,
                timestampMs: tsInfo.ms,
                timeUnknown: tsInfo.timeUnknown,
                mentions: [],
                origin: "qce",
                countAsHuman: false,
                statsHour: null,
                isSystem: false,
                isRecalled: true,
                qceMeta,
                chatNames: [],
            },
        };
    }

    if (isSystem) {
        const elementText = rawContentText || renderNestedElementsText(elements, 1);
        const prefixed = elementText
            ? (elementText.startsWith("[系统]") || elementText.startsWith("【系统】") ? elementText : `[系统] ${elementText}`)
            : "[系统]";
        return {
            status: "ok",
            message: {
                messageId,
                chatId: options.chatId,
                userId: "system",
                displayName: "系统",
                text: prefixed,
                timestamp: tsInfo.iso,
                timestampMs: tsInfo.ms,
                timeUnknown: tsInfo.timeUnknown,
                mentions: [],
                origin: "qce",
                countAsHuman: false,
                statsHour: null,
                isSystem: true,
                isRecalled: false,
                qceMeta,
                chatNames: [],
            },
        };
    }

    // Normal human (or configured bot self) message
    const resolvedSender = resolveOneBotUserId(senderUin, senderUid, options.uidToUin);
    const userId = resolvedSender?.userId ?? "unknown";
    const hasExplicitDisplayName = Boolean(senderCard || senderNickname || safeSenderName);
    const displayName = senderCard || senderNickname || safeSenderName || resolvedSender?.rawUserId || "unknown";

    // Combine top-level mentions + top-level `at` elements
    const mentionMap = new Map<string, MessageMention>();
    const addMentionCandidate = (cand: {
        isAll?: boolean;
        uin?: unknown;
        uid?: unknown;
        displayName?: string;
    }) => {
        if (cand.isAll) {
            if (!mentionMap.has("onebot:all")) {
                mentionMap.set("onebot:all", {
                    userId: "onebot:all",
                    isAll: true,
                    rawUserId: "all",
                    nameSource: "qce",
                    ...(cand.displayName ? { displayName: cand.displayName } : {}),
                });
            }
            return;
        }
        const resolved = resolveOneBotUserId(cand.uin, cand.uid, options.uidToUin);
        if (!resolved) return;
        const isSelf = options.selfUserId !== undefined && resolved.userId === options.selfUserId;
        const existing = mentionMap.get(resolved.userId);
        if (existing) {
            if (!existing.displayName && cand.displayName) existing.displayName = cand.displayName;
            if (isSelf) existing.isSelf = true;
        } else {
            mentionMap.set(resolved.userId, {
                userId: resolved.userId,
                ...(cand.displayName ? { displayName: cand.displayName } : {}),
                rawUserId: resolved.rawUserId,
                ...(isSelf ? { isSelf: true } : {}),
                nameSource: "qce",
            });
        }
    };

    for (const m of rawMentions) {
        if (!m || typeof m !== "object") continue;
        const isAll = m.isAll === true || m.type === "all" || m.uid === "all" || String(m.uin) === "all" || m.atType === 1;
        const mDisplay = cleanDisplayName(m.groupCard ?? m.card)
            ?? cleanDisplayName(m.nickname ?? m.nick)
            ?? cleanDisplayName(m.name)
            ?? cleanDisplayName(m.displayName);
        addMentionCandidate({ isAll, uin: m.uin, uid: m.uid, displayName: mDisplay });
    }

    for (const elem of elements) {
        if (!elem || typeof elem !== "object") continue;
        if (typeof elem.type !== "string" || elem.type.trim().toLowerCase() !== "at") continue;
        const data = elem.data && typeof elem.data === "object" ? elem.data : undefined;
        const uin = elem.uin ?? data?.uin ?? data?.qq;
        const uid = elem.uid ?? data?.uid;
        const isAll = elem.atType === 1
            || data?.atType === 1
            || data?.type === "all"
            || uid === "all"
            || String(uin) === "all";
        const elemDisplay = cleanDisplayName(elem.groupCard ?? elem.card)
            ?? cleanDisplayName(elem.nickname ?? (typeof data?.nickname === "string" ? data.nickname : undefined))
            ?? cleanDisplayName(elem.displayName ?? elem.name ?? (typeof data?.name === "string" ? data.name : undefined))
            ?? cleanDisplayName(typeof elem.text === "string" ? elem.text.replace(/^[@＠]/, "") : undefined);
        addMentionCandidate({ isAll, uin, uid, displayName: elemDisplay });
    }

    const mentions = [...mentionMap.values()];

    // Reply extraction (first valid top-level reply element, never self-loop)
    let replyToMessageId: string | undefined;
    for (const elem of elements) {
        if (!elem || typeof elem !== "object") continue;
        if (typeof elem.type !== "string" || elem.type.trim().toLowerCase() !== "reply") continue;
        const data = elem.data && typeof elem.data === "object" ? elem.data : undefined;
        const candId = normalizeMessageId(
            data?.referencedMessageId ?? data?.messageId ?? data?.id
            ?? elem.referencedMessageId ?? elem.messageId ?? elem.id,
        );
        if (candId && candId !== messageId) {
            replyToMessageId = candId;
            break;
        }
    }

    // Media, cards, locations, forwards extraction from top-level elements & resources
    const mediaItems: SafeMediaItem[] = [];
    const mediaCounts: Record<CanonicalMediaType, number> = {
        photo: 0,
        sticker: 0,
        video: 0,
        audio: 0,
        document: 0,
    };
    const requiredPlaceholders: string[] = [];
    const pushPlaceholder = (p: string) => {
        if (p && !requiredPlaceholders.includes(p)) {
            requiredPlaceholders.push(p);
        }
    };

    const recordMedia = (kind: CanonicalMediaType, resObj?: QceRawResource | Record<string, unknown>, title?: string) => {
        mediaCounts[kind]++;
        const sanitized = sanitizeResourceItem(kind, resObj);
        if (title && !sanitized.title) sanitized.title = title.slice(0, 120);
        if (mediaItems.length < MAX_MEDIA_ITEMS) {
            mediaItems.push(sanitized);
        }
        if (kind === "photo") pushPlaceholder("[📷 图片]");
        else if (kind === "sticker") pushPlaceholder("[🎭 表情包]");
        else if (kind === "video") pushPlaceholder("[🎬 视频]");
        else if (kind === "audio") pushPlaceholder("[🎵 语音]");
        else if (kind === "document") {
            pushPlaceholder(sanitized.fileName ? `[📎 文件: ${sanitized.fileName}]` : "[📎 文件]");
        }
    };

    let forwardSummaryText = "";
    const cardSummaries: Array<{ title?: string; url?: string }> = [];

    for (const elem of elements) {
        if (!elem || typeof elem !== "object") continue;
        const t = typeof elem.type === "string" ? elem.type.trim().toLowerCase() : "";
        const data = elem.data && typeof elem.data === "object" ? elem.data : undefined;
        const mediaKind = resolveElementMediaKind(elem, t);
        if (mediaKind) {
            const res = elem.resource ?? data;
            recordMedia(mediaKind, res);
            continue;
        }
        if (t === "json" || t === "ark") {
            const title = extractStringField(elem as Record<string, unknown>, ["title", "summary"])
                ?? extractStringField(data, ["title", "summary"]);
            const url = safeHttpUrl(elem.url ?? data?.url);
            cardSummaries.push({ ...(title ? { title: title.slice(0, 120) } : {}), ...(url ? { url } : {}) });
            pushPlaceholder(title ? `[🔗 卡片: ${title.slice(0, 80)}]` : "[🔗 卡片]");
        } else if (t === "location") {
            const loc = extractStringField(elem as Record<string, unknown>, ["locationName", "address", "name"])
                ?? extractStringField(data, ["locationName", "address", "name"]);
            pushPlaceholder(loc ? `[📍 位置: ${loc.slice(0, 80)}]` : "[📍 位置]");
        } else if (t === "forward" || t === "multimsg") {
            const nestedMsgs = Array.isArray(elem.messages)
                ? elem.messages
                : (Array.isArray(data?.messages) ? (data.messages as QceRawForwardMessage[]) : []);
            const summary = renderForwardSummary(nestedMsgs, 1);
            if (!forwardSummaryText && summary) {
                forwardSummaryText = summary;
            }
            pushPlaceholder(`[转发聊天记录: ${nestedMsgs.length}条]`);
        }
    }

    // Snapshot counts from elements BEFORE iterating resources so resource-only media
    // counts all items of that type (not just the first one).
    const elementMediaCounts: Record<CanonicalMediaType, number> = { ...mediaCounts };
    // Resources carry no sticker flag; an image resource is already covered when
    // its element was counted as either photo or sticker.
    const elementImageCount = elementMediaCounts.photo + elementMediaCounts.sticker;
    for (const res of rawResources) {
        if (!res || typeof res !== "object") continue;
        const mediaKind = mapMediaKind(res.type);
        if (!mediaKind) continue;
        const covered = mediaKind === "photo" ? elementImageCount > 0 : elementMediaCounts[mediaKind] > 0;
        if (!covered) {
            recordMedia(mediaKind, res);
        }
    }

    // Build text from top-level elements whenever every element type is understood:
    // QCE's pre-flattened content.text carries export-only markers (`[图片:<md5>.png]`,
    // `[回复消息]`, `[JSON消息]`) and, for forwards, bodies that bypass the depth-3 cap.
    // Simultaneously build clean body-free evidenceText when forward elements/markers exist.
    const hasReplyElement = elements.some((elem) => typeof elem?.type === "string" && elem.type.trim().toLowerCase() === "reply");
    const fallbackContentText = hasReplyElement ? rawContentText.replace(/^\[回复消息\]\s*/, "") : rawContentText;
    const canReconstruct = elements.length > 0 && elements.every(isReconstructableElement);
    let text = hasForwardElement || canReconstruct ? "" : fallbackContentText;
    let evidenceText: string | undefined;
    if (!text && elements.length > 0) {
        const reconstructedParts: string[] = [];
        const evidenceParts: string[] = [];
        const pushEvidencePiece = (piece: string) => {
            if (!piece) return;
            evidenceParts.push(
                piece.includes("[转发聊天记录") || piece.includes("[转发消息")
                    ? stripForwardMarkersInline(piece)
                    : piece,
            );
        };
        for (const elem of elements) {
            if (!elem || typeof elem !== "object") continue;
            const t = typeof elem.type === "string" ? elem.type.trim().toLowerCase() : "";
            const data = elem.data && typeof elem.data === "object" ? elem.data : undefined;
            if (t === "text") {
                const str = elem.text ?? elem.content ?? (typeof data?.text === "string" ? data.text : "");
                if (str) {
                    reconstructedParts.push(str);
                    pushEvidencePiece(str);
                }
            } else if (t === "at") {
                const uin = elem.uin ?? data?.uin ?? data?.qq;
                const uid = elem.uid ?? data?.uid;
                const isAll = elem.atType === 1 || data?.atType === 1 || data?.type === "all" || uid === "all" || String(uin) === "all";
                if (isAll) {
                    reconstructedParts.push("@全体成员");
                    evidenceParts.push("@全体成员");
                } else {
                    const resolved = resolveOneBotUserId(uin, uid, options.uidToUin);
                    const mentionDisplay = resolved ? mentionMap.get(resolved.userId)?.displayName : undefined;
                    const label = mentionDisplay
                        ?? cleanDisplayName(elem.displayName ?? elem.name ?? (typeof data?.name === "string" ? data.name : undefined))
                        ?? resolved?.rawUserId
                        ?? "成员";
                    const piece = `@${label}`;
                    reconstructedParts.push(piece);
                    evidenceParts.push(piece);
                }
            } else if (t === "face") {
                const piece = renderFaceLabel(elem);
                reconstructedParts.push(piece);
                evidenceParts.push(piece);
            } else if (t === "market_face") {
                reconstructedParts.push("[🎭 表情包]");
                evidenceParts.push("[🎭 表情包]");
            } else if (t === "json" || t === "ark") {
                const title = extractStringField(elem as Record<string, unknown>, ["title", "summary"])
                    ?? extractStringField(data, ["title", "summary"]);
                const piece = title ? `[🔗 卡片: ${title.slice(0, 80)}]` : "[🔗 卡片]";
                reconstructedParts.push(piece);
                pushEvidencePiece(piece);
            } else if (t === "location") {
                const loc = extractStringField(elem as Record<string, unknown>, ["locationName", "address", "name"])
                    ?? extractStringField(data, ["locationName", "address", "name"]);
                const piece = loc ? `[📍 位置: ${loc.slice(0, 80)}]` : "[📍 位置]";
                reconstructedParts.push(piece);
                pushEvidencePiece(piece);
            } else if (t === "forward" || t === "multimsg") {
                const nestedMsgs = Array.isArray(elem.messages)
                    ? elem.messages
                    : (Array.isArray(data?.messages) ? (data.messages as QceRawForwardMessage[]) : []);
                reconstructedParts.push(renderForwardSummary(nestedMsgs, 1));
                evidenceParts.push("[转发聊天记录]");
            } else if (t === "system") {
                const str = elem.text ?? elem.content ?? (typeof data?.text === "string" ? data.text : "");
                if (str) {
                    reconstructedParts.push(str);
                    pushEvidencePiece(str);
                }
            } else if (t === "wallet" || t === "red_packet") {
                const piece = typeof elem.text === "string" && elem.text.trim() ? elem.text.trim() : "[红包/转账]";
                reconstructedParts.push(piece);
                pushEvidencePiece(piece);
            } else if (t === "live_gift") {
                const piece = typeof elem.text === "string" && elem.text.trim() ? elem.text.trim() : "[礼物]";
                reconstructedParts.push(piece);
                pushEvidencePiece(piece);
            } else {
                const mk = resolveElementMediaKind(elem, t);
                if (mk === "photo") {
                    reconstructedParts.push("[📷 图片]");
                    evidenceParts.push("[📷 图片]");
                } else if (mk === "sticker") {
                    reconstructedParts.push("[🎭 表情包]");
                    evidenceParts.push("[🎭 表情包]");
                } else if (mk === "video") {
                    reconstructedParts.push("[🎬 视频]");
                    evidenceParts.push("[🎬 视频]");
                } else if (mk === "audio") {
                    reconstructedParts.push("[🎵 语音]");
                    evidenceParts.push("[🎵 语音]");
                } else if (mk === "document") {
                    const name = elementFileName(elem);
                    const piece = name ? `[📎 文件: ${name}]` : "[📎 文件]";
                    reconstructedParts.push(piece);
                    evidenceParts.push(piece);
                } else {
                    const unknownText = typeof elem.text === "string"
                        ? elem.text
                        : (typeof elem.summary === "string" ? elem.summary : "");
                    if (unknownText) {
                        reconstructedParts.push(unknownText);
                        pushEvidencePiece(unknownText);
                    }
                }
            }
        }
        text = reconstructedParts.join("").trim();
        if (hasForward) {
            evidenceText = evidenceParts.join("").trim();
        }
        if (!text && !hasForwardElement) {
            text = fallbackContentText;
        }
    }

    if (forwardSummaryText && !text.includes("[转发聊天记录:")) {
        text = appendMissingPlaceholder(text, forwardSummaryText);
    }
    if (hasForward && evidenceText === undefined) {
        evidenceText = stripForwardMarkersInline(text);
    }
    for (const placeholder of requiredPlaceholders) {
        if (placeholder.startsWith("[转发聊天记录:") && text.includes(placeholder)) continue;
        text = appendMissingPlaceholder(text, placeholder);
        if (evidenceText !== undefined && !placeholder.startsWith("[转发聊天记录") && !placeholder.startsWith("[转发消息")) {
            const safePlaceholder = (placeholder.includes("[转发聊天记录") || placeholder.includes("[转发消息"))
                ? stripForwardMarkersInline(placeholder)
                : placeholder;
            evidenceText = appendMissingPlaceholder(evidenceText, safePlaceholder);
        }
    }
    if (hasForward && evidenceText !== undefined) {
        qceMeta.evidenceText = evidenceText;
    }

    const primaryMediaType = mediaItems[0]?.type;
    let mediaInfo: string | undefined;
    if (mediaItems.length > 0 || cardSummaries.length > 0) {
        const compactCounts: Record<string, number> = {};
        for (const [k, v] of Object.entries(mediaCounts)) {
            if (v > 0) compactCounts[k] = v;
        }
        mediaInfo = JSON.stringify({
            source: "qce",
            counts: compactCounts,
            items: mediaItems,
            ...(cardSummaries.length > 0 ? { cards: cardSummaries.slice(0, 5) } : {}),
        });
    }

    const isBotSelfSender = options.selfUserId !== undefined && userId === options.selfUserId;
    const countAsHuman = !isBotSelfSender && resolvedSender !== undefined;
    const statsHour = countAsHuman && !tsInfo.timeUnknown
        ? computeStatsHour(tsInfo.iso, options.timezone)
        : null;

    // Chat name observations (only for eligible human non-recalled messages with real names, never raw IDs or remark)
    const chatNames: ChatNameObservation[] = [];
    if (countAsHuman && resolvedSender) {
        const seenNames = new Set<string>();
        const pushChatName = (uid: string, kind: ChatNameObservation["kind"], rawLabel: string | undefined) => {
            if (!rawLabel) return;
            const key = `${uid}\0${kind}\0${rawLabel.normalize("NFKC").toLowerCase()}`;
            if (seenNames.has(key)) return;
            seenNames.add(key);
            chatNames.push({
                chatId: options.chatId,
                messageId,
                userId: uid,
                kind,
                displayName: rawLabel,
                observedAt: tsInfo.iso,
            });
        };
        if (senderCard) pushChatName(userId, "sender_card", senderCard);
        if (senderNickname) pushChatName(userId, "sender_nickname", senderNickname);
        if (safeSenderName) pushChatName(userId, "sender_name", safeSenderName);
        if (hasExplicitDisplayName) {
            pushChatName(userId, "sender_display", displayName);
        }

        for (const mention of mentions) {
            if (mention.isAll) continue;
            if (mention.displayName) {
                pushChatName(mention.userId, "mention_display", mention.displayName);
            }
        }
    }

    const globalDmName = options.isDirectMessage && countAsHuman
        ? (senderNickname || safeSenderName)
        : undefined;

    return {
        status: "ok",
        message: {
            messageId,
            chatId: options.chatId,
            userId,
            displayName,
            text,
            ...(replyToMessageId ? { replyToMessageId } : {}),
            timestamp: tsInfo.iso,
            timestampMs: tsInfo.ms,
            timeUnknown: tsInfo.timeUnknown,
            ...(primaryMediaType ? { mediaType: primaryMediaType } : {}),
            ...(mediaInfo ? { mediaInfo } : {}),
            mentions,
            origin: "qce",
            countAsHuman,
            statsHour,
            isSystem: false,
            isRecalled: false,
            qceMeta,
            chatNames,
            ...(globalDmName ? { globalDisplayName: globalDmName } : {}),
        },
    };
}
