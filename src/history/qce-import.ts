import { createHash } from "node:crypto";
import fs from "node:fs";
import { getGroupModelKey } from "../core/chat-id.js";
import { loadConfig, type ChatFilterConfig } from "../core/config.js";
import { shouldDropInbound } from "../core/inbound-filter.js";
import { getGlobalTimezone } from "../core/timezone.js";
import { userGate } from "../adapter/user-gate.js";
import type { IngestMessage } from "../memory-v2/history-store.js";
import type { MemoryStoreV2 } from "../memory-v2/memory-v2.js";
import { HistoryUsageError } from "./errors.js";
import {
    normalizeQceMessage,
    normalizeSelfIdOption,
    resolveQceChatTarget,
    type QceNormalizedMessage,
} from "./qce-normalize.js";
import {
    stageQceExport,
    type QceExportFormat,
    type QceMalformedLineWarning,
    type QceUidResolutionStats,
    type StagedQceExport,
} from "./qce-reader.js";
import { openSqliteReadOnlyStrict, type StrictReadOnlyDb } from "./sqlite-readonly.js";
import { assertValidIanaTimezone, parseStrictTimestampMs } from "./time-utils.js";

export interface QceImportOptions {
    dbPath?: string;
    chatId?: string;
    selfId?: string;
    userMapPath?: string;
    includeSystem?: boolean;
    includeRecalled?: boolean;
    timezone?: string;
    since?: string;
    until?: string;
    dryRun?: boolean;
    resume?: boolean;
    batchSize?: number;
    batchMaxBytes?: number;
    chatFilter?: ChatFilterConfig;
    userGateBlocked?: (userId: string) => boolean;
    /** Set by the entrypoints once the timezone has been resolved; not a caller option. */
    timezoneIsFallback?: boolean;
}

export interface QceImportSummary {
    dryRun: boolean;
    format: QceExportFormat;
    chatId: string;
    chatTitle: string;
    isDirectMessage: boolean;
    isOpaquePeerChat: boolean;
    inputKey: string;
    totalMessages: number;
    eligibleMessages: number;
    inserted: number;
    duplicates: number;
    conflicts: number;
    skippedByFilter: number;
    skippedInvalid: number;
    skippedSystem: number;
    skippedRecalled: number;
    skippedDateRange: number;
    malformedLineCount: number;
    malformedLines: QceMalformedLineWarning[];
    warnings: string[];
    dateRange: {
        earliest: string | null;
        latest: string | null;
        unknownTimeCount: number;
    };
    uniqueSenders: number;
    uidResolution: QceUidResolutionStats;
    /** Timezone used for active-hour stats and zone-less --since/--until bounds. */
    timezone: string;
    resumedFromOrdinal?: number;
}

interface ExistingMessageSnapshot {
    userId: string;
    timestamp: string;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_BATCH_MAX_BYTES = 4 * 1024 * 1024;
const NORMALIZATION_VERSION = "qce-v3";

function createAbortError(): Error {
    const err = new Error("QCE import aborted");
    err.name = "AbortError";
    return err;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
}

function resolveImportTimezone(options: QceImportOptions): { timezone: string; isFallback: boolean } {
    let configTz: string | undefined;
    try {
        configTz = loadConfig().timezone;
    } catch {
        configTz = undefined;
    }
    const chosen = options.timezone ?? configTz ?? getGlobalTimezone();
    return {
        timezone: assertValidIanaTimezone(chosen ?? "UTC"),
        isFallback: options.timezoneIsFallback ?? chosen === undefined,
    };
}

function hashFilterFingerprint(
    chatFilter: ChatFilterConfig | undefined,
    hasCustomUserGate: boolean,
): string {
    const normalizedFilter = chatFilter
        ? {
            enabled: Boolean(chatFilter.enabled),
            mode: chatFilter.mode ?? "blacklist",
            chatIds: [...(chatFilter.chatIds ?? [])].map(String).sort(),
            userIds: [...(chatFilter.userIds ?? [])].map(String).sort(),
            allowedChatIds: [...(chatFilter.allowedChatIds ?? [])].map(String).sort(),
        }
        : null;
    const gateSnapshot = hasCustomUserGate
        ? "custom"
        : {
            invisible: [...userGate.getInvisible()].sort(),
            blocked: [...userGate.getBlocked()].sort(),
        };
    return createHash("sha256")
        .update(JSON.stringify({ chatFilter: normalizedFilter, userGate: gateSnapshot }))
        .digest("hex");
}

function buildOptionsFingerprint(params: {
    inputKey: string;
    chatId: string;
    userMapHash: string;
    filterHash: string;
    includeSystem: boolean;
    includeRecalled: boolean;
    timezone: string;
    sinceMs?: number;
    untilMs?: number;
    selfUserId?: string;
}): string {
    return JSON.stringify({
        normalizationVersion: NORMALIZATION_VERSION,
        inputKey: params.inputKey,
        chatId: params.chatId,
        userMapHash: params.userMapHash,
        filterHash: params.filterHash,
        includeSystem: params.includeSystem,
        includeRecalled: params.includeRecalled,
        timezone: params.timezone,
        sinceMs: params.sinceMs ?? null,
        untilMs: params.untilMs ?? null,
        selfUserId: params.selfUserId ?? null,
    });
}

function timestampsMatch(a: string, b: string): boolean {
    if (a === b) return true;
    const ma = Date.parse(a);
    const mb = Date.parse(b);
    return Number.isFinite(ma) && Number.isFinite(mb) && Math.abs(ma - mb) <= 1000;
}

function estimateIngestBytes(entry: IngestMessage): number {
    return Buffer.byteLength(entry.text ?? "", "utf8")
        + Buffer.byteLength(entry.displayName ?? "", "utf8")
        + Buffer.byteLength(entry.mediaInfo ?? "", "utf8")
        + (entry.qceMeta ? Buffer.byteLength(JSON.stringify(entry.qceMeta), "utf8") : 0)
        + 256;
}

function buildWarnings(
    staged: StagedQceExport,
    isOpaquePeerChat: boolean,
    timezoneIsFallback: boolean,
): string[] {
    const warnings: string[] = [];
    if (timezoneIsFallback) {
        warnings.push(
            "No --timezone given and config.yaml has no timezone; active hours are bucketed in UTC and are fixed at first import. Pass --timezone (e.g. Asia/Shanghai) before the real import.",
        );
    }
    if (isOpaquePeerChat) {
        warnings.push(
            "Destination chat peer ID is an opaque UID rather than a positive QQ number; live NapCat sync/send may require --chat-id override.",
        );
    }
    if (staged.uidResolution.unresolvedUids > 0) {
        warnings.push(
            `${staged.uidResolution.unresolvedUids} distinct UID(s) could not be resolved to QQ UINs (examples: ${staged.uidResolution.unresolvedExamples.join(", ")}); consider supplying --user-map.`,
        );
    }
    if (staged.malformedLineCount > 0) {
        warnings.push(
            `Skipped ${staged.malformedLineCount} malformed or oversized JSONL line(s) during streaming.`,
        );
    }
    if (staged.intraExportConflicts > 0) {
        warnings.push(
            `Detected ${staged.intraExportConflicts} intra-export duplicate message ID(s) with conflicting metadata; kept first occurrence.`,
        );
    }
    return warnings;
}

function resolveRuntimeFilters(options: QceImportOptions): {
    chatFilter: ChatFilterConfig | undefined;
    isUserBlocked: (userId: string) => boolean;
} {
    const chatFilter = options.chatFilter !== undefined ? options.chatFilter : loadConfig().chatFilter;
    const isUserBlocked = options.userGateBlocked ?? ((uid: string) => userGate.shouldDrop(uid));
    return { chatFilter, isUserBlocked };
}

function parseResumeCursorStrict(
    progressJson: string,
    staged: StagedQceExport,
): { tsMs: number; sourceOrdinal: number } | undefined {
    let parsed: { lastTimestampMs?: unknown; lastSourceOrdinal?: unknown };
    try {
        parsed = JSON.parse(progressJson) as { lastTimestampMs?: unknown; lastSourceOrdinal?: unknown };
    } catch (err) {
        throw new Error(`Corrupt QCE import checkpoint JSON; cannot --resume (${String(err)}). Run without --resume.`);
    }
    if (
        !parsed
        || typeof parsed !== "object"
        || typeof parsed.lastTimestampMs !== "number"
        || !Number.isFinite(parsed.lastTimestampMs)
        || typeof parsed.lastSourceOrdinal !== "number"
        || !Number.isInteger(parsed.lastSourceOrdinal)
        || parsed.lastSourceOrdinal < 0
    ) {
        throw new Error("Invalid QCE import checkpoint cursor fields; cannot --resume. Run without --resume.");
    }
    if (parsed.lastSourceOrdinal === 0) {
        return undefined;
    }
    if (!staged.hasCursor(parsed.lastTimestampMs, parsed.lastSourceOrdinal)) {
        throw new Error(
            `Resumed checkpoint cursor (${parsed.lastTimestampMs}, #${parsed.lastSourceOrdinal}) does not exist in staged export; cannot --resume.`,
        );
    }
    return {
        tsMs: parsed.lastTimestampMs,
        sourceOrdinal: parsed.lastSourceOrdinal,
    };
}

async function runDryRunEvaluation(
    staged: StagedQceExport,
    options: QceImportOptions,
    lookupExisting: (chatId: string, messageIds: string[]) => Map<string, ExistingMessageSnapshot>,
    signal?: AbortSignal,
    onEligibleMessage?: (msg: QceNormalizedMessage) => void,
): Promise<QceImportSummary> {
    const { timezone, isFallback: timezoneIsFallback } = resolveImportTimezone(options);
    const sinceMs = options.since !== undefined ? parseStrictTimestampMs(options.since, timezone, "since") : undefined;
    const untilMs = options.until !== undefined ? parseStrictTimestampMs(options.until, timezone, "until") : undefined;
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs >= untilMs) {
        throw new HistoryUsageError(
            `Invalid date range: --since (${options.since}) must be earlier than --until (${options.until})`,
        );
    }

    const chatTarget = resolveQceChatTarget(staged.chatInfo, staged.uidToUin, options.chatId);
    const selfUserId = normalizeSelfIdOption(options.selfId, staged.uidToUin);
    const { chatFilter, isUserBlocked } = resolveRuntimeFilters(options);

    let eligibleMessages = 0;
    let skippedSystem = 0;
    let skippedRecalled = 0;
    let skippedDateRange = 0;
    let skippedByFilter = 0;
    let inserted = 0;
    let duplicates = staged.intraExportDuplicates;
    let conflicts = staged.intraExportConflicts;
    let unknownTimeCount = 0;
    let earliestMs: number | null = null;
    let latestMs: number | null = null;
    const uniqueSenders = new Set<string>();

    const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
    let pendingCheck: IngestMessage[] = [];

    const flushCheckBatch = () => {
        if (pendingCheck.length === 0) return;
        const existingMap = lookupExisting(
            chatTarget.chatId,
            pendingCheck.map(m => m.messageId),
        );
        for (const msg of pendingCheck) {
            const existing = existingMap.get(msg.messageId);
            if (!existing) {
                inserted++;
            } else if (existing.userId === msg.userId && timestampsMatch(existing.timestamp, msg.timestamp)) {
                duplicates++;
            } else {
                conflicts++;
            }
        }
        pendingCheck = [];
    };

    let seenCount = 0;
    for (const spooled of staged.iterateMessages()) {
        if (signal?.aborted) {
            throw createAbortError();
        }
        seenCount++;
        if (seenCount % 500 === 0) {
            await yieldToEventLoop();
            if (signal?.aborted) {
                throw createAbortError();
            }
        }

        const norm = normalizeQceMessage(spooled.raw, {
            chatId: chatTarget.chatId,
            isDirectMessage: chatTarget.isDirectMessage,
            timezone,
            uidToUin: staged.uidToUin,
            selfUserId,
            includeSystem: options.includeSystem,
            includeRecalled: options.includeRecalled,
        });

        if (norm.status === "skip") {
            if (norm.reason === "system") skippedSystem++;
            else if (norm.reason === "recalled") skippedRecalled++;
            continue;
        }

        const msg = norm.message;
        if (sinceMs !== undefined || untilMs !== undefined) {
            if (msg.timeUnknown) {
                skippedDateRange++;
                continue;
            }
            if (sinceMs !== undefined && msg.timestampMs < sinceMs) {
                skippedDateRange++;
                continue;
            }
            if (untilMs !== undefined && msg.timestampMs >= untilMs) {
                skippedDateRange++;
                continue;
            }
        }

        if (
            shouldDropInbound(chatFilter, { chatId: chatTarget.chatId, userId: msg.userId })
            || isUserBlocked(msg.userId)
        ) {
            skippedByFilter++;
            continue;
        }

        eligibleMessages++;
        if (onEligibleMessage) {
            onEligibleMessage(msg);
        }
        if (msg.countAsHuman) {
            uniqueSenders.add(msg.userId);
        }
        if (msg.timeUnknown) {
            unknownTimeCount++;
        } else {
            if (earliestMs === null || msg.timestampMs < earliestMs) earliestMs = msg.timestampMs;
            if (latestMs === null || msg.timestampMs > latestMs) latestMs = msg.timestampMs;
        }

        pendingCheck.push(msg);
        if (pendingCheck.length >= batchSize) {
            flushCheckBatch();
        }
    }

    flushCheckBatch();

    return {
        dryRun: true,
        format: staged.format,
        chatId: chatTarget.chatId,
        chatTitle: chatTarget.chatTitle,
        isDirectMessage: chatTarget.isDirectMessage,
        isOpaquePeerChat: chatTarget.isOpaquePeerChat,
        inputKey: staged.inputKey,
        totalMessages: staged.totalRawMessages,
        eligibleMessages,
        inserted,
        duplicates,
        conflicts,
        skippedByFilter,
        skippedInvalid: staged.skippedInvalidId,
        skippedSystem,
        skippedRecalled,
        skippedDateRange,
        malformedLineCount: staged.malformedLineCount,
        malformedLines: staged.malformedLines,
        warnings: buildWarnings(staged, chatTarget.isOpaquePeerChat, timezoneIsFallback),
        dateRange: {
            earliest: earliestMs !== null ? new Date(earliestMs).toISOString() : null,
            latest: latestMs !== null ? new Date(latestMs).toISOString() : null,
            unknownTimeCount,
        },
        uniqueSenders: uniqueSenders.size,
        uidResolution: staged.uidResolution,
        timezone,
    };
}

export async function dryRunQceImport(
    inputPath: string,
    dbPath: string,
    options: QceImportOptions = {},
    signal?: AbortSignal,
    onEligibleMessage?: (msg: QceNormalizedMessage) => void,
): Promise<QceImportSummary> {
    const { timezone, isFallback: timezoneIsFallback } = resolveImportTimezone(options);
    const sinceMs = options.since !== undefined ? parseStrictTimestampMs(options.since, timezone, "since") : undefined;
    const untilMs = options.until !== undefined ? parseStrictTimestampMs(options.until, timezone, "until") : undefined;
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs >= untilMs) {
        throw new HistoryUsageError(
            `Invalid date range: --since (${options.since}) must be earlier than --until (${options.until})`,
        );
    }

    const staged = await stageQceExport(inputPath, {
        userMapPath: options.userMapPath,
        timezone,
        includeSystem: options.includeSystem,
        includeRecalled: options.includeRecalled,
        signal,
    });

    let roDb: StrictReadOnlyDb | null = null;
    try {
        let hasMessageLog = false;
        if (dbPath && fs.existsSync(dbPath)) {
            roDb = openSqliteReadOnlyStrict(dbPath);
            const tbl = roDb.prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_log'",
            ).get();
            hasMessageLog = Boolean(tbl);
        }

        const lookupExisting = (chatId: string, messageIds: string[]): Map<string, ExistingMessageSnapshot> => {
            const map = new Map<string, ExistingMessageSnapshot>();
            if (!roDb || !hasMessageLog || messageIds.length === 0) return map;
            const CHUNK = 200;
            for (let i = 0; i < messageIds.length; i += CHUNK) {
                const chunk = messageIds.slice(i, i + CHUNK);
                const placeholders = chunk.map(() => "?").join(", ");
                const rows = roDb.prepare(`
                    SELECT message_id, user_id, timestamp
                    FROM message_log
                    WHERE chat_id = ? AND message_id IN (${placeholders})
                `).all(chatId, ...chunk) as Array<{
                    message_id: string;
                    user_id: string;
                    timestamp: string;
                }>;
                for (const row of rows) {
                    map.set(row.message_id, {
                        userId: row.user_id,
                        timestamp: row.timestamp,
                    });
                }
            }
            return map;
        };

        return await runDryRunEvaluation(staged, { ...options, timezone, timezoneIsFallback }, lookupExisting, signal, onEligibleMessage);
    } finally {
        if (roDb) {
            try {
                roDb.close();
            } catch {
                // ignore
            }
        }
        staged.cleanup();
    }
}

export async function importQce(
    memory: MemoryStoreV2,
    inputPath: string,
    options: QceImportOptions = {},
    signal?: AbortSignal,
): Promise<QceImportSummary> {
    const { timezone, isFallback: timezoneIsFallback } = resolveImportTimezone(options);
    const sinceMs = options.since !== undefined ? parseStrictTimestampMs(options.since, timezone, "since") : undefined;
    const untilMs = options.until !== undefined ? parseStrictTimestampMs(options.until, timezone, "until") : undefined;
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs >= untilMs) {
        throw new HistoryUsageError(
            `Invalid date range: --since (${options.since}) must be earlier than --until (${options.until})`,
        );
    }

    const staged = await stageQceExport(inputPath, {
        userMapPath: options.userMapPath,
        timezone,
        includeSystem: options.includeSystem,
        includeRecalled: options.includeRecalled,
        signal,
    });

    let lease: { ownerToken: string; expiresAtMs: number } | null = null;
    let chatIdForLease = "";

    try {
        if (signal?.aborted) {
            throw createAbortError();
        }

        const chatTarget = resolveQceChatTarget(staged.chatInfo, staged.uidToUin, options.chatId);
        if (options.dryRun) {
            const lookupExisting = (chatId: string, messageIds: string[]): Map<string, ExistingMessageSnapshot> => {
                const map = new Map<string, ExistingMessageSnapshot>();
                if (messageIds.length === 0) return map;
                const existing = memory.getMessagesByIds(chatId, messageIds, { includeBlocked: true });
                for (const m of existing) {
                    map.set(m.messageId, { userId: m.userId, timestamp: m.timestamp });
                }
                return map;
            };
            return await runDryRunEvaluation(staged, { ...options, timezone, timezoneIsFallback }, lookupExisting, signal);
        }

        const selfUserId = normalizeSelfIdOption(options.selfId, staged.uidToUin);
        const { chatFilter, isUserBlocked } = resolveRuntimeFilters(options);
        const filterHash = hashFilterFingerprint(chatFilter, options.userGateBlocked !== undefined);
        const optionsFingerprint = buildOptionsFingerprint({
            inputKey: staged.inputKey,
            chatId: chatTarget.chatId,
            userMapHash: staged.userMapHash,
            filterHash,
            includeSystem: Boolean(options.includeSystem),
            includeRecalled: Boolean(options.includeRecalled),
            timezone,
            sinceMs,
            untilMs,
            selfUserId,
        });

        chatIdForLease = chatTarget.chatId;
        lease = memory.acquireHistoryLease(chatTarget.chatId);

        let resumeCursor: { tsMs: number; sourceOrdinal: number } | undefined;
        let resumedFromOrdinal: number | undefined;

        const existingJob = memory.getHistoryJob("qce_import", chatTarget.chatId, staged.inputKey);
        if (options.resume) {
            if (!existingJob) {
                throw new Error(
                    `No previous qce_import job found to resume for chat ${chatTarget.chatId} (${staged.inputKey}). Run without --resume.`,
                );
            }
            if (existingJob.optionsJson !== optionsFingerprint) {
                throw new Error(
                    `QCE import options changed since previous job for chat ${chatTarget.chatId}; cannot --resume. Run a fresh import without --resume or pass matching options.`,
                );
            }
            resumeCursor = parseResumeCursorStrict(existingJob.progressJson, staged);
            if (resumeCursor) {
                resumedFromOrdinal = resumeCursor.sourceOrdinal;
            }
        }

        const initialProgress = options.resume && existingJob
            ? existingJob.progressJson
            : JSON.stringify({ lastTimestampMs: -1, lastSourceOrdinal: 0 });

        const job = memory.upsertHistoryJob({
            kind: "qce_import",
            chatId: chatTarget.chatId,
            inputKey: staged.inputKey,
            optionsJson: optionsFingerprint,
            progressJson: initialProgress,
            status: "running",
        }, lease.ownerToken);

        const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
        const batchMaxBytes = Math.max(1024, Math.floor(options.batchMaxBytes ?? DEFAULT_BATCH_MAX_BYTES));

        let groupModelEnsured = false;
        const ensureGroupModelReady = () => {
            if (groupModelEnsured) return;
            groupModelEnsured = true;
            const groupKey = getGroupModelKey(chatTarget.chatId);
            const existingGroup = memory.getGroupModel(groupKey);
            if (!existingGroup) {
                memory.upsertGroupModel(groupKey, {
                    chatTitle: chatTarget.chatTitle,
                    isDirectMessage: chatTarget.isDirectMessage,
                });
            } else {
                const patch: { chatTitle?: string; isDirectMessage?: boolean } = {};
                if (!existingGroup.chatTitle && chatTarget.chatTitle) {
                    patch.chatTitle = chatTarget.chatTitle;
                }
                if (chatTarget.isDirectMessage && !existingGroup.isDirectMessage) {
                    patch.isDirectMessage = true;
                }
                if (Object.keys(patch).length > 0) {
                    memory.upsertGroupModel(groupKey, patch);
                }
            }
            if (chatTarget.isDirectMessage && !existingGroup?.markedSensitive) {
                memory.markChatSensitive(groupKey, "qce direct message import");
            }
        };

        let eligibleMessages = 0;
        let inserted = 0;
        let duplicates = options.resume ? 0 : staged.intraExportDuplicates;
        let conflicts = options.resume ? 0 : staged.intraExportConflicts;
        let skippedSystem = 0;
        let skippedRecalled = 0;
        let skippedDateRange = 0;
        let skippedByFilter = 0;
        let unknownTimeCount = 0;
        let earliestMs: number | null = null;
        let latestMs: number | null = null;
        const uniqueSenders = new Set<string>();

        let batch: IngestMessage[] = [];
        let batchBytes = 0;
        let lastBatchTsMs = resumeCursor?.tsMs ?? -1;
        let lastBatchOrdinal = resumeCursor?.sourceOrdinal ?? 0;

        const commitBatch = () => {
            if (batch.length === 0) return;
            ensureGroupModelReady();
            memory.renewHistoryLease(chatTarget.chatId, lease!.ownerToken);
            const res = memory.storeIngestedBatch(batch, {
                jobId: job.jobId,
                ownerToken: lease!.ownerToken,
                progress: {
                    lastTimestampMs: lastBatchTsMs,
                    lastSourceOrdinal: lastBatchOrdinal,
                },
            });
            inserted += res.inserted;
            duplicates += res.duplicates;
            conflicts += res.conflicts;
            batch = [];
            batchBytes = 0;
        };

        try {
            if (!shouldDropInbound(chatFilter, { chatId: chatTarget.chatId })) {
                ensureGroupModelReady();
            }

            let seenCount = 0;
            for (const spooled of staged.iterateMessages(resumeCursor)) {
                if (signal?.aborted) {
                    throw createAbortError();
                }
                seenCount++;
                if (seenCount % 500 === 0) {
                    await yieldToEventLoop();
                    if (signal?.aborted) {
                        throw createAbortError();
                    }
                }

                const norm = normalizeQceMessage(spooled.raw, {
                    chatId: chatTarget.chatId,
                    isDirectMessage: chatTarget.isDirectMessage,
                    timezone,
                    uidToUin: staged.uidToUin,
                    selfUserId,
                    includeSystem: options.includeSystem,
                    includeRecalled: options.includeRecalled,
                });

                if (norm.status === "skip") {
                    if (norm.reason === "system") skippedSystem++;
                    else if (norm.reason === "recalled") skippedRecalled++;
                    continue;
                }

                const msg = norm.message;
                if (sinceMs !== undefined || untilMs !== undefined) {
                    if (msg.timeUnknown) {
                        skippedDateRange++;
                        continue;
                    }
                    if (sinceMs !== undefined && msg.timestampMs < sinceMs) {
                        skippedDateRange++;
                        continue;
                    }
                    if (untilMs !== undefined && msg.timestampMs >= untilMs) {
                        skippedDateRange++;
                        continue;
                    }
                }

                if (
                    shouldDropInbound(chatFilter, { chatId: chatTarget.chatId, userId: msg.userId })
                    || isUserBlocked(msg.userId)
                ) {
                    skippedByFilter++;
                    continue;
                }

                eligibleMessages++;
                if (msg.countAsHuman) {
                    uniqueSenders.add(msg.userId);
                }
                if (msg.timeUnknown) {
                    unknownTimeCount++;
                } else {
                    if (earliestMs === null || msg.timestampMs < earliestMs) earliestMs = msg.timestampMs;
                    if (latestMs === null || msg.timestampMs > latestMs) latestMs = msg.timestampMs;
                }

                const entryBytes = estimateIngestBytes(msg);
                if (batch.length > 0 && (batch.length >= batchSize || batchBytes + entryBytes > batchMaxBytes)) {
                    commitBatch();
                    await yieldToEventLoop();
                    if (signal?.aborted) {
                        throw createAbortError();
                    }
                }

                batch.push(msg);
                batchBytes += entryBytes;
                lastBatchTsMs = spooled.tsMs;
                lastBatchOrdinal = spooled.sourceOrdinal;
            }

            if (signal?.aborted) {
                throw createAbortError();
            }

            commitBatch();
            await yieldToEventLoop();
            if (signal?.aborted) {
                throw createAbortError();
            }

            memory.finalizeQceImport({
                jobId: job.jobId,
                ownerToken: lease.ownerToken,
                chatId: chatTarget.chatId,
                timezone,
                recomputeStats: groupModelEnsured,
                progress: {
                    lastTimestampMs: lastBatchTsMs,
                    lastSourceOrdinal: lastBatchOrdinal,
                    completedAt: new Date().toISOString(),
                },
            });
        } catch (err) {
            try {
                memory.updateHistoryJobStatus(job.jobId, lease.ownerToken, "paused");
            } catch {
                // ignore if lease already lost/expired
            }
            throw err;
        }

        return {
            dryRun: false,
            format: staged.format,
            chatId: chatTarget.chatId,
            chatTitle: chatTarget.chatTitle,
            isDirectMessage: chatTarget.isDirectMessage,
            isOpaquePeerChat: chatTarget.isOpaquePeerChat,
            inputKey: staged.inputKey,
            totalMessages: staged.totalRawMessages,
            eligibleMessages,
            inserted,
            duplicates,
            conflicts,
            skippedByFilter,
            skippedInvalid: staged.skippedInvalidId,
            skippedSystem,
            skippedRecalled,
            skippedDateRange,
            malformedLineCount: staged.malformedLineCount,
            malformedLines: staged.malformedLines,
            warnings: buildWarnings(staged, chatTarget.isOpaquePeerChat, timezoneIsFallback),
            dateRange: {
                earliest: earliestMs !== null ? new Date(earliestMs).toISOString() : null,
                latest: latestMs !== null ? new Date(latestMs).toISOString() : null,
                unknownTimeCount,
            },
            uniqueSenders: uniqueSenders.size,
            uidResolution: staged.uidResolution,
            timezone,
            ...(resumedFromOrdinal !== undefined ? { resumedFromOrdinal } : {}),
        };
    } finally {
        if (lease && chatIdForLease) {
            try {
                memory.releaseHistoryLease(chatIdForLease, lease.ownerToken);
            } catch {
                // ignore
            }
        }
        staged.cleanup();
    }
}
