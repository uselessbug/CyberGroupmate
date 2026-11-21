import { createHash } from "node:crypto";
import fs from "node:fs";
import { getGroupModelKey, getRawId, parseChatId } from "../core/chat-id.js";
import {
    loadConfig,
    resolveComponentProfiles,
    resolveComponentTimeout,
    type AppConfig,
    type EmbeddingConfig,
    type LLMConfig,
} from "../core/config.js";
import { callLLMWithFallback, type ChatMessage } from "../core/llm.js";
import { parseRetryAfterHeaderMs } from "../core/llm/http-error.js";
import { createLogger } from "../core/logger.js";
import { loadPromptFile } from "../core/prompt-loader.js";
import { getGlobalTimezone } from "../core/timezone.js";
import { embed } from "../memory-v2/embedding.js";
import {
    NEWCOMER_AGENT_ROLE,
    computeEmbeddingContentHash,
    type HistorySynthesisCitation,
    type HistorySynthesisEpisodeInput,
    type HistorySynthesisFactProposal,
    type HistorySynthesisGroupPatch,
    type HistorySynthesisMemberPatch,
    type HistoryUnitInput,
} from "../memory-v2/history-store.js";
import type { MemoryStoreV2 } from "../memory-v2/memory-v2.js";
import type { TopicNode } from "../memory-v2/types.js";
import { HistoryUsageError } from "./errors.js";
import { dryRunQceImport, importQce, type QceImportOptions, type QceImportSummary } from "./qce-import.js";
import { openSqliteReadOnlyStrict } from "./sqlite-readonly.js";
import { assertValidIanaTimezone, parseStrictTimestampMs } from "./time-utils.js";
import {
    DEFAULT_MIN_WINDOW_MESSAGES,
    buildHistoryWindows,
    buildSynthesisMacroBatches,
    buildSynthesisTopicBlock,
    getHistoryMessageEvidenceText,
    isEligibleHistoryMessageRow,
    loadEligibleHistoryMessages,
    selectWindowsForMode,
    type HistoryMessageRow,
    type HistoryWindow,
    type SkippedPartialTopic,
    type SynthesisMacroBatch,
    type SynthesisTopicBlock,
} from "./windows.js";

const log = createLogger("history-init");

export type HistoryInitMode = "quick" | "full";
export type HistoryInitStage = "import" | "cluster" | "synthesize" | "all";
export type HistoryLlmErrorClass = "abort" | "fatal" | "size_reducible" | "rate_limit" | "other";

export interface HistoryLlmCallOptions {
    messages: ChatMessage[];
    caller: string;
    timeoutMs?: number;
    maxRetries: 0;
    abortSignal?: AbortSignal;
    stage: "cluster" | "summary" | "synthesis" | "repair";
}

export type HistoryLlmCallFn = (
    opts: HistoryLlmCallOptions,
    profiles: LLMConfig[],
) => Promise<{ content: string }>;

export type HistoryEmbedFn = (
    text: string,
    cfg: EmbeddingConfig,
    signal?: AbortSignal,
) => Promise<number[] | Float32Array>;

export type HistorySleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface HistoryInitOptions {
    chatId?: string;
    inputPath?: string;
    qceOptions?: QceImportOptions;
    mode?: HistoryInitMode;
    stage?: HistoryInitStage;
    windowMessages?: number;
    windowHours?: number;
    gapMinutes?: number;
    minWindowMessages?: number;
    since?: string;
    until?: string;
    maxWindows?: number;
    profile?: string;
    embed?: boolean;
    allowPrivateLlm?: boolean;
    dryRun?: boolean;
    resume?: boolean;
    timezone?: string;
    leaseTtlMs?: number;
    config?: AppConfig;
    signal?: AbortSignal;
    llmCall?: HistoryLlmCallFn;
    embedFn?: HistoryEmbedFn;
    sleepFn?: HistorySleepFn;
}

export interface HistoryInitSummary {
    dryRun: boolean;
    chatId: string;
    mode: HistoryInitMode;
    stage: HistoryInitStage;
    isPrivateOrSensitive: boolean;
    importSummary?: QceImportSummary;
    eligibleMessages: number;
    totalWindows: number;
    uncoveredWindows: number;
    selectedWindows: number;
    processedClusterUnits: number;
    remainingClusterUnits: number;
    topicsCommitted: number;
    messagesCovered: number;
    processedSynthesisUnits: number;
    remainingSynthesisUnits: number;
    factsCommitted: number;
    membersUpdated: number;
    groupFieldsWritten: string[];
    skippedPartialTopics: SkippedPartialTopic[];
    embeddedTopics: number;
    embeddedFacts: number;
    estimatedClusterCalls: number;
    estimatedSynthesisCalls: number;
    warnings: string[];
}

const MIN_CLUSTER_SPLIT_MESSAGES = 15;
const SYNTHESIS_SAMPLE_STEPS = [12, 6, 3] as const;
const MAX_RATE_LIMIT_BACKOFF_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 60_000;

const FALLBACK_CLUSTER_PROMPT = `你是一个离线历史聊天话题聚类助手。将按时间顺序排列的历史群聊消息切分为连贯的话题段落。
只使用输入中提供的 messageIds，每条消息最多归属一个话题，绝不编造不存在的 ID。
只输出严格 JSON：{"topics":[{"tempId":"t1","label":"话题标签","messageIds":["msg_1"]}]}`;

const FALLBACK_SUMMARY_PROMPT = `你是一个离线历史话题摘要助手。仅对已聚类的话题输出客观摘要与元数据（不要输出 shouldSignal）。
必须覆盖每一个 tempId，sentiment 必须是 positive|neutral|negative|mixed。
只输出严格 JSON：{"summaries":[{"tempId":"t1","label":"标签","summary":"摘要","keyPoints":["要点"],"keywords":["词"],"sentiment":"neutral"}]}`;

const FALLBACK_SYNTHESIS_SYSTEM_PROMPT = `你是新入群观察者，正在离线学习群文化、群梗/黑话与成员特征。
严格区分玩笑/反讽与真实个人事实：调侃与黑话只能进入 memes（写明真实含义与使用边界），绝不写入 biographical/personalClaims。
严禁输出任何 relationToAgent、dunbarTier、affinityScore。每条结论必须引用输入中的 topicId 和 messageIds。只输出严格 JSON。`;

const FALLBACK_SYNTHESIS_USER_PROMPT = `请根据以上历史话题与采样消息，输出严格 JSON：
{"groupUpdates":{"description":"","dominantLanguage":"","engagementLevel":"medium","communicationNorms":[],"hotTopics":[],"tabooTopics":[],"evidence":[]},"memberProfiles":[],"memes":[],"groupObservations":[]}`;

function createAbortError(): Error {
    const err = new Error("History initialization aborted");
    err.name = "AbortError";
    return err;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(createAbortError());
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(createAbortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function isAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === "TimeoutError") return false;
    return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

function isTimeoutError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return err.name === "TimeoutError"
        || msg.includes("aborted due to timeout")
        || msg.includes("etimedout")
        || msg.includes("timeout");
}

export function classifyHistoryLlmError(err: unknown): HistoryLlmErrorClass {
    if (!(err instanceof Error)) return "other";
    if (isTimeoutError(err)) return "size_reducible";
    if (isAbortError(err)) return "abort";

    const rec = err as { status?: unknown; errorCode?: unknown };
    const status = typeof rec.status === "number" ? rec.status : undefined;
    const errorCode = typeof rec.errorCode === "string" ? rec.errorCode.toLowerCase() : "";
    const msg = err.message.toLowerCase();

    if (
        status === 401
        || status === 402
        || status === 403
        || status === 404
        || errorCode === "invalid_api_key"
        || errorCode === "insufficient_quota"
        || errorCode === "model_not_found"
        || errorCode === "permission_denied"
        || msg.includes("401")
        || msg.includes("403")
        || msg.includes("402")
        || msg.includes("unauthorized")
        || msg.includes("forbidden")
        || msg.includes("permission_denied")
        || msg.includes("api key not valid")
        || msg.includes("invalid api key")
        || msg.includes("invalid_api_key")
        || msg.includes("insufficient_quota")
        || msg.includes("quota exceeded")
        || msg.includes("billing")
        || msg.includes("payment required")
        || msg.includes("model_not_found")
    ) {
        return "fatal";
    }

    if (
        status === 413
        || errorCode === "context_length_exceeded"
        || msg.includes("context length")
        || msg.includes("maximum context")
        || msg.includes("context_length_exceeded")
        || msg.includes("too long")
        || msg.includes("request too large")
        || msg.includes("payload too large")
        || msg.includes("tokens per min")
        || msg.includes("tpm")
    ) {
        return "size_reducible";
    }

    if (
        status === 429
        || errorCode === "rate_limit_exceeded"
        || msg.includes("429")
        || msg.includes("too many requests")
        || msg.includes("rate limit")
        || msg.includes("overloaded")
    ) {
        return "rate_limit";
    }

    return "other";
}

export function isNonReducibleFatalError(err: unknown): boolean {
    const cls = classifyHistoryLlmError(err);
    return cls === "fatal" || cls === "abort";
}

function parseRetryAfterMs(err: unknown): number | undefined {
    if (!err || typeof err !== "object") return undefined;
    const direct = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
        return Math.min(MAX_RETRY_AFTER_MS, direct);
    }
    const headers = (err as { headers?: { get?: (k: string) => string | null; [k: string]: unknown } }).headers;
    const rawHeader = typeof headers?.get === "function"
        ? headers.get("retry-after")
        : (typeof headers?.["retry-after"] === "string" ? headers["retry-after"] : undefined);
    const parsedFromHeader = parseRetryAfterHeaderMs(rawHeader);
    if (parsedFromHeader !== undefined) {
        return Math.min(MAX_RETRY_AFTER_MS, parsedFromHeader);
    }
    if (err instanceof Error) {
        const match = /retry[- ]after[:\s]+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?/i.exec(err.message);
        if (match) {
            const val = Number(match[1]);
            if (Number.isFinite(val) && val >= 0) {
                const unit = (match[2] ?? "s").toLowerCase();
                const ms = unit === "ms" ? val : val * 1000;
                return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(ms));
            }
        }
    }
    return undefined;
}

export function isPlatformDirectMessageChatId(chatId: string): boolean {
    const clean = chatId.trim();
    if (!clean) return false;
    if (clean.includes(":private:")) return true;
    if (/^telegram:[1-9]\d*$/.test(clean)) return true;
    if (clean.startsWith("discord:dm:")) return true;
    if (clean.startsWith("discord:")) {
        try {
            const parsed = parseChatId(clean);
            if (parsed.platform === "discord" && !parsed.groupId) return true;
        } catch {
            // ignore
        }
    }
    if (clean.startsWith("feishu:") && (clean.includes(":p2p:") || clean.includes(":dm:") || clean.includes(":private:"))) {
        return true;
    }
    return false;
}

function isSensitiveConfigSeed(chatId: string, config: AppConfig): boolean {
    const groupKey = getGroupModelKey(chatId);
    const seeds = new Set(config.privacy?.sensitiveChats ?? []);
    return (
        seeds.has(chatId)
        || seeds.has(groupKey)
        || seeds.has(getRawId(chatId))
        || seeds.has(getRawId(groupKey))
    );
}

export function isChatPrivateOrSensitive(
    memory: MemoryStoreV2,
    chatId: string,
    config: AppConfig,
): boolean {
    if (isPlatformDirectMessageChatId(chatId)) return true;
    const exactModel = memory.getGroupModel(chatId);
    const groupKey = getGroupModelKey(chatId);
    const groupModel = groupKey === chatId ? exactModel : memory.getGroupModel(groupKey);
    if (exactModel?.isDirectMessage || groupModel?.isDirectMessage) return true;
    if (exactModel?.markedSensitive || groupModel?.markedSensitive) return true;
    if (memory.isChatPrivate(chatId)) return true;
    if (isSensitiveConfigSeed(chatId, config)) return true;
    return false;
}

function assertPrivateLlmAllowed(
    memory: MemoryStoreV2,
    chatId: string,
    config: AppConfig,
    allowPrivateLlm: boolean,
): boolean {
    const isPrivate = isChatPrivateOrSensitive(memory, chatId, config);
    if (isPrivate && !allowPrivateLlm) {
        throw new Error(
            `Chat "${chatId}" is private or marked sensitive; refusing to send historical messages to LLM/embedding APIs without --allow-private-llm.`,
        );
    }
    return isPrivate;
}

function resolveStrictProfiles(
    explicitProfile: string | undefined,
    component: "recording_cluster" | "recording_triage" | "reflection",
    config: AppConfig,
): { profiles: LLMConfig[]; timeoutMs: number | undefined } {
    const timeoutMs = resolveComponentTimeout(component, config);
    if (explicitProfile !== undefined) {
        const clean = explicitProfile.trim();
        if (!clean || !Object.prototype.hasOwnProperty.call(config.llmProfiles, clean)) {
            const available = Object.keys(config.llmProfiles);
            throw new HistoryUsageError(
                `LLM profile "${explicitProfile}" not found in config.llmProfiles. Available profiles: ${available.length > 0 ? available.join(", ") : "(none)"}`,
            );
        }
        return { profiles: [config.llmProfiles[clean]], timeoutMs };
    }
    return {
        profiles: resolveComponentProfiles(component, config),
        timeoutMs,
    };
}

function resolveCanonicalInitTimezone(explicitTimezone: string | undefined, config: AppConfig): string {
    return assertValidIanaTimezone(explicitTimezone ?? config.timezone ?? getGlobalTimezone() ?? "UTC");
}

function validateInitBoundaries(
    since: string | undefined,
    until: string | undefined,
    timezone: string,
): { sinceMs?: number; untilMs?: number } {
    const sinceMs = since !== undefined ? parseStrictTimestampMs(since, timezone, "since") : undefined;
    const untilMs = until !== undefined ? parseStrictTimestampMs(until, timezone, "until") : undefined;
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs >= untilMs) {
        throw new HistoryUsageError(
            `Invalid date range: --since (${since}) must be earlier than --until (${until})`,
        );
    }
    return { sinceMs, untilMs };
}

function stripJsonFences(raw: string): string {
    const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
    if (fenced) return fenced[1].trim();
    return raw.trim().replace(/^```(?:json)?[ \t]*\r?\n?/i, "").replace(/\r?\n?```[ \t]*$/i, "").trim();
}

function extractTopLevelJsonObject(raw: string): Record<string, unknown> {
    const stripped = stripJsonFences(raw);
    const tryParseObj = (candidate: string): Record<string, unknown> | null => {
        const parsed = JSON.parse(candidate) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Expected top-level JSON object");
        }
        return parsed as Record<string, unknown>;
    };

    try {
        const obj = tryParseObj(stripped);
        if (obj) return obj;
    } catch {
        const firstBrace = stripped.indexOf("{");
        const lastBrace = stripped.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            const slice = stripped.slice(firstBrace, lastBrace + 1);
            const obj = tryParseObj(slice);
            if (obj) return obj;
        }
        throw new Error(`Malformed JSON output: ${stripped.slice(0, 160)}`);
    }
    throw new Error("Empty JSON output");
}

function formatWindowMessagesForClusterPrompt(messages: readonly HistoryMessageRow[]): string {
    return messages.map(m => {
        const replyTag = m.replyToMessageId ? ` [replyTo:${m.replyToMessageId}]` : "";
        const mediaTag = m.mediaType ? ` [${m.mediaType}]` : "";
        const evidenceText = getHistoryMessageEvidenceText(m);
        const cleanText = evidenceText.replace(/\s+/g, " ").trim() || mediaTag || "[empty]";
        return `[${m.messageId}] (${m.timestamp}) ${m.displayName || m.userId} [${m.userId}]${replyTag}: ${cleanText}`;
    }).join("\n");
}

interface ParsedClusterTopic {
    tempId: string;
    label: string;
    messageIds: string[];
}

function validateClusterResponse(obj: Record<string, unknown>): ParsedClusterTopic[] {
    if (!Array.isArray(obj.topics)) {
        throw new Error('Cluster JSON must contain a "topics" array');
    }
    const topics: ParsedClusterTopic[] = [];
    for (let i = 0; i < obj.topics.length; i++) {
        const item = obj.topics[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error(`Cluster topic[${i}] must be an object`);
        }
        const rec = item as Record<string, unknown>;
        if (typeof rec.label !== "string" || !Array.isArray(rec.messageIds)) {
            throw new Error(`Cluster topic[${i}] missing label or messageIds`);
        }
        const tempId = typeof rec.tempId === "string" && rec.tempId.trim() ? rec.tempId.trim() : `t_${i + 1}`;
        topics.push({
            tempId,
            label: rec.label.trim() || `话题 ${i + 1}`,
            messageIds: rec.messageIds.filter((id): id is string => typeof id === "string"),
        });
    }
    return topics;
}

interface ParsedSummaryEntry {
    tempId: string;
    label: string;
    summary: string;
    keyPoints: string[];
    keywords: string[];
    sentiment: TopicNode["sentiment"];
}

function normalizeSentiment(raw: unknown): TopicNode["sentiment"] {
    if (raw === "positive" || raw === "neutral" || raw === "negative" || raw === "mixed") {
        return raw;
    }
    return "neutral";
}

function validateSummaryResponse(
    obj: Record<string, unknown>,
    expectedTempIds: readonly string[],
): Map<string, ParsedSummaryEntry> {
    if (!Array.isArray(obj.summaries)) {
        throw new Error('Summary JSON must contain a "summaries" array');
    }
    const map = new Map<string, ParsedSummaryEntry>();
    for (let i = 0; i < obj.summaries.length; i++) {
        const item = obj.summaries[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error(`Summary entry[${i}] must be an object`);
        }
        const rec = item as Record<string, unknown>;
        if (typeof rec.tempId !== "string" || !rec.tempId.trim() || typeof rec.summary !== "string" || !rec.summary.trim()) {
            throw new Error(`Summary entry[${i}] missing tempId or non-empty summary`);
        }
        map.set(rec.tempId.trim(), {
            tempId: rec.tempId.trim(),
            label: typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : "",
            summary: rec.summary.trim(),
            keyPoints: Array.isArray(rec.keyPoints)
                ? rec.keyPoints.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim())
                : [],
            keywords: Array.isArray(rec.keywords)
                ? rec.keywords.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim())
                : [],
            sentiment: normalizeSentiment(rec.sentiment),
        });
    }
    for (const expectedId of expectedTempIds) {
        if (!map.has(expectedId)) {
            throw new Error(`Summary response missing expected tempId "${expectedId}"`);
        }
    }
    return map;
}

interface ValidatedSynthesisRaw {
    groupUpdates: Record<string, unknown>;
    memberProfiles: unknown[];
    memes: unknown[];
    groupObservations: unknown[];
}

function validateSynthesisResponse(obj: Record<string, unknown>): ValidatedSynthesisRaw {
    if (
        !Object.prototype.hasOwnProperty.call(obj, "groupUpdates")
        || !Object.prototype.hasOwnProperty.call(obj, "memberProfiles")
        || !Object.prototype.hasOwnProperty.call(obj, "memes")
        || !Object.prototype.hasOwnProperty.call(obj, "groupObservations")
    ) {
        throw new Error(
            "Synthesis JSON must include groupUpdates, memberProfiles, memes, and groupObservations keys",
        );
    }
    if (typeof obj.groupUpdates !== "object" || obj.groupUpdates === null || Array.isArray(obj.groupUpdates)) {
        throw new Error("Synthesis groupUpdates must be an object");
    }
    if (!Array.isArray(obj.memberProfiles)) {
        throw new Error("Synthesis memberProfiles must be an array");
    }
    if (!Array.isArray(obj.memes)) {
        throw new Error("Synthesis memes must be an array");
    }
    if (!Array.isArray(obj.groupObservations)) {
        throw new Error("Synthesis groupObservations must be an array");
    }
    return {
        groupUpdates: obj.groupUpdates as Record<string, unknown>,
        memberProfiles: obj.memberProfiles as unknown[],
        memes: obj.memes as unknown[],
        groupObservations: obj.groupObservations as unknown[],
    };
}

// ─── Read-only Dry-Run Inspection (zero DB creation/mutation) ───

function inspectHistoryDryRunReadOnly(params: {
    dbPath: string;
    chatId: string;
    mode: HistoryInitMode;
    stage: HistoryInitStage;
    config: AppConfig;
    windowConfig: {
        windowMessages?: number;
        windowHours?: number;
        gapMinutes?: number;
        minWindowMessages?: number;
        since?: string;
        until?: string;
        timezone: string;
    };
    sinceMs?: number;
    untilMs?: number;
    maxWindows?: number;
    importSummary?: QceImportSummary;
    stagedPreviewRows: HistoryMessageRow[];
    warnings: string[];
}): HistoryInitSummary {
    const {
        dbPath,
        chatId,
        mode,
        stage,
        config,
        windowConfig,
        sinceMs,
        untilMs,
        maxWindows,
        importSummary,
        stagedPreviewRows,
        warnings,
    } = params;

    const runClusterStage = stage === "cluster" || stage === "all";
    const runSynthesizeStage = stage === "synthesize" || stage === "all";

    let dbMessages: HistoryMessageRow[] = [];
    const coveredIds = new Set<string>();
    let storedTopicCount = 0;
    let isPrivateOrSensitive = isPlatformDirectMessageChatId(chatId)
        || isSensitiveConfigSeed(chatId, config)
        || Boolean(importSummary?.isDirectMessage);

    if (dbPath && fs.existsSync(dbPath)) {
        const roDb = openSqliteReadOnlyStrict(dbPath);
        try {
            const tableRows = roDb.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table'",
            ).all() as Array<{ name: string }>;
            const tables = new Set(tableRows.map(r => r.name));

            const getCols = (table: string): Set<string> => {
                if (!tables.has(table)) return new Set();
                const info = roDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
                return new Set(info.map(c => c.name));
            };

            if (tables.has("group_models")) {
                const gmCols = getCols("group_models");
                const groupKey = getGroupModelKey(chatId);
                const keysToCheck = groupKey === chatId ? [chatId] : [chatId, groupKey];
                for (const key of keysToCheck) {
                    const row = roDb.prepare("SELECT * FROM group_models WHERE chat_id = ?").get(key) as
                        | Record<string, unknown>
                        | undefined;
                    if (row) {
                        if (gmCols.has("is_direct_message") && Boolean(row.is_direct_message)) {
                            isPrivateOrSensitive = true;
                        }
                        if (gmCols.has("marked_sensitive") && Boolean(row.marked_sensitive)) {
                            isPrivateOrSensitive = true;
                        }
                    }
                }
            }

            if (tables.has("history_cluster_coverage")) {
                const covRows = roDb.prepare(
                    "SELECT message_id FROM history_cluster_coverage WHERE chat_id = ?",
                ).all(chatId) as Array<{ message_id: string }>;
                for (const r of covRows) coveredIds.add(r.message_id);
            }

            if (tables.has("topics")) {
                const topicCols = getCols("topics");
                if (topicCols.has("history_key")) {
                    const cntRow = roDb.prepare(
                        "SELECT COUNT(*) as cnt FROM topics WHERE chat_id = ? AND history_key IS NOT NULL",
                    ).get(chatId) as { cnt: number } | undefined;
                    storedTopicCount = Number(cntRow?.cnt ?? 0);
                }
            }

            if (tables.has("message_log")) {
                const msgCols = getCols("message_log");
                const blockedCond = msgCols.has("access_control_blocked") ? "AND access_control_blocked = 0" : "";
                const qceMetaSel = msgCols.has("qce_meta") ? "qce_meta" : "NULL AS qce_meta";
                const replySel = msgCols.has("reply_to_message_id") ? "reply_to_message_id" : "NULL AS reply_to_message_id";
                const mentionsSel = msgCols.has("mentions") ? "mentions" : "NULL AS mentions";
                const mediaTypeSel = msgCols.has("media_type") ? "media_type" : "NULL AS media_type";
                const mediaInfoSel = msgCols.has("media_info") ? "media_info" : "NULL AS media_info";

                const rows = roDb.prepare(`
                    SELECT
                        message_id,
                        chat_id,
                        user_id,
                        display_name,
                        text,
                        ${replySel},
                        timestamp,
                        CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000) AS INTEGER) AS timestamp_ms,
                        ${mentionsSel},
                        ${mediaTypeSel},
                        ${mediaInfoSel},
                        ${qceMetaSel}
                    FROM message_log
                    WHERE chat_id = ? ${blockedCond}
                    ORDER BY timestamp_ms ASC, message_id COLLATE BINARY ASC
                `).all(chatId) as Array<Record<string, unknown>>;

                dbMessages = rows.map(row => ({
                    messageId: row.message_id as string,
                    chatId: row.chat_id as string,
                    userId: row.user_id as string,
                    displayName: (row.display_name as string) ?? "",
                    text: (row.text as string) ?? "",
                    replyToMessageId: (row.reply_to_message_id as string) ?? null,
                    timestamp: row.timestamp as string,
                    timestampMs: Number(row.timestamp_ms ?? 0),
                    mentions: (row.mentions as string) ?? null,
                    mediaType: (row.media_type as string) ?? null,
                    mediaInfo: (row.media_info as string) ?? null,
                    qceMeta: (row.qce_meta as string) ?? null,
                })).filter(row => {
                    if (!isEligibleHistoryMessageRow(row)) return false;
                    if (sinceMs !== undefined && row.timestampMs < sinceMs) return false;
                    if (untilMs !== undefined && row.timestampMs >= untilMs) return false;
                    return true;
                });
            }
        } finally {
            try {
                roDb.close();
            } catch {
                // ignore
            }
        }
    }

    if (stage === "import") {
        return {
            dryRun: true,
            chatId,
            mode,
            stage,
            isPrivateOrSensitive,
            importSummary,
            eligibleMessages: importSummary?.eligibleMessages ?? 0,
            totalWindows: 0,
            uncoveredWindows: 0,
            selectedWindows: 0,
            processedClusterUnits: 0,
            remainingClusterUnits: 0,
            topicsCommitted: 0,
            messagesCovered: 0,
            processedSynthesisUnits: 0,
            remainingSynthesisUnits: 0,
            factsCommitted: 0,
            membersUpdated: 0,
            groupFieldsWritten: [],
            skippedPartialTopics: [],
            embeddedTopics: 0,
            embeddedFacts: 0,
            estimatedClusterCalls: 0,
            estimatedSynthesisCalls: 0,
            warnings,
        };
    }

    // Merge DB eligible messages with staged preview messages (DB takes precedence on identical IDs)
    const mergedById = new Map<string, HistoryMessageRow>();
    for (const row of stagedPreviewRows) {
        if (!isEligibleHistoryMessageRow(row)) continue;
        if (sinceMs !== undefined && row.timestampMs < sinceMs) continue;
        if (untilMs !== undefined && row.timestampMs >= untilMs) continue;
        mergedById.set(row.messageId, row);
    }
    for (const row of dbMessages) {
        mergedById.set(row.messageId, row);
    }

    const eligibleMessages = [...mergedById.values()].sort((a, b) =>
        (a.timestampMs - b.timestampMs)
        || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0),
    );

    const allWindows = buildHistoryWindows(eligibleMessages, windowConfig);
    const uncoveredWindows = allWindows.filter(w => w.messages.some(m => !coveredIds.has(m.messageId)));
    const selectedWindows = runClusterStage
        ? selectWindowsForMode(allWindows, mode, coveredIds, windowConfig)
        : [];

    const maxWins = maxWindows !== undefined && maxWindows > 0 ? Math.floor(maxWindows) : undefined;
    const plannedClusterUnits = maxWins !== undefined ? Math.min(selectedWindows.length, maxWins) : selectedWindows.length;
    const estimatedClusterCalls = runClusterStage ? plannedClusterUnits * 2 : 0;

    let estimatedSynthesisUnits = 0;
    if (runSynthesizeStage) {
        if (storedTopicCount > 0) {
            estimatedSynthesisUnits = Math.max(1, Math.ceil(storedTopicCount / 24));
        } else if (runClusterStage && plannedClusterUnits > 0) {
            estimatedSynthesisUnits = Math.max(1, Math.ceil(plannedClusterUnits / 6));
        }
    }
    const plannedSynthesisUnits = maxWins !== undefined
        ? Math.min(estimatedSynthesisUnits, maxWins)
        : estimatedSynthesisUnits;

    return {
        dryRun: true,
        chatId,
        mode,
        stage,
        isPrivateOrSensitive,
        importSummary,
        eligibleMessages: eligibleMessages.length,
        totalWindows: allWindows.length,
        uncoveredWindows: uncoveredWindows.length,
        selectedWindows: selectedWindows.length,
        processedClusterUnits: 0,
        remainingClusterUnits: Math.max(0, selectedWindows.length - plannedClusterUnits),
        topicsCommitted: 0,
        messagesCovered: 0,
        processedSynthesisUnits: 0,
        remainingSynthesisUnits: Math.max(0, estimatedSynthesisUnits - plannedSynthesisUnits),
        factsCommitted: 0,
        membersUpdated: 0,
        groupFieldsWritten: [],
        skippedPartialTopics: [],
        embeddedTopics: 0,
        embeddedFacts: 0,
        estimatedClusterCalls,
        estimatedSynthesisCalls: plannedSynthesisUnits,
        warnings,
    };
}

export async function runHistoryInitialization(options: HistoryInitOptions): Promise<HistoryInitSummary> {
    const config = options.config ?? loadConfig();
    const mode: HistoryInitMode = options.mode ?? "quick";
    const stage: HistoryInitStage = options.stage ?? "all";
    const warnings: string[] = [];
    const sleepFn = options.sleepFn ?? defaultSleep;
    const signal = options.signal;

    const timezone = resolveCanonicalInitTimezone(options.timezone ?? options.qceOptions?.timezone, config);
    const { sinceMs, untilMs } = validateInitBoundaries(
        options.since ?? options.qceOptions?.since,
        options.until ?? options.qceOptions?.until,
        timezone,
    );

    if (stage === "import" && !options.inputPath) {
        throw new HistoryUsageError("history init --stage import requires --input <path>");
    }
    if ((stage === "cluster" || stage === "synthesize") && !options.chatId?.trim()) {
        throw new HistoryUsageError(`history init --stage ${stage} requires --chat-id <compositeChatId>`);
    }
    if (!options.chatId?.trim() && !options.inputPath) {
        throw new HistoryUsageError("history init requires --chat-id <compositeChatId> or --input <path>");
    }

    // Strict --profile validation BEFORE opening DB (even on fresh-DB dryRun!)
    if (stage !== "import") {
        resolveStrictProfiles(options.profile, "recording_cluster", config);
        resolveStrictProfiles(options.profile, "recording_triage", config);
        resolveStrictProfiles(options.profile, "reflection", config);
    }

    let importSummary: QceImportSummary | undefined;
    let resolvedChatId = options.chatId?.trim() || "";
    const dbPath = options.qceOptions?.dbPath ?? "workspace/memory.db";

    if (options.dryRun) {
        const stagedPreviewRows: HistoryMessageRow[] = [];
        if (options.inputPath && (stage === "import" || stage === "all")) {
            const qceOpts: QceImportOptions = {
                ...(options.qceOptions ?? {}),
                ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
                timezone,
                since: options.since ?? options.qceOptions?.since,
                until: options.until ?? options.qceOptions?.until,
                dryRun: true,
                resume: options.resume,
            };
            importSummary = await dryRunQceImport(
                options.inputPath,
                dbPath,
                qceOpts,
                signal,
                (msg) => {
                    stagedPreviewRows.push({
                        messageId: msg.messageId,
                        chatId: msg.chatId,
                        userId: msg.userId,
                        displayName: msg.displayName,
                        text: msg.text,
                        replyToMessageId: msg.replyToMessageId ?? null,
                        timestamp: msg.timestamp,
                        timestampMs: msg.timestampMs,
                        mentions: msg.mentions ? JSON.stringify(msg.mentions) : null,
                        mediaType: msg.mediaType ?? null,
                        mediaInfo: msg.mediaInfo ?? null,
                        qceMeta: msg.qceMeta ? JSON.stringify(msg.qceMeta) : null,
                    });
                },
            );
            resolvedChatId = resolvedChatId || importSummary.chatId;
        }

        if (!resolvedChatId) {
            throw new HistoryUsageError("history init requires --chat-id <compositeChatId> or --input <path>");
        }

        return inspectHistoryDryRunReadOnly({
            dbPath,
            chatId: resolvedChatId,
            mode,
            stage,
            config,
            windowConfig: {
                windowMessages: options.windowMessages,
                windowHours: options.windowHours,
                gapMinutes: options.gapMinutes,
                minWindowMessages: options.minWindowMessages,
                since: options.since,
                until: options.until,
                timezone,
            },
            sinceMs,
            untilMs,
            maxWindows: options.maxWindows,
            importSummary,
            stagedPreviewRows,
            warnings,
        });
    }

    const { createMemoryStore } = await import("../core/memory-factory.js");
    const embeddingCfg = options.embed ? config.embedding : (config.embedding?.enabled ? config.embedding : undefined);
    const memory = createMemoryStore(dbPath, {
        config,
        embeddingConfig: embeddingCfg,
    });

    try {
        return await runHistoryInitializationWithMemory(memory, {
            ...options,
            chatId: resolvedChatId || undefined,
            timezone,
            config,
            mode,
            stage,
            sleepFn,
        }, importSummary);
    } finally {
        memory.close();
    }
}

export async function runHistoryInitializationWithMemory(
    memory: MemoryStoreV2,
    options: HistoryInitOptions,
    precomputedDryRunImport?: QceImportSummary,
): Promise<HistoryInitSummary> {
    const config = options.config ?? loadConfig();
    const mode: HistoryInitMode = options.mode ?? "quick";
    const stage: HistoryInitStage = options.stage ?? "all";
    const sleepFn = options.sleepFn ?? defaultSleep;
    const signal = options.signal;
    const warnings: string[] = [];

    if (signal?.aborted) {
        throw createAbortError();
    }

    const timezone = resolveCanonicalInitTimezone(options.timezone ?? options.qceOptions?.timezone, config);
    const { sinceMs, untilMs } = validateInitBoundaries(
        options.since ?? options.qceOptions?.since,
        options.until ?? options.qceOptions?.until,
        timezone,
    );

    if (stage === "import" && !options.inputPath) {
        throw new HistoryUsageError("history init --stage import requires --input <path>");
    }
    if ((stage === "cluster" || stage === "synthesize") && !options.chatId?.trim()) {
        throw new HistoryUsageError(`history init --stage ${stage} requires --chat-id <compositeChatId>`);
    }

    // Strict --profile validation BEFORE any DB/LLM work
    const clusterRouting = stage === "import" ? undefined : resolveStrictProfiles(options.profile, "recording_cluster", config);
    const summaryRouting = stage === "import" ? undefined : resolveStrictProfiles(options.profile, "recording_triage", config);
    const synthesisRouting = stage === "import" ? undefined : resolveStrictProfiles(options.profile, "reflection", config);

    let importSummary: QceImportSummary | undefined = precomputedDryRunImport;
    let chatId = options.chatId?.trim() || "";

    if (options.inputPath && (stage === "import" || stage === "all") && !importSummary) {
        importSummary = await importQce(memory, options.inputPath, {
            ...(options.qceOptions ?? {}),
            ...(chatId ? { chatId } : {}),
            timezone,
            since: options.since ?? options.qceOptions?.since,
            until: options.until ?? options.qceOptions?.until,
            dryRun: options.dryRun,
            resume: options.resume,
        }, signal);
        chatId = chatId || importSummary.chatId;
    } else if (importSummary && !chatId) {
        chatId = importSummary.chatId;
    }

    if (!chatId) {
        throw new HistoryUsageError("history init requires --chat-id <compositeChatId> or --input <path>");
    }

    const isPrivateOrSensitive = isChatPrivateOrSensitive(memory, chatId, config);

    if (stage === "import") {
        return {
            dryRun: Boolean(options.dryRun),
            chatId,
            mode,
            stage,
            isPrivateOrSensitive,
            importSummary,
            eligibleMessages: importSummary?.eligibleMessages ?? 0,
            totalWindows: 0,
            uncoveredWindows: 0,
            selectedWindows: 0,
            processedClusterUnits: 0,
            remainingClusterUnits: 0,
            topicsCommitted: 0,
            messagesCovered: 0,
            processedSynthesisUnits: 0,
            remainingSynthesisUnits: 0,
            factsCommitted: 0,
            membersUpdated: 0,
            groupFieldsWritten: [],
            skippedPartialTopics: [],
            embeddedTopics: 0,
            embeddedFacts: 0,
            estimatedClusterCalls: 0,
            estimatedSynthesisCalls: 0,
            warnings,
        };
    }

    if (!options.dryRun) {
        assertPrivateLlmAllowed(memory, chatId, config, Boolean(options.allowPrivateLlm));
    }

    const windowConfig = {
        windowMessages: options.windowMessages,
        windowHours: options.windowHours,
        gapMinutes: options.gapMinutes,
        minWindowMessages: options.minWindowMessages,
        since: options.since,
        until: options.until,
        timezone,
    };

    const runClusterStage = stage === "cluster" || stage === "all";
    const runSynthesizeStage = stage === "synthesize" || stage === "all";
    const shouldEmbed = Boolean(options.embed || config.embedding?.enabled);
    const embeddingCfg: EmbeddingConfig | undefined = shouldEmbed ? config.embedding : undefined;
    const maxWindows = options.maxWindows !== undefined && options.maxWindows > 0
        ? Math.floor(options.maxWindows)
        : undefined;

    // Dry-run: compute plan with ZERO LLM calls and ZERO DB writes
    if (options.dryRun) {
        const eligibleMessages = loadEligibleHistoryMessages(memory, chatId, {
            since: options.since,
            until: options.until,
            timezone,
        });
        const allWindows = buildHistoryWindows(eligibleMessages, windowConfig);
        const coveredIds = memory.getCoveredMessageIds(chatId);
        const uncoveredWindows = allWindows.filter(w => w.messages.some(m => !coveredIds.has(m.messageId)));
        const selectedWindows = runClusterStage
            ? selectWindowsForMode(allWindows, mode, coveredIds, windowConfig)
            : [];
        const storedTopics = memory.getHistoricalTopicsForChat(chatId);
        const existingSynthPlan = runSynthesizeStage
            ? buildSynthesisMacroBatches(storedTopics, memory, {
                chatId,
                since: options.since,
                until: options.until,
                timezone,
            })
            : { batches: [], skippedPartialTopics: [] };

        const plannedClusterUnits = maxWindows !== undefined
            ? Math.min(selectedWindows.length, maxWindows)
            : selectedWindows.length;
        const estimatedClusterCalls = plannedClusterUnits * 2;

        const baseSynthCount = existingSynthPlan.batches.length > 0
            ? existingSynthPlan.batches.length
            : (runClusterStage && plannedClusterUnits > 0 ? Math.max(1, Math.ceil(plannedClusterUnits / 6)) : 0);
        const plannedSynthUnits = maxWindows !== undefined
            ? Math.min(baseSynthCount, maxWindows)
            : baseSynthCount;

        return {
            dryRun: true,
            chatId,
            mode,
            stage,
            isPrivateOrSensitive,
            importSummary,
            eligibleMessages: eligibleMessages.length,
            totalWindows: allWindows.length,
            uncoveredWindows: uncoveredWindows.length,
            selectedWindows: selectedWindows.length,
            processedClusterUnits: 0,
            remainingClusterUnits: Math.max(0, selectedWindows.length - plannedClusterUnits),
            topicsCommitted: 0,
            messagesCovered: 0,
            processedSynthesisUnits: 0,
            remainingSynthesisUnits: Math.max(0, existingSynthPlan.batches.length - plannedSynthUnits),
            factsCommitted: 0,
            membersUpdated: 0,
            groupFieldsWritten: [],
            skippedPartialTopics: existingSynthPlan.skippedPartialTopics,
            embeddedTopics: 0,
            embeddedFacts: 0,
            estimatedClusterCalls,
            estimatedSynthesisCalls: runSynthesizeStage ? plannedSynthUnits : 0,
            warnings,
        };
    }

    // Acquire lease BEFORE planning/reading coverage so no concurrent job races our plan!
    const leaseTtlMs = Math.max(100, Math.floor(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));
    const lease = memory.acquireHistoryLease(chatId, leaseTtlMs);
    const leaseAbortController = new AbortController();
    const jobSignal = signal
        ? AbortSignal.any([signal, leaseAbortController.signal])
        : leaseAbortController.signal;

    const beforeOutboundCall = () => {
        if (jobSignal.aborted) {
            throw jobSignal.reason instanceof Error ? jobSignal.reason : createAbortError();
        }
        assertPrivateLlmAllowed(memory, chatId, config, Boolean(options.allowPrivateLlm));
    };

    const llmCall: HistoryLlmCallFn = options.llmCall ?? (async (opts, profiles) => {
        const res = await callLLMWithFallback(opts.messages, profiles, {
            caller: opts.caller,
            timeoutMs: opts.timeoutMs,
            maxRetries: 0,
            abortSignal: opts.abortSignal,
            beforeAttempt: beforeOutboundCall,
        });
        return { content: res.content };
    });

    const embedFn: HistoryEmbedFn = options.embedFn ?? (async (text, cfg, embedSignal) => {
        const vecs = await embed([text], cfg, {
            signal: embedSignal,
            beforeAttempt: beforeOutboundCall,
        });
        if (vecs.length !== 1 || !(vecs[0] instanceof Float32Array) || vecs[0].length === 0) {
            throw new Error("Embedding API returned missing or empty vector");
        }
        return vecs[0];
    });

    const heartbeatIntervalMs = Math.max(50, Math.floor(leaseTtlMs / 3));
    let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        try {
            memory.renewHistoryLease(chatId, lease.ownerToken, leaseTtlMs);
        } catch (err) {
            stopHeartbeat();
            leaseAbortController.abort(err instanceof Error ? err : new Error(String(err)));
        }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    const stopHeartbeat = () => {
        if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    };

    const scopeFingerprint = {
        stage,
        windowMessages: options.windowMessages ?? null,
        windowHours: options.windowHours ?? null,
        gapMinutes: options.gapMinutes ?? null,
        minWindowMessages: options.minWindowMessages ?? null,
        since: options.since ?? null,
        until: options.until ?? null,
        profile: options.profile ?? null,
    };
    const inputKey = `init:${mode}:${options.since ?? ""}:${options.until ?? ""}:${options.windowMessages ?? 120}:${options.windowHours ?? 4}:${options.gapMinutes ?? 30}:${options.minWindowMessages ?? DEFAULT_MIN_WINDOW_MESSAGES}`;
    const optionsJson = JSON.stringify({ mode, ...scopeFingerprint });

    let jobIdForCleanup = "";
    try {
        const existingJob = memory.findLatestHistoryJob("initialize", chatId);
        if (options.resume) {
            if (!existingJob) {
                throw new Error(`No previous initialize job found to resume for chat ${chatId}. Run without --resume.`);
            }
            let prevOpts: Record<string, unknown> = {};
            try {
                prevOpts = JSON.parse(existingJob.optionsJson) as Record<string, unknown>;
            } catch {
                throw new Error(`Corrupt initialize job optionsJson for chat ${chatId}; cannot --resume.`);
            }
            const prevMode = prevOpts.mode as HistoryInitMode | undefined;
            const modeCompatible = prevMode === mode || (prevMode === "quick" && mode === "full");
            const scopeMatches =
                (prevOpts.stage ?? null) === scopeFingerprint.stage
                && (prevOpts.windowMessages ?? null) === scopeFingerprint.windowMessages
                && (prevOpts.windowHours ?? null) === scopeFingerprint.windowHours
                && (prevOpts.gapMinutes ?? null) === scopeFingerprint.gapMinutes
                && (prevOpts.minWindowMessages ?? null) === scopeFingerprint.minWindowMessages
                && (prevOpts.since ?? null) === scopeFingerprint.since
                && (prevOpts.until ?? null) === scopeFingerprint.until
                && (prevOpts.profile ?? null) === scopeFingerprint.profile;
            if (!modeCompatible || !scopeMatches) {
                throw new HistoryUsageError(
                    `Initialize options changed since previous job for chat ${chatId}; cannot --resume with incompatible scope/options.`,
                );
            }
        }

        const job = memory.upsertHistoryJob({
            kind: "initialize",
            chatId,
            inputKey: options.resume && existingJob ? existingJob.inputKey : inputKey,
            optionsJson,
            status: "running",
        }, lease.ownerToken);
        jobIdForCleanup = job.jobId;

        const eligibleMessages = loadEligibleHistoryMessages(memory, chatId, {
            since: options.since,
            until: options.until,
            timezone,
        });
        const allWindows = buildHistoryWindows(eligibleMessages, windowConfig);
        const coveredIds = memory.getCoveredMessageIds(chatId);
        const uncoveredWindows = allWindows.filter(w => w.messages.some(m => !coveredIds.has(m.messageId)));
        const selectedWindows = runClusterStage
            ? selectWindowsForMode(allWindows, mode, coveredIds, windowConfig)
            : [];

        let processedClusterUnits = 0;
        let remainingClusterUnits = 0;
        let topicsCommitted = 0;
        let messagesCovered = 0;
        let processedSynthesisUnits = 0;
        let remainingSynthesisUnits = 0;
        let factsCommitted = 0;
        let membersUpdated = 0;
        const groupFieldsWrittenSet = new Set<string>();
        let skippedPartialTopics: SkippedPartialTopic[] = [];
        let embeddedTopics = 0;
        let embeddedFacts = 0;
        let remainingEmbedUnits = 0;

        try {
            // ── Stage 1: Cluster + Summary ──
            if (runClusterStage) {
                const clusterUnitInputs: HistoryUnitInput[] = selectedWindows.map((w, idx) => ({
                    unitKey: w.unitKey,
                    ordinal: idx,
                    inputJson: JSON.stringify({
                        messageIds: w.messageIds,
                        startedAt: w.startedAt,
                        endedAt: w.endedAt,
                        inputDigest: w.inputDigest,
                    }),
                }));
                memory.upsertHistoryUnits(job.jobId, "cluster", clusterUnitInputs, lease.ownerToken);
                const storedUnits = memory.listHistoryUnits(job.jobId, "cluster");
                const completedKeys = new Set(storedUnits.filter(u => u.completedAt !== null).map(u => u.unitKey));
                const pendingWindows = selectedWindows.filter(w => !completedKeys.has(w.unitKey));

                const toProcess = maxWindows !== undefined
                    ? pendingWindows.slice(0, maxWindows)
                    : pendingWindows;
                remainingClusterUnits = pendingWindows.length - toProcess.length;

                for (const win of toProcess) {
                    if (jobSignal.aborted) throw jobSignal.reason instanceof Error ? jobSignal.reason : createAbortError();
                    memory.renewHistoryLease(chatId, lease.ownerToken, leaseTtlMs);

                    const clustered = await clusterWindowResilient({
                        chatId,
                        window: win,
                        llmCall,
                        clusterRouting: clusterRouting!,
                        summaryRouting: summaryRouting!,
                        sleepFn,
                        signal: jobSignal,
                        beforeOutboundCall,
                    });

                    const commitRes = memory.commitHistoricalClusterUnit({
                        jobId: job.jobId,
                        ownerToken: lease.ownerToken,
                        chatId,
                        unitKey: win.unitKey,
                        expectedMessageIds: win.messageIds,
                        expectedDigest: win.inputDigest,
                        topics: clustered.topics,
                        coveredPairs: clustered.coveredPairs,
                        outputJson: JSON.stringify({
                            topicCount: clustered.topics.length,
                            coveredCount: clustered.coveredPairs.length,
                        }),
                    });
                    processedClusterUnits++;
                    topicsCommitted += commitRes.topicIds.length;
                    messagesCovered += commitRes.coveredCount;
                }
            }

            // ── Stage 2: Social Memory Synthesis ──
            if (runSynthesizeStage) {
                const historicalTopics = memory.getHistoricalTopicsForChat(chatId);
                const synthPlan = buildSynthesisMacroBatches(historicalTopics, memory, {
                    chatId,
                    since: options.since,
                    until: options.until,
                    timezone,
                });
                skippedPartialTopics = synthPlan.skippedPartialTopics;

                const synthUnitInputs: HistoryUnitInput[] = synthPlan.batches.map((b, idx) => ({
                    unitKey: b.unitKey,
                    ordinal: idx,
                    inputJson: b.inputJson,
                }));
                memory.upsertHistoryUnits(job.jobId, "synthesize", synthUnitInputs, lease.ownerToken);
                const storedUnits = memory.listHistoryUnits(job.jobId, "synthesize");
                const completedKeys = new Set(storedUnits.filter(u => u.completedAt !== null).map(u => u.unitKey));
                const pendingBatches = synthPlan.batches.filter(b => !completedKeys.has(b.unitKey));

                const toProcess = maxWindows !== undefined
                    ? pendingBatches.slice(0, maxWindows)
                    : pendingBatches;
                remainingSynthesisUnits = pendingBatches.length - toProcess.length;

                for (const batch of toProcess) {
                    if (jobSignal.aborted) throw jobSignal.reason instanceof Error ? jobSignal.reason : createAbortError();
                    memory.renewHistoryLease(chatId, lease.ownerToken, leaseTtlMs);

                    const synthesized = await synthesizeBatchResilient({
                        chatId,
                        batch,
                        memory,
                        llmCall,
                        synthesisRouting: synthesisRouting!,
                        sleepFn,
                        signal: jobSignal,
                        beforeOutboundCall,
                    });

                    const commitRes = memory.commitHistoricalSynthesisUnit({
                        jobId: job.jobId,
                        ownerToken: lease.ownerToken,
                        chatId,
                        unitKey: batch.unitKey,
                        rankKey: batch.rankKey,
                        groupPatch: synthesized.groupPatch,
                        groupPatchCitations: synthesized.groupPatchCitations,
                        memberPatches: synthesized.memberPatches,
                        factProposals: synthesized.factProposals,
                        expectedEvidence: synthesized.expectedEvidence,
                        outputJson: JSON.stringify({
                            facts: synthesized.factProposals.length,
                            members: synthesized.memberPatches.length,
                            groupPatchKeys: Object.keys(synthesized.groupPatch),
                        }),
                        isPrivateOrSensitive: isChatPrivateOrSensitive(memory, chatId, config),
                    });

                    processedSynthesisUnits++;
                    factsCommitted += commitRes.factsCommitted;
                    membersUpdated += commitRes.membersUpdated;
                    for (const f of commitRes.groupFieldsWritten) {
                        groupFieldsWrittenSet.add(f);
                    }
                }
            }

            // ── Stage 3: Checkpointed Embedding Stage ──
            if (embeddingCfg) {
                const embedRes = await runCheckpointedEmbedStage({
                    jobId: job.jobId,
                    ownerToken: lease.ownerToken,
                    chatId,
                    memory,
                    embeddingCfg,
                    embedFn,
                    signal: jobSignal,
                    sinceMs,
                    untilMs,
                    maxUnits: maxWindows,
                    beforeOutboundCall,
                });
                embeddedTopics = embedRes.embeddedTopics;
                embeddedFacts = embedRes.embeddedFacts;
                remainingEmbedUnits = embedRes.remainingEmbedUnits;
            }

            const finalStatus = (remainingClusterUnits > 0 || remainingSynthesisUnits > 0 || remainingEmbedUnits > 0)
                ? "paused"
                : "done";
            memory.updateHistoryJobStatus(job.jobId, lease.ownerToken, finalStatus, {
                processedClusterUnits,
                remainingClusterUnits,
                processedSynthesisUnits,
                remainingSynthesisUnits,
                remainingEmbedUnits,
                updatedAt: new Date().toISOString(),
            });

            return {
                dryRun: false,
                chatId,
                mode,
                stage,
                isPrivateOrSensitive: isChatPrivateOrSensitive(memory, chatId, config),
                importSummary,
                eligibleMessages: eligibleMessages.length,
                totalWindows: allWindows.length,
                uncoveredWindows: uncoveredWindows.length,
                selectedWindows: selectedWindows.length,
                processedClusterUnits,
                remainingClusterUnits,
                topicsCommitted,
                messagesCovered,
                processedSynthesisUnits,
                remainingSynthesisUnits,
                factsCommitted,
                membersUpdated,
                groupFieldsWritten: [...groupFieldsWrittenSet],
                skippedPartialTopics,
                embeddedTopics,
                embeddedFacts,
                estimatedClusterCalls: processedClusterUnits * 2,
                estimatedSynthesisCalls: processedSynthesisUnits,
                warnings,
            };
        } catch (err) {
            if (jobIdForCleanup) {
                try {
                    memory.updateHistoryJobStatus(jobIdForCleanup, lease.ownerToken, "paused", {
                        error: err instanceof Error ? err.message : String(err),
                        pausedAt: new Date().toISOString(),
                    });
                } catch {
                    // ignore if lease already expired
                }
            }
            throw err;
        }
    } finally {
        stopHeartbeat();
        try {
            memory.releaseHistoryLease(chatId, lease.ownerToken);
        } catch {
            // ignore
        }
    }
}

// ─── Resilient LLM Execution Helpers ───

async function callLlmWithRateLimitBackoff<T>(
    params: {
        messages: ChatMessage[];
        caller: string;
        profiles: LLMConfig[];
        timeoutMs?: number;
        stage: HistoryLlmCallOptions["stage"];
        llmCall: HistoryLlmCallFn;
        sleepFn: HistorySleepFn;
        signal?: AbortSignal;
        beforeOutboundCall?: () => void;
        schemaDescription: string;
        validate: (obj: Record<string, unknown>) => T;
    },
): Promise<{ parsed: T; rawContent: string }> {
    const invokeWithBackoff = async (messages: ChatMessage[], stage: HistoryLlmCallOptions["stage"]): Promise<string> => {
        for (let attempt = 0; ; attempt++) {
            if (params.signal?.aborted) {
                throw params.signal.reason instanceof Error ? params.signal.reason : createAbortError();
            }
            params.beforeOutboundCall?.();
            try {
                const res = await params.llmCall({
                    messages,
                    caller: params.caller,
                    timeoutMs: params.timeoutMs,
                    maxRetries: 0,
                    abortSignal: params.signal,
                    stage,
                }, params.profiles);
                return res.content;
            } catch (err) {
                const errClass = classifyHistoryLlmError(err);
                if (errClass === "abort" || errClass === "fatal" || errClass === "size_reducible") {
                    throw err;
                }
                if (errClass === "rate_limit" && attempt < MAX_RATE_LIMIT_BACKOFF_RETRIES) {
                    const retryAfterMs = parseRetryAfterMs(err);
                    const delay = retryAfterMs ?? Math.min(8000, 1000 * Math.pow(2, attempt));
                    await params.sleepFn(delay, params.signal);
                    continue;
                }
                throw err;
            }
        }
    };

    const firstRaw = await invokeWithBackoff(params.messages, params.stage);
    try {
        const obj = extractTopLevelJsonObject(firstRaw);
        return { parsed: params.validate(obj), rawContent: firstRaw };
    } catch (parseErr) {
        // Bounded ONE schema-repair retry (with point-of-use privacy recheck!)
        const repairMessages: ChatMessage[] = [
            ...params.messages,
            { role: "assistant", content: firstRaw },
            {
                role: "user",
                content: `你刚才的输出未能通过 JSON/Schema 校验 (${parseErr instanceof Error ? parseErr.message : String(parseErr)})。`
                    + `请只输出一个完整合法的 JSON 对象，严格匹配以下格式，不要任何额外解释或截断：\n${params.schemaDescription}`,
            },
        ];
        const repairedRaw = await invokeWithBackoff(repairMessages, "repair");
        const obj = extractTopLevelJsonObject(repairedRaw);
        return { parsed: params.validate(obj), rawContent: repairedRaw };
    }
}

// ─── Stage 1: Clustering + Summarization ───

interface ClusteredTopicDraft {
    tempId: string;
    label: string;
    messages: HistoryMessageRow[];
    summary: string;
    keyPoints: string[];
    keywords: string[];
    sentiment: TopicNode["sentiment"];
}

async function clusterWindowResilient(params: {
    chatId: string;
    window: HistoryWindow;
    llmCall: HistoryLlmCallFn;
    clusterRouting: { profiles: LLMConfig[]; timeoutMs: number | undefined };
    summaryRouting: { profiles: LLMConfig[]; timeoutMs: number | undefined };
    sleepFn: HistorySleepFn;
    signal?: AbortSignal;
    beforeOutboundCall?: () => void;
}): Promise<{
    topics: Array<{
        historyKey: string;
        label: string;
        summary: string;
        keyPoints: string[];
        participants: string[];
        keywords: string[];
        messageIds: string[];
        startedAt: string;
        endedAt: string | null;
        sentiment: TopicNode["sentiment"];
    }>;
    coveredPairs: Array<{ messageId: string; topicHistoryKey: string }>;
}> {
    const drafts = await clusterMessagesSlice(
        params.window.messages,
        params.llmCall,
        params.clusterRouting,
        params.summaryRouting,
        params.sleepFn,
        params.signal,
        params.beforeOutboundCall,
    );

    const topics: Array<{
        historyKey: string;
        label: string;
        summary: string;
        keyPoints: string[];
        participants: string[];
        keywords: string[];
        messageIds: string[];
        startedAt: string;
        endedAt: string | null;
        sentiment: TopicNode["sentiment"];
    }> = [];
    const coveredPairs: Array<{ messageId: string; topicHistoryKey: string }> = [];

    for (const draft of drafts) {
        const sortedMsgs = [...draft.messages].sort((a, b) =>
            (a.timestampMs - b.timestampMs)
            || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0),
        );
        const messageIds = sortedMsgs.map(m => m.messageId);
        const participants = [...new Set(
            sortedMsgs
                .map(m => m.userId)
                .filter(uid => uid && uid !== "system"),
        )];
        const startedAt = sortedMsgs[0].timestamp;
        const endedAt = sortedMsgs[sortedMsgs.length - 1].timestamp;
        const keyDigest = createHash("sha256")
            .update(`${params.chatId}\n${messageIds.join(",")}`)
            .digest("hex")
            .slice(0, 24);
        const historyKey = `hist_topic:${keyDigest}`;

        topics.push({
            historyKey,
            label: draft.label,
            summary: draft.summary,
            keyPoints: draft.keyPoints,
            participants,
            keywords: draft.keywords,
            messageIds,
            startedAt,
            endedAt,
            sentiment: draft.sentiment,
        });

        for (const mid of messageIds) {
            coveredPairs.push({ messageId: mid, topicHistoryKey: historyKey });
        }
    }

    return { topics, coveredPairs };
}

async function clusterMessagesSlice(
    messages: readonly HistoryMessageRow[],
    llmCall: HistoryLlmCallFn,
    clusterRouting: { profiles: LLMConfig[]; timeoutMs: number | undefined },
    summaryRouting: { profiles: LLMConfig[]; timeoutMs: number | undefined },
    sleepFn: HistorySleepFn,
    signal?: AbortSignal,
    beforeOutboundCall?: () => void,
): Promise<ClusteredTopicDraft[]> {
    const clusterSystem = loadPromptFile("memory/history-cluster.md")?.trim() || FALLBACK_CLUSTER_PROMPT;
    const msgById = new Map(messages.map(m => [m.messageId, m]));

    let parsedTopics: ParsedClusterTopic[];
    try {
        const { parsed } = await callLlmWithRateLimitBackoff({
            messages: [
                { role: "system", content: clusterSystem },
                {
                    role: "user",
                    content: `请将以下按时间排序的 ${messages.length} 条历史消息切分为话题：\n\n${formatWindowMessagesForClusterPrompt(messages)}`,
                },
            ],
            caller: "history-cluster",
            profiles: clusterRouting.profiles,
            timeoutMs: clusterRouting.timeoutMs,
            stage: "cluster",
            llmCall,
            sleepFn,
            signal,
            beforeOutboundCall,
            schemaDescription: '{"topics":[{"tempId":"t1","label":"话题标签","messageIds":["msg_1"]}]}',
            validate: validateClusterResponse,
        });
        parsedTopics = parsed;
    } catch (err) {
        if (classifyHistoryLlmError(err) === "size_reducible" && messages.length > MIN_CLUSTER_SPLIT_MESSAGES) {
            const mid = Math.floor(messages.length / 2);
            log.warn("History cluster size-reducible failure, splitting chronologically", {
                total: messages.length,
                left: mid,
                right: messages.length - mid,
                error: err instanceof Error ? err.message : String(err),
            });
            const left = await clusterMessagesSlice(
                messages.slice(0, mid),
                llmCall,
                clusterRouting,
                summaryRouting,
                sleepFn,
                signal,
                beforeOutboundCall,
            );
            const right = await clusterMessagesSlice(
                messages.slice(mid),
                llmCall,
                clusterRouting,
                summaryRouting,
                sleepFn,
                signal,
                beforeOutboundCall,
            );
            return [...left, ...right];
        }
        throw err;
    }

    // Ground cluster assignments strictly against messages in this slice (each message at most once)
    const assignedIds = new Set<string>();
    const rawDrafts: Array<{ tempId: string; label: string; messages: HistoryMessageRow[] }> = [];

    for (let i = 0; i < parsedTopics.length; i++) {
        const pt = parsedTopics[i];
        const topicMsgs: HistoryMessageRow[] = [];
        for (const mid of pt.messageIds) {
            if (assignedIds.has(mid)) continue;
            const msg = msgById.get(mid);
            if (!msg) continue;
            assignedIds.add(mid);
            topicMsgs.push(msg);
        }
        if (topicMsgs.length === 0) continue;
        rawDrafts.push({
            tempId: `t_${rawDrafts.length + 1}`,
            label: pt.label,
            messages: topicMsgs,
        });
    }

    const unassigned = messages.filter(m => !assignedIds.has(m.messageId));
    if (unassigned.length > 0) {
        rawDrafts.push({
            tempId: `t_fallback_${rawDrafts.length + 1}`,
            label: "其他讨论",
            messages: unassigned,
        });
    }

    // Step 1b: Summarize clustered topics (NO shouldSignal / live triage)
    return summarizeClusterDraftsResilient(rawDrafts, llmCall, summaryRouting, sleepFn, signal, beforeOutboundCall);
}

function mergeSentiment(a: TopicNode["sentiment"], b: TopicNode["sentiment"]): TopicNode["sentiment"] {
    if (a === b) return a;
    return "mixed";
}

async function summarizeSingleTopicChunked(
    draft: { tempId: string; label: string; messages: HistoryMessageRow[] },
    llmCall: HistoryLlmCallFn,
    summaryRouting: { profiles: LLMConfig[]; timeoutMs: number | undefined },
    sleepFn: HistorySleepFn,
    signal?: AbortSignal,
    beforeOutboundCall?: () => void,
): Promise<ClusteredTopicDraft> {
    const summarySystem = loadPromptFile("memory/history-topic-summary.md")?.trim() || FALLBACK_SUMMARY_PROMPT;
    const topicsPrompt = `### 话题 ${draft.tempId}: ${draft.label}\n${formatWindowMessagesForClusterPrompt(draft.messages)}`;
    try {
        const { parsed } = await callLlmWithRateLimitBackoff({
            messages: [
                { role: "system", content: summarySystem },
                { role: "user", content: `请对以下 1 个历史话题生成摘要与元数据：\n\n${topicsPrompt}` },
            ],
            caller: "history-topic-summary",
            profiles: summaryRouting.profiles,
            timeoutMs: summaryRouting.timeoutMs,
            stage: "summary",
            llmCall,
            sleepFn,
            signal,
            beforeOutboundCall,
            schemaDescription: '{"summaries":[{"tempId":"t_1","label":"标签","summary":"摘要","keyPoints":["要点"],"keywords":["关键词"],"sentiment":"neutral"}]}',
            validate: (obj) => validateSummaryResponse(obj, [draft.tempId]),
        });
        const entry = parsed.get(draft.tempId)!;
        return {
            tempId: draft.tempId,
            label: entry.label || draft.label,
            messages: draft.messages,
            summary: entry.summary,
            keyPoints: entry.keyPoints,
            keywords: entry.keywords,
            sentiment: entry.sentiment,
        };
    } catch (err) {
        if (classifyHistoryLlmError(err) === "size_reducible" && draft.messages.length > 1) {
            const mid = Math.floor(draft.messages.length / 2);
            log.warn("Single oversized topic summary size-reducible failure, chunking messages", {
                tempId: draft.tempId,
                total: draft.messages.length,
                left: mid,
                right: draft.messages.length - mid,
            });
            const left = await summarizeSingleTopicChunked(
                { tempId: `${draft.tempId}_a`, label: draft.label, messages: draft.messages.slice(0, mid) },
                llmCall,
                summaryRouting,
                sleepFn,
                signal,
                beforeOutboundCall,
            );
            const right = await summarizeSingleTopicChunked(
                { tempId: `${draft.tempId}_b`, label: draft.label, messages: draft.messages.slice(mid) },
                llmCall,
                summaryRouting,
                sleepFn,
                signal,
                beforeOutboundCall,
            );
            return {
                tempId: draft.tempId,
                label: left.label || right.label || draft.label,
                messages: draft.messages,
                summary: [left.summary, right.summary].filter(Boolean).join(" ").slice(0, 800),
                keyPoints: [...new Set([...left.keyPoints, ...right.keyPoints])].slice(0, 6),
                keywords: [...new Set([...left.keywords, ...right.keywords])].slice(0, 8),
                sentiment: mergeSentiment(left.sentiment, right.sentiment),
            };
        }
        throw err;
    }
}

async function summarizeClusterDraftsResilient(
    drafts: Array<{ tempId: string; label: string; messages: HistoryMessageRow[] }>,
    llmCall: HistoryLlmCallFn,
    summaryRouting: { profiles: LLMConfig[]; timeoutMs: number | undefined },
    sleepFn: HistorySleepFn,
    signal?: AbortSignal,
    beforeOutboundCall?: () => void,
): Promise<ClusteredTopicDraft[]> {
    if (drafts.length === 0) return [];
    if (drafts.length === 1) {
        const single = await summarizeSingleTopicChunked(
            drafts[0],
            llmCall,
            summaryRouting,
            sleepFn,
            signal,
            beforeOutboundCall,
        );
        return [single];
    }

    const summarySystem = loadPromptFile("memory/history-topic-summary.md")?.trim() || FALLBACK_SUMMARY_PROMPT;
    const topicsPrompt = drafts.map(d =>
        `### 话题 ${d.tempId}: ${d.label}\n${formatWindowMessagesForClusterPrompt(d.messages)}`,
    ).join("\n\n");
    const expectedIds = drafts.map(d => d.tempId);

    let summaryMap: Map<string, ParsedSummaryEntry>;
    try {
        const { parsed } = await callLlmWithRateLimitBackoff({
            messages: [
                { role: "system", content: summarySystem },
                { role: "user", content: `请对以下 ${drafts.length} 个历史话题生成摘要与元数据：\n\n${topicsPrompt}` },
            ],
            caller: "history-topic-summary",
            profiles: summaryRouting.profiles,
            timeoutMs: summaryRouting.timeoutMs,
            stage: "summary",
            llmCall,
            sleepFn,
            signal,
            beforeOutboundCall,
            schemaDescription: '{"summaries":[{"tempId":"t_1","label":"标签","summary":"摘要","keyPoints":["要点"],"keywords":["关键词"],"sentiment":"neutral"}]}',
            validate: (obj) => validateSummaryResponse(obj, expectedIds),
        });
        summaryMap = parsed;
    } catch (err) {
        if (classifyHistoryLlmError(err) === "size_reducible") {
            const mid = Math.floor(drafts.length / 2);
            const left = await summarizeClusterDraftsResilient(
                drafts.slice(0, mid),
                llmCall,
                summaryRouting,
                sleepFn,
                signal,
                beforeOutboundCall,
            );
            const right = await summarizeClusterDraftsResilient(
                drafts.slice(mid),
                llmCall,
                summaryRouting,
                sleepFn,
                signal,
                beforeOutboundCall,
            );
            return [...left, ...right];
        }
        throw err;
    }

    return drafts.map(d => {
        const entry = summaryMap.get(d.tempId)!;
        return {
            tempId: d.tempId,
            label: entry.label || d.label,
            messages: d.messages,
            summary: entry.summary,
            keyPoints: entry.keyPoints,
            keywords: entry.keywords,
            sentiment: entry.sentiment,
        };
    });
}

// ─── Stage 2: Social Memory Synthesis ───

interface SynthesisUnitOutput {
    groupPatch: HistorySynthesisGroupPatch;
    groupPatchCitations: HistorySynthesisCitation[];
    memberPatches: HistorySynthesisMemberPatch[];
    factProposals: HistorySynthesisFactProposal[];
    expectedEvidence: Array<{ topicId: string; sampledMessageIds: string[]; evidenceDigest: string }>;
}

const BOT_RELATIONSHIP_CLAIM_RE = /(?:与|和|跟)\s*(?:ai助手|bot|ai|机器人|助手|我)\s*(?:很熟|非常熟|关系很?好|是好?友|是死党|是闺蜜|是挚友|认识很久|私交|聊过很多)|(?:ai助手|bot|ai|机器人|助手)\s*的\s*(?:好友|朋友|死党|挚友|闺蜜|老熟人)|(?:relationToAgent|dunbarTier|affinityScore)/i;
const SARCASTIC_BANTER_CLAIM_RE = /(?:是|真[是的]|简直是|外号叫|自称)\s*(?:个|一位|大)?\s*(?:现充|闲虫|女装大佬|男娘|富婆|海王|舔狗|0\b)|(?:反讽|玩梗|起外号|你是\s*猫)/i;
const PERSONAL_BIOGRAPHY_CLAIM_RE = /(?:今年\s*\d+\s*岁|毕业于|就职于|在.{1,20}(?:公司|大学|学校|医院)?(?:工作|上班|上学|读书)|是.{1,15}(?:工程师|程序员|医生|老师|学生|老板)|家住|真名叫|身份证|手机号|住在.{1,20}(?:市|区|省)|已婚|离异|月薪|年薪)/i;

function isDisallowedSynthesisClaim(
    text: string,
    kind: "trait" | "interest" | "style" | "episode" | "observation",
): boolean {
    if (!text) return true;
    if (BOT_RELATIONSHIP_CLAIM_RE.test(text)) return true;
    if (kind !== "interest" && SARCASTIC_BANTER_CLAIM_RE.test(text)) {
        return true;
    }
    if (kind === "observation" && PERSONAL_BIOGRAPHY_CLAIM_RE.test(text)) {
        return true;
    }
    return false;
}

function buildSynthesisPromptText(
    chatId: string,
    batch: SynthesisMacroBatch,
    topicBlocks: readonly SynthesisTopicBlock[],
    memory: MemoryStoreV2,
): string {
    const groupModel = memory.getGroupCultureModel?.(chatId) ?? memory.getGroupModel(getGroupModelKey(chatId));
    const userInstruction = loadPromptFile("memory/history-synthesis-user.md")?.trim() || FALLBACK_SYNTHESIS_USER_PROMPT;

    const headerLines = [
        `## 群组基础信息`,
        `- chatId: ${chatId}`,
        `- 群名: ${groupModel?.chatTitle || chatId}`,
        `- 周期: ${batch.isoWeek}`,
        `- 话题数量: ${topicBlocks.length}`,
    ];

    const topicSections = topicBlocks.map((block, idx) => {
        const msgLines = block.sampledMessages.map(m => {
            const reply = m.replyToMessageId ? ` [replyTo:${m.replyToMessageId}]` : "";
            const mentions = m.mentionsText ? ` [提及: ${m.mentionsText}]` : "";
            return `  [${m.messageId}] (${m.timestamp}) ${m.displayName} [${m.userId}]${reply}${mentions}: ${m.text}`;
        }).join("\n");

        return [
            `### 话题 ${idx + 1}: ${block.topic.label}`,
            `- topicId: ${block.topic.id}`,
            `- 时间: ${block.topic.startedAt} ~ ${block.topic.endedAt ?? ""}`,
            `- 摘要: ${block.topic.summary || "(无)"}`,
            `- 参与者: ${[...block.eligibleParticipants].join(", ")}`,
            `- 采样消息 (${block.sampledMessages.length}/${block.topic.messageRange.count} 条):`,
            msgLines,
        ].join("\n");
    }).join("\n\n---\n\n");

    return [
        headerLines.join("\n"),
        `## 历史话题与采样消息\n\n${topicSections}`,
        `## 任务与输出格式\n\n${userInstruction}`,
    ].join("\n\n---\n\n");
}

function groundSynthesisOutput(
    chatId: string,
    raw: ValidatedSynthesisRaw,
    topicBlocks: readonly SynthesisTopicBlock[],
): SynthesisUnitOutput {
    const blockByTopicId = new Map<string, SynthesisTopicBlock>(
        topicBlocks.map(b => [b.topic.id, b]),
    );
    const allEligibleParticipants = new Set<string>();
    const messageTimestampByTopicAndId = new Map<string, string>();
    const messageAuthorByTopicAndId = new Map<string, string>();

    for (const block of topicBlocks) {
        for (const uid of block.eligibleParticipants) {
            allEligibleParticipants.add(uid);
        }
        for (const msg of block.sampledMessages) {
            const key = `${block.topic.id}\n${msg.messageId}`;
            messageTimestampByTopicAndId.set(key, msg.timestamp);
            messageAuthorByTopicAndId.set(key, msg.userId);
        }
    }

    // Strict citation validator: rejects the ENTIRE claim if ANY cited messageId is invalid or missing!
    // When requiredUserId is supplied, requires at least one cited message authored BY requiredUserId.
    const validateCitation = (
        topicIdRaw: unknown,
        messageIdsRaw: unknown,
        requiredUserId?: string,
    ): { topicId: string; block: SynthesisTopicBlock; validMsgIds: string[]; observedAt: string } | null => {
        if (typeof topicIdRaw !== "string" || !topicIdRaw.trim()) return null;
        const topicId = topicIdRaw.trim();
        const block = blockByTopicId.get(topicId);
        if (!block) return null;
        if (!Array.isArray(messageIdsRaw) || messageIdsRaw.length === 0) return null;

        const validMsgIds: string[] = [];
        const seen = new Set<string>();
        let hasRequiredSpeakerMsg = requiredUserId === undefined;

        for (const mid of messageIdsRaw) {
            if (typeof mid !== "string") return null;
            const clean = mid.trim();
            if (!clean || !block.eligibleMessageIds.has(clean)) {
                return null;
            }
            if (requiredUserId !== undefined && messageAuthorByTopicAndId.get(`${topicId}\n${clean}`) === requiredUserId) {
                hasRequiredSpeakerMsg = true;
            }
            if (!seen.has(clean)) {
                seen.add(clean);
                validMsgIds.push(clean);
            }
        }
        if (validMsgIds.length === 0 || !hasRequiredSpeakerMsg) return null;

        const latestMsgId = validMsgIds[validMsgIds.length - 1];
        const observedAt = messageTimestampByTopicAndId.get(`${topicId}\n${latestMsgId}`)
            ?? block.topic.startedAt;

        return { topicId, block, validMsgIds, observedAt };
    };

    // 1. Group patch (strict allowlist + citation grounding; agentRole always code-chosen; never touch lastReflectedAt)
    const gu = raw.groupUpdates ?? {};
    const groupPatch: HistorySynthesisGroupPatch = {
        agentRole: NEWCOMER_AGENT_ROLE,
    };
    const groupPatchCitations: HistorySynthesisCitation[] = [];

    let batchGroupEvidenceValid = false;
    if (Array.isArray(gu.evidence) && gu.evidence.length > 0) {
        let allValid = true;
        const collected: HistorySynthesisCitation[] = [];
        for (const ev of gu.evidence) {
            if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
                allValid = false;
                break;
            }
            const er = ev as Record<string, unknown>;
            const cited = validateCitation(er.topicId, er.messageIds);
            if (!cited) {
                allValid = false;
                break;
            }
            collected.push({ topicId: cited.topicId, messageIds: cited.validMsgIds });
        }
        if (allValid && collected.length > 0) {
            batchGroupEvidenceValid = true;
            groupPatchCitations.push(...collected);
        }
    }

    const extractCitedGroupScalar = (rawField: unknown): string | undefined => {
        if (typeof rawField === "string") {
            const trimmed = rawField.trim();
            return trimmed && batchGroupEvidenceValid ? trimmed : undefined;
        }
        if (rawField && typeof rawField === "object" && !Array.isArray(rawField)) {
            const rec = rawField as Record<string, unknown>;
            if (typeof rec.value !== "string" || !rec.value.trim()) return undefined;
            const cited = validateCitation(rec.topicId, rec.messageIds);
            if (!cited) return undefined;
            groupPatchCitations.push({ topicId: cited.topicId, messageIds: cited.validMsgIds });
            return rec.value.trim();
        }
        return undefined;
    };

    const extractCitedGroupList = (rawField: unknown): string[] | undefined => {
        if (Array.isArray(rawField)) {
            if (!batchGroupEvidenceValid) return undefined;
            const items = rawField
                .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
                .map(s => s.trim());
            return items.length > 0 ? items : undefined;
        }
        if (rawField && typeof rawField === "object" && !Array.isArray(rawField)) {
            const rec = rawField as Record<string, unknown>;
            if (!Array.isArray(rec.value)) return undefined;
            const cited = validateCitation(rec.topicId, rec.messageIds);
            if (!cited) return undefined;
            const items = rec.value
                .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
                .map(s => s.trim());
            if (items.length === 0) return undefined;
            groupPatchCitations.push({ topicId: cited.topicId, messageIds: cited.validMsgIds });
            return items;
        }
        return undefined;
    };

    const desc = extractCitedGroupScalar(gu.description);
    if (desc && !isDisallowedSynthesisClaim(desc, "observation")) {
        groupPatch.description = desc;
    }
    const lang = extractCitedGroupScalar(gu.dominantLanguage);
    if (lang) {
        groupPatch.dominantLanguage = lang;
    }
    const eng = extractCitedGroupScalar(gu.engagementLevel);
    if (eng === "high" || eng === "medium" || eng === "low") {
        groupPatch.engagementLevel = eng;
    }
    const norms = extractCitedGroupList(gu.communicationNorms);
    if (norms) {
        groupPatch.communicationNorms = norms;
    }
    const hot = extractCitedGroupList(gu.hotTopics);
    if (hot) {
        groupPatch.hotTopics = hot;
    }
    const taboo = extractCitedGroupList(gu.tabooTopics);
    if (taboo) {
        groupPatch.tabooTopics = taboo;
    }

    // 2. Member patches (strict allowlist + firsthand speaker citation grounding + irony/bot guard)
    const memberPatchesByUser = new Map<string, HistorySynthesisMemberPatch>();
    for (const item of raw.memberProfiles) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.userId !== "string" || !rec.userId.trim()) continue;
        const userId = rec.userId.trim();
        if (!allEligibleParticipants.has(userId)) continue;

        const traits: string[] = [];
        if (Array.isArray(rec.traits)) {
            for (const t of rec.traits) {
                if (!t || typeof t !== "object" || Array.isArray(t)) continue;
                const tr = t as Record<string, unknown>;
                if (typeof tr.value !== "string" || !tr.value.trim()) continue;
                const val = tr.value.trim();
                if (isDisallowedSynthesisClaim(val, "trait")) continue;
                const cited = validateCitation(tr.topicId, tr.messageIds, userId);
                if (!cited) continue;
                traits.push(val);
            }
        }

        const interests: string[] = [];
        if (Array.isArray(rec.interests)) {
            for (const it of rec.interests) {
                if (!it || typeof it !== "object" || Array.isArray(it)) continue;
                const ir = it as Record<string, unknown>;
                if (typeof ir.value !== "string" || !ir.value.trim()) continue;
                const val = ir.value.trim();
                if (isDisallowedSynthesisClaim(val, "interest")) continue;
                const cited = validateCitation(ir.topicId, ir.messageIds, userId);
                if (!cited) continue;
                interests.push(val);
            }
        }

        let communicationStyle: string | undefined;
        if (rec.communicationStyle && typeof rec.communicationStyle === "object" && !Array.isArray(rec.communicationStyle)) {
            const sr = rec.communicationStyle as Record<string, unknown>;
            if (typeof sr.value === "string" && sr.value.trim()) {
                const val = sr.value.trim();
                if (!isDisallowedSynthesisClaim(val, "style")) {
                    const cited = validateCitation(sr.topicId, sr.messageIds, userId);
                    if (cited) {
                        communicationStyle = val;
                    }
                }
            }
        }

        const episodes: HistorySynthesisEpisodeInput[] = [];
        if (Array.isArray(rec.episodes)) {
            for (const ep of rec.episodes) {
                if (!ep || typeof ep !== "object" || Array.isArray(ep)) continue;
                const er = ep as Record<string, unknown>;
                if (typeof er.summary !== "string" || !er.summary.trim()) continue;
                const summary = er.summary.trim();
                if (isDisallowedSynthesisClaim(summary, "episode")) continue;
                const cited = validateCitation(er.topicId, er.messageIds, userId);
                if (!cited) continue;
                const epSentiment: HistorySynthesisEpisodeInput["sentiment"] =
                    er.sentiment === "positive" || er.sentiment === "negative" ? er.sentiment : "neutral";
                const rawSig = typeof er.significance === "number" && Number.isFinite(er.significance) ? er.significance : 3;
                const significance = rawSig > 1 ? Math.min(1, Math.max(0.1, rawSig / 5)) : Math.min(1, Math.max(0, rawSig));
                const epIdDigest = createHash("sha256")
                    .update(`${chatId}\n${userId}\n${cited.topicId}\n${cited.validMsgIds.join(",")}\n${summary}`)
                    .digest("hex")
                    .slice(0, 20);
                episodes.push({
                    id: `hist_ep:${epIdDigest}`,
                    date: cited.observedAt,
                    topicId: cited.topicId,
                    topicLabel: cited.block.topic.label,
                    summary,
                    sentiment: epSentiment,
                    significance,
                    messageIds: cited.validMsgIds,
                });
            }
        }

        if (traits.length > 0 || interests.length > 0 || communicationStyle || episodes.length > 0) {
            const existing = memberPatchesByUser.get(userId);
            if (existing) {
                existing.traits = [...(existing.traits ?? []), ...traits];
                existing.interests = [...(existing.interests ?? []), ...interests];
                if (communicationStyle && !existing.communicationStyle) {
                    existing.communicationStyle = communicationStyle;
                }
                existing.episodes = [...(existing.episodes ?? []), ...episodes];
            } else {
                memberPatchesByUser.set(userId, {
                    userId,
                    traits,
                    interests,
                    communicationStyle,
                    episodes,
                });
            }
        }
    }

    // 3. Memes -> category: 'anecdote', subject: 'group:<chatId>' (requires non-empty meaning + usageBoundaries)
    //    GroupObservations -> category: 'general', subject: 'group:<chatId>'
    //    Explicitly ignore/reject any personalClaims or biographical facts!
    const factProposals: HistorySynthesisFactProposal[] = [];
    const groupSubject = `group:${chatId}`;

    for (const item of raw.memes) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        const term = typeof rec.term === "string" ? rec.term.trim() : "";
        const meaning = typeof rec.meaning === "string" ? rec.meaning.trim() : "";
        const usageBoundaries = typeof rec.usageBoundaries === "string" ? rec.usageBoundaries.trim() : "";
        if (!term || !meaning || !usageBoundaries) continue;

        const cited = validateCitation(rec.topicId, rec.messageIds);
        if (!cited) continue;

        const originContext = typeof rec.originContext === "string" ? rec.originContext.trim() : "";
        const participants = Array.isArray(rec.participants)
            ? rec.participants
                .filter((p): p is string => typeof p === "string" && cited.block.eligibleParticipants.has(p.trim()))
                .map(p => p.trim())
            : [];
        const canonical = typeof rec.canonicalKey === "string" && rec.canonicalKey.trim()
            ? rec.canonicalKey.trim()
            : term;
        const historyKey = `hist_meme:${createHash("sha256").update(`${chatId}\n${canonical}`).digest("hex").slice(0, 24)}`;

        const contentParts = [
            `[群梗: ${term}]`,
            `真实含义: ${meaning}`,
            originContext ? `来源背景: ${originContext}` : "",
            participants.length > 0 ? `相关成员: ${[...new Set(participants)].join(", ")}` : "",
            `使用边界: ${usageBoundaries}`,
        ].filter(Boolean);

        factProposals.push({
            historyKey,
            subject: groupSubject,
            content: contentParts.join("；"),
            category: "anecdote",
            confidence: 0.85,
            sourceTopicId: cited.topicId,
            sourceTopicLabel: cited.block.topic.label,
            sourceMessageIds: cited.validMsgIds,
            observedAt: cited.observedAt,
            sensitivity: "low",
        });
    }

    for (const item of raw.groupObservations) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        const content = typeof rec.content === "string" ? rec.content.trim() : "";
        if (!content) continue;
        if (isDisallowedSynthesisClaim(content, "observation")) continue;

        const cited = validateCitation(rec.topicId, rec.messageIds);
        if (!cited) continue;

        const canonical = typeof rec.canonicalKey === "string" && rec.canonicalKey.trim()
            ? rec.canonicalKey.trim()
            : content;
        const historyKey = `hist_obs:${createHash("sha256").update(`${chatId}\n${canonical}`).digest("hex").slice(0, 24)}`;

        factProposals.push({
            historyKey,
            subject: groupSubject,
            content,
            category: "general",
            confidence: 0.8,
            sourceTopicId: cited.topicId,
            sourceTopicLabel: cited.block.topic.label,
            sourceMessageIds: cited.validMsgIds,
            observedAt: cited.observedAt,
            sensitivity: "low",
        });
    }

    const expectedEvidence = topicBlocks.map(b => ({
        topicId: b.topic.id,
        sampledMessageIds: b.sampledRawMessages.map(m => m.messageId),
        evidenceDigest: b.evidenceDigest,
    }));

    return {
        groupPatch,
        groupPatchCitations,
        memberPatches: [...memberPatchesByUser.values()],
        factProposals,
        expectedEvidence,
    };
}

function mergeSynthesisOutputs(left: SynthesisUnitOutput, right: SynthesisUnitOutput): SynthesisUnitOutput {
    const dedupe = (a?: string[], b?: string[]): string[] | undefined => {
        const merged = [...new Set([...(a ?? []), ...(b ?? [])])];
        return merged.length > 0 ? merged : undefined;
    };

    const groupPatch: HistorySynthesisGroupPatch = {
        agentRole: NEWCOMER_AGENT_ROLE,
        description: right.groupPatch.description ?? left.groupPatch.description,
        dominantLanguage: right.groupPatch.dominantLanguage ?? left.groupPatch.dominantLanguage,
        engagementLevel: right.groupPatch.engagementLevel ?? left.groupPatch.engagementLevel,
        communicationNorms: dedupe(left.groupPatch.communicationNorms, right.groupPatch.communicationNorms),
        hotTopics: dedupe(left.groupPatch.hotTopics, right.groupPatch.hotTopics),
        tabooTopics: dedupe(left.groupPatch.tabooTopics, right.groupPatch.tabooTopics),
    };

    const memberMap = new Map<string, HistorySynthesisMemberPatch>();
    for (const mp of [...left.memberPatches, ...right.memberPatches]) {
        const existing = memberMap.get(mp.userId);
        if (!existing) {
            memberMap.set(mp.userId, { ...mp });
        } else {
            existing.traits = [...new Set([...(existing.traits ?? []), ...(mp.traits ?? [])])];
            existing.interests = [...new Set([...(existing.interests ?? []), ...(mp.interests ?? [])])];
            existing.communicationStyle = mp.communicationStyle ?? existing.communicationStyle;
            existing.episodes = [...(existing.episodes ?? []), ...(mp.episodes ?? [])];
        }
    }

    const factMap = new Map<string, HistorySynthesisFactProposal>();
    for (const f of [...left.factProposals, ...right.factProposals]) {
        factMap.set(f.historyKey, f);
    }

    const evMap = new Map<string, { topicId: string; sampledMessageIds: string[]; evidenceDigest: string }>();
    for (const ev of [...left.expectedEvidence, ...right.expectedEvidence]) {
        evMap.set(ev.topicId, ev);
    }

    return {
        groupPatch,
        groupPatchCitations: [...left.groupPatchCitations, ...right.groupPatchCitations],
        memberPatches: [...memberMap.values()],
        factProposals: [...factMap.values()],
        expectedEvidence: [...evMap.values()],
    };
}

async function synthesizeBatchResilient(params: {
    chatId: string;
    batch: SynthesisMacroBatch;
    memory: MemoryStoreV2;
    llmCall: HistoryLlmCallFn;
    synthesisRouting: { profiles: LLMConfig[]; timeoutMs: number | undefined };
    sleepFn: HistorySleepFn;
    signal?: AbortSignal;
    beforeOutboundCall?: () => void;
}): Promise<SynthesisUnitOutput> {
    const synthesisSystem = loadPromptFile("memory/history-synthesis-system.md")?.trim() || FALLBACK_SYNTHESIS_SYSTEM_PROMPT;

    const runSlice = async (blocks: readonly SynthesisTopicBlock[], sampleStepIdx: number): Promise<SynthesisUnitOutput> => {
        const sampleLimit = SYNTHESIS_SAMPLE_STEPS[sampleStepIdx];
        // Resample directly from the block's validated in-memory topic snapshot (zero full-chat reloads!)
        const effectiveBlocks: SynthesisTopicBlock[] = sampleStepIdx === 0
            ? [...blocks]
            : blocks.map(b => buildSynthesisTopicBlock(
                b.topic,
                b.allTopicMessages,
                params.memory,
                params.chatId,
                sampleLimit,
            ));

        const prompt = buildSynthesisPromptText(params.chatId, params.batch, effectiveBlocks, params.memory);
        try {
            const { parsed } = await callLlmWithRateLimitBackoff({
                messages: [
                    { role: "system", content: synthesisSystem },
                    { role: "user", content: prompt },
                ],
                caller: "history-synthesis",
                profiles: params.synthesisRouting.profiles,
                timeoutMs: params.synthesisRouting.timeoutMs,
                stage: "synthesis",
                llmCall: params.llmCall,
                sleepFn: params.sleepFn,
                signal: params.signal,
                beforeOutboundCall: params.beforeOutboundCall,
                schemaDescription: '{"groupUpdates":{"evidence":[]},"memberProfiles":[],"memes":[],"groupObservations":[]}',
                validate: validateSynthesisResponse,
            });
            return groundSynthesisOutput(params.chatId, parsed, effectiveBlocks);
        } catch (err) {
            if (classifyHistoryLlmError(err) === "size_reducible") {
                if (blocks.length > 1) {
                    const mid = Math.floor(blocks.length / 2);
                    log.warn("History synthesis size-reducible failure, splitting topic batch chronologically", {
                        topics: blocks.length,
                        left: mid,
                        right: blocks.length - mid,
                    });
                    const left = await runSlice(blocks.slice(0, mid), sampleStepIdx);
                    const right = await runSlice(blocks.slice(mid), sampleStepIdx);
                    return mergeSynthesisOutputs(left, right);
                }
                if (sampleStepIdx + 1 < SYNTHESIS_SAMPLE_STEPS.length) {
                    log.warn("History synthesis shrinking sample messages per topic", {
                        topicId: blocks[0]?.topic.id,
                        from: SYNTHESIS_SAMPLE_STEPS[sampleStepIdx],
                        to: SYNTHESIS_SAMPLE_STEPS[sampleStepIdx + 1],
                    });
                    return runSlice(blocks, sampleStepIdx + 1);
                }
            }
            throw err;
        }
    };

    return runSlice(params.batch.topicBlocks, 0);
}

// ─── Stage 3: Checkpointed Embedding Stage ───

async function runCheckpointedEmbedStage(params: {
    jobId: string;
    ownerToken: string;
    chatId: string;
    memory: MemoryStoreV2;
    embeddingCfg: EmbeddingConfig;
    embedFn: HistoryEmbedFn;
    signal?: AbortSignal;
    sinceMs?: number;
    untilMs?: number;
    maxUnits?: number;
    beforeOutboundCall?: () => void;
}): Promise<{ embeddedTopics: number; embeddedFacts: number; remainingEmbedUnits: number }> {
    const targets = params.memory.getUnembeddedHistoryTargets(params.chatId, {
        sinceMs: params.sinceMs,
        untilMs: params.untilMs,
    });

    const units: Array<{
        unitKey: string;
        ordinal: number;
        inputJson: string;
        kind: "topic" | "fact";
        id: string;
        text: string;
        contentHash: string;
    }> = [];

    let ord = 0;
    for (const t of targets.topics) {
        units.push({
            unitKey: `embed:topic:${t.id}`,
            ordinal: ord++,
            inputJson: JSON.stringify({ kind: "topic", id: t.id }),
            kind: "topic",
            id: t.id,
            text: t.text,
            contentHash: computeEmbeddingContentHash(t.text),
        });
    }
    for (const f of targets.facts) {
        units.push({
            unitKey: `embed:fact:${f.id}`,
            ordinal: ord++,
            inputJson: JSON.stringify({ kind: "fact", id: f.id }),
            kind: "fact",
            id: f.id,
            text: f.text,
            contentHash: computeEmbeddingContentHash(f.text),
        });
    }

    if (units.length === 0) {
        return { embeddedTopics: 0, embeddedFacts: 0, remainingEmbedUnits: 0 };
    }

    params.memory.upsertHistoryUnits(
        params.jobId,
        "embed",
        units.map(u => ({ unitKey: u.unitKey, ordinal: u.ordinal, inputJson: u.inputJson })),
        params.ownerToken,
    );
    const storedUnits = params.memory.listHistoryUnits(params.jobId, "embed");
    const completedKeys = new Set(storedUnits.filter(u => u.completedAt !== null).map(u => u.unitKey));
    const pendingUnits = units.filter(u => !completedKeys.has(u.unitKey));

    const toProcess = params.maxUnits !== undefined
        ? pendingUnits.slice(0, params.maxUnits)
        : pendingUnits;
    const remainingEmbedUnits = pendingUnits.length - toProcess.length;

    let embeddedTopics = 0;
    let embeddedFacts = 0;
    const expectedDims = params.embeddingCfg.dimensions ?? 128;

    for (const u of toProcess) {
        if (params.signal?.aborted) {
            throw params.signal.reason instanceof Error ? params.signal.reason : createAbortError();
        }
        params.beforeOutboundCall?.();

        const rawVec = await params.embedFn(u.text, params.embeddingCfg, params.signal);
        const vec = rawVec instanceof Float32Array ? rawVec : new Float32Array(rawVec);
        if (vec.length === 0 || (expectedDims > 0 && vec.length !== expectedDims)) {
            throw new Error(
                `Invalid embedding dimensions for ${u.unitKey}: expected ${expectedDims}, got ${vec.length}`,
            );
        }
        for (let i = 0; i < vec.length; i++) {
            if (!Number.isFinite(vec[i])) {
                throw new Error(`Non-finite embedding value at index ${i} for ${u.unitKey}`);
            }
        }

        params.memory.commitHistoricalEmbeddingUnit({
            jobId: params.jobId,
            ownerToken: params.ownerToken,
            chatId: params.chatId,
            unitKey: u.unitKey,
            kind: u.kind,
            targetId: u.id,
            expectedContentHash: u.contentHash,
            expectedDimensions: expectedDims,
            embedding: vec,
            outputJson: JSON.stringify({ kind: u.kind, id: u.id, dims: vec.length }),
        });

        if (u.kind === "topic") embeddedTopics++;
        else embeddedFacts++;
    }

    return { embeddedTopics, embeddedFacts, remainingEmbedUnits };
}
