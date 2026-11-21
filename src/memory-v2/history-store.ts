import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { safeGroupModelKey } from "../core/chat-id.js";
import { readMessageMentions } from "../core/message-provenance.js";
import { getGlobalTimezone } from "../core/timezone.js";
import {
    collectChatNamesFromMessage,
    insertChatNameObservations,
    type ChatNameObservation,
} from "./chat-names.js";
import { embeddingToBuffer } from "./embedding.js";
import type { FactCategory, InteractionEpisode, MessageLogEntry, TopicNode } from "./types.js";

export type MessageOrigin = "legacy" | "live" | "qce";

export type HistoryJobKind = "qce_import" | "initialize";
export type HistoryJobStatus = "pending" | "running" | "paused" | "done";

export interface HistoryLease {
    ownerToken: string;
    expiresAtMs: number;
}

export interface HistoryJobRecord {
    jobId: string;
    kind: HistoryJobKind;
    chatId: string;
    inputKey: string;
    optionsJson: string;
    progressJson: string;
    status: HistoryJobStatus;
    updatedAt: string;
}

export interface UpsertHistoryJobInput {
    jobId?: string;
    kind: HistoryJobKind;
    chatId: string;
    inputKey: string;
    optionsJson: string;
    progressJson?: string;
    status: HistoryJobStatus;
}

export interface ChatActivityStats {
    activeMembers: number;
    avgMessagesPerDay: number;
    peakHours: number[];
}

export class HistoryLeaseError extends Error {
    constructor(message: string, public readonly chatId: string) {
        super(message);
        this.name = "HistoryLeaseError";
    }
}

export class HistoryUnitStaleError extends Error {
    constructor(message: string, public readonly unitKey: string) {
        super(message);
        this.name = "HistoryUnitStaleError";
    }
}

export type HistoryUnitStage = "cluster" | "synthesize" | "embed";

export interface HistoryUnitInput {
    unitKey: string;
    ordinal: number;
    inputJson: string;
}

export interface HistoryUnitRecord {
    jobId: string;
    stage: HistoryUnitStage;
    unitKey: string;
    ordinal: number;
    inputJson: string;
    outputJson: string | null;
    completedAt: string | null;
}

export interface DigestMessageFields {
    messageId: string;
    userId: string;
    timestamp: string;
    text: string;
    replyToMessageId?: string | null;
    mentions?: string | null;
}

export function computeMessagesDigest(rows: DigestMessageFields[]): string {
    const hash = createHash("sha256");
    for (const row of rows) {
        hash.update(JSON.stringify([
            row.messageId,
            row.userId,
            row.timestamp,
            row.text,
            row.replyToMessageId ?? null,
            row.mentions ?? null,
        ]));
        hash.update("\n");
    }
    return hash.digest("hex");
}

export function computeEmbeddingContentHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

export interface HistoryClusterTopicInput {
    id?: string;
    tempId?: string;
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
    relatedTopicIds?: string[];
}

export interface HistoryClusterCommitInput {
    jobId: string;
    ownerToken: string;
    chatId: string;
    unitKey: string;
    expectedMessageIds: string[];
    expectedDigest: string;
    topics: HistoryClusterTopicInput[];
    coveredPairs: Array<{
        messageId: string;
        topicHistoryKey: string;
    }>;
    outputJson: string;
}

export interface HistoryClusterCommitResult {
    topicIds: string[];
    coveredCount: number;
}

export interface HistorySynthesisGroupPatch {
    description?: string;
    dominantLanguage?: string;
    engagementLevel?: "high" | "medium" | "low";
    communicationNorms?: string[];
    hotTopics?: string[];
    tabooTopics?: string[];
    agentRole?: string;
}

export interface HistorySynthesisEpisodeInput {
    id: string;
    date: string;
    topicId: string | null;
    topicLabel?: string;
    summary: string;
    sentiment: "positive" | "neutral" | "negative";
    significance: number;
    messageIds: string[];
    displayName?: string;
}

export interface HistorySynthesisMemberPatch {
    userId: string;
    traits?: string[];
    interests?: string[];
    communicationStyle?: string;
    episodes?: HistorySynthesisEpisodeInput[];
}

export interface HistorySynthesisFactProposal {
    id?: string;
    historyKey: string;
    subject: string;
    content: string;
    category: FactCategory;
    confidence?: number;
    sourceTopicId: string | null;
    sourceTopicLabel?: string | null;
    sourceMessageIds: string[];
    observedAt: string;
    sensitivity?: "low" | "medium" | "high";
}

export interface HistorySynthesisExpectedEvidence {
    topicId: string;
    sampledMessageIds: string[];
    evidenceDigest: string;
}

export interface HistorySynthesisCitation {
    topicId: string;
    messageIds: string[];
}

export interface HistorySynthesisCommitInput {
    jobId: string;
    ownerToken: string;
    chatId: string;
    unitKey: string;
    rankKey: string;
    groupPatch?: HistorySynthesisGroupPatch;
    groupPatchCitations?: HistorySynthesisCitation[];
    memberPatches: HistorySynthesisMemberPatch[];
    factProposals: HistorySynthesisFactProposal[];
    expectedEvidence?: HistorySynthesisExpectedEvidence[];
    outputJson: string;
    isPrivateOrSensitive: boolean;
}

export interface HistorySynthesisCommitResult {
    groupFieldsWritten: string[];
    membersUpdated: number;
    factsCommitted: number;
}

export interface HistoryEmbeddingCommitInput {
    jobId: string;
    ownerToken: string;
    chatId: string;
    unitKey: string;
    kind: "topic" | "fact";
    targetId: string;
    expectedContentHash: string;
    expectedDimensions: number;
    embedding: Float32Array;
    outputJson: string;
}

export interface HistoryFinalizeQceImportInput {
    jobId: string;
    ownerToken: string;
    chatId: string;
    timezone: string;
    recomputeStats: boolean;
    progress: Record<string, unknown>;
}

export const NEWCOMER_AGENT_ROLE = "新入群观察者（正在熟悉群聊文化与成员）";
const MAX_OFFLINE_EPISODES = 12;
const MAX_GROUP_LIST_SEED_ITEMS = 10;
const MAX_MEMBER_LIST_SEED_ITEMS = 12;

export interface IngestMessage extends MessageLogEntry {
    origin: MessageOrigin;
    countAsHuman: boolean;
    statsHour: number | null;
    qceMeta?: Record<string, unknown>;
    chatNames?: ChatNameObservation[];
    /** Optional global displayName update (omit for OneBot group messages to prevent cross-group leak) */
    globalDisplayName?: string;
    username?: string;
}

export interface HistoryCheckpoint {
    jobId: string;
    ownerToken: string;
    progress: Record<string, unknown>;
}

export interface IngestBatchResult {
    inserted: number;
    duplicates: number;
    conflicts: number;
}

function nowIso(): string {
    return new Date().toISOString();
}

function isValidNonSentinelTimestamp(ts: string | undefined | null): ts is string {
    if (!ts || typeof ts !== "string") return false;
    const trimmed = ts.trim();
    if (!trimmed) return false;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) && ms > 86_400_000;
}

function minTimestamp(a: string | null | undefined, b: string): string {
    if (!isValidNonSentinelTimestamp(a)) return b;
    if (!isValidNonSentinelTimestamp(b)) return a;
    return Date.parse(b) < Date.parse(a) ? b : a;
}

function maxTimestamp(a: string | null | undefined, b: string): string {
    if (!isValidNonSentinelTimestamp(a)) return b;
    if (!isValidNonSentinelTimestamp(b)) return a;
    return Date.parse(b) > Date.parse(a) ? b : a;
}

function timestampsMatch(a: string, b: string): boolean {
    if (a === b) return true;
    const ma = Date.parse(a);
    const mb = Date.parse(b);
    return Number.isFinite(ma) && Number.isFinite(mb) && Math.abs(ma - mb) <= 1000;
}

function parseActiveHours(raw: string | null | undefined): number[] {
    const base = new Array(24).fill(0);
    if (!raw) return base;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return base;
        for (let i = 0; i < 24; i++) {
            const val = Number(parsed[i]);
            base[i] = Number.isFinite(val) && val > 0 ? val : 0;
        }
        return base;
    } catch {
        return base;
    }
}

export function computeStatsHour(timestamp: string | number | Date, timeZone?: string): number | null {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return null;
    const tz = timeZone ?? getGlobalTimezone();
    if (tz) {
        try {
            const formatter = new Intl.DateTimeFormat("en-US", {
                hour: "2-digit",
                hourCycle: "h23",
                timeZone: tz,
            });
            const hour = Number.parseInt(formatter.format(date), 10);
            if (Number.isInteger(hour)) return ((hour % 24) + 24) % 24;
        } catch {
            // Fall through to local date hour
        }
    }
    const localHour = date.getHours();
    return Number.isInteger(localHour) && localHour >= 0 && localHour <= 23 ? localHour : null;
}

function formatCalendarDateInZone(isoTimestamp: string, timeZone?: string): string | null {
    const date = new Date(isoTimestamp);
    if (!Number.isFinite(date.getTime())) return null;
    const tz = timeZone ?? getGlobalTimezone() ?? "UTC";
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(date);
        const year = parts.find(p => p.type === "year")?.value;
        const month = parts.find(p => p.type === "month")?.value;
        const day = parts.find(p => p.type === "day")?.value;
        if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
        // Fallback to UTC below
    }
    const year = String(date.getUTCFullYear()).padStart(4, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function parseYmdUtcMs(ymd: string): number {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
}

function isTimeUnknownQceMeta(raw: string | null | undefined): boolean {
    if (!raw) return false;
    try {
        const parsed = JSON.parse(raw) as { timeUnknown?: unknown };
        return parsed?.timeUnknown === true;
    } catch {
        return false;
    }
}

export class HistoryStore {
    constructor(
        private readonly db: Database.Database,
        private readonly isSqliteVecAvailable: () => boolean = () => false,
    ) {}

    private assertActiveLease(chatId: string, ownerToken: string): void {
        const lease = this.db.prepare(`
            SELECT owner_token, expires_at_ms
            FROM history_leases
            WHERE chat_id = ?
        `).get(chatId) as { owner_token: string; expires_at_ms: number } | undefined;
        if (!lease || lease.owner_token !== ownerToken || lease.expires_at_ms <= Date.now()) {
            throw new HistoryLeaseError(`History lease invalid or expired for chat ${chatId}`, chatId);
        }
    }

    private assertOwnedJob(jobId: string, kind: HistoryJobKind, chatId: string, ownerToken: string): void {
        const job = this.db.prepare(`
            SELECT job_id, kind, chat_id
            FROM history_jobs
            WHERE job_id = ?
        `).get(jobId) as { job_id: string; kind: HistoryJobKind; chat_id: string } | undefined;
        if (!job) {
            throw new Error(`History job not found: ${jobId}`);
        }
        if (job.kind !== kind || job.chat_id !== chatId) {
            throw new Error(
                `History job mismatch for ${jobId}: expected (${kind}, ${chatId}), got (${job.kind}, ${job.chat_id})`,
            );
        }
        this.assertActiveLease(chatId, ownerToken);
    }

    acquireHistoryLease(chatId: string, ttlMs: number = 60_000): HistoryLease {
        const cleanChatId = chatId.trim();
        if (!cleanChatId) {
            throw new HistoryLeaseError("chatId is required to acquire history lease", chatId);
        }
        const ttl = Math.max(1, Math.floor(ttlMs));
        const run = this.db.transaction((): HistoryLease => {
            const nowMs = Date.now();
            const existing = this.db.prepare(`
                SELECT owner_token, expires_at_ms
                FROM history_leases
                WHERE chat_id = ?
            `).get(cleanChatId) as { owner_token: string; expires_at_ms: number } | undefined;
            if (existing && existing.expires_at_ms > nowMs) {
                throw new HistoryLeaseError(
                    `History lease already held for chat ${cleanChatId} until ${new Date(existing.expires_at_ms).toISOString()}`,
                    cleanChatId,
                );
            }
            const ownerToken = randomUUID();
            const expiresAtMs = nowMs + ttl;
            this.db.prepare(`
                INSERT INTO history_leases (chat_id, owner_token, expires_at_ms)
                VALUES (?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET
                    owner_token = excluded.owner_token,
                    expires_at_ms = excluded.expires_at_ms
            `).run(cleanChatId, ownerToken, expiresAtMs);
            return { ownerToken, expiresAtMs };
        });
        return run();
    }

    renewHistoryLease(chatId: string, ownerToken: string, ttlMs: number = 60_000): number {
        const cleanChatId = chatId.trim();
        const ttl = Math.max(1, Math.floor(ttlMs));
        const run = this.db.transaction((): number => {
            const nowMs = Date.now();
            const expiresAtMs = nowMs + ttl;
            const res = this.db.prepare(`
                UPDATE history_leases
                SET expires_at_ms = ?
                WHERE chat_id = ? AND owner_token = ? AND expires_at_ms > ?
            `).run(expiresAtMs, cleanChatId, ownerToken, nowMs);
            if (res.changes !== 1) {
                throw new HistoryLeaseError(`History lease lost or expired for chat ${cleanChatId}`, cleanChatId);
            }
            return expiresAtMs;
        });
        return run();
    }

    releaseHistoryLease(chatId: string, ownerToken: string): void {
        this.db.prepare(`
            DELETE FROM history_leases
            WHERE chat_id = ? AND owner_token = ?
        `).run(chatId.trim(), ownerToken);
    }

    private rowToHistoryJob(row: {
        job_id: string;
        kind: HistoryJobKind;
        chat_id: string;
        input_key: string;
        options_json: string;
        progress_json: string;
        status: HistoryJobStatus;
        updated_at: string;
    }): HistoryJobRecord {
        return {
            jobId: row.job_id,
            kind: row.kind,
            chatId: row.chat_id,
            inputKey: row.input_key,
            optionsJson: row.options_json,
            progressJson: row.progress_json,
            status: row.status,
            updatedAt: row.updated_at,
        };
    }

    getHistoryJob(kind: HistoryJobKind, chatId: string, inputKey: string): HistoryJobRecord | null {
        const row = this.db.prepare(`
            SELECT job_id, kind, chat_id, input_key, options_json, progress_json, status, updated_at
            FROM history_jobs
            WHERE kind = ? AND chat_id = ? AND input_key = ?
        `).get(kind, chatId, inputKey) as Parameters<HistoryStore["rowToHistoryJob"]>[0] | undefined;
        return row ? this.rowToHistoryJob(row) : null;
    }

    findLatestHistoryJob(kind: HistoryJobKind, chatId: string): HistoryJobRecord | null {
        const row = this.db.prepare(`
            SELECT job_id, kind, chat_id, input_key, options_json, progress_json, status, updated_at
            FROM history_jobs
            WHERE kind = ? AND chat_id = ?
            ORDER BY updated_at DESC, rowid DESC
            LIMIT 1
        `).get(kind, chatId) as Parameters<HistoryStore["rowToHistoryJob"]>[0] | undefined;
        return row ? this.rowToHistoryJob(row) : null;
    }

    upsertHistoryJob(job: UpsertHistoryJobInput, ownerToken?: string): HistoryJobRecord {
        const run = this.db.transaction((): HistoryJobRecord => {
            if (ownerToken !== undefined) {
                this.assertActiveLease(job.chatId, ownerToken);
            }
            const ts = nowIso();
            const existing = this.db.prepare(`
                SELECT job_id, progress_json
                FROM history_jobs
                WHERE kind = ? AND chat_id = ? AND input_key = ?
            `).get(job.kind, job.chatId, job.inputKey) as { job_id: string; progress_json: string } | undefined;

            const jobId = existing?.job_id ?? job.jobId ?? randomUUID();
            const progressJson = job.progressJson ?? existing?.progress_json ?? "{}";

            if (existing) {
                this.db.prepare(`
                    UPDATE history_jobs
                    SET options_json = ?,
                        progress_json = ?,
                        status = ?,
                        updated_at = ?
                    WHERE job_id = ?
                `).run(job.optionsJson, progressJson, job.status, ts, jobId);
            } else {
                this.db.prepare(`
                    INSERT INTO history_jobs (
                        job_id, kind, chat_id, input_key, options_json, progress_json, status, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(jobId, job.kind, job.chatId, job.inputKey, job.optionsJson, progressJson, job.status, ts);
            }

            return {
                jobId,
                kind: job.kind,
                chatId: job.chatId,
                inputKey: job.inputKey,
                optionsJson: job.optionsJson,
                progressJson,
                status: job.status,
                updatedAt: ts,
            };
        });
        return run();
    }

    updateHistoryJobStatus(
        jobId: string,
        ownerToken: string,
        status: HistoryJobStatus,
        progress?: Record<string, unknown> | string,
    ): HistoryJobRecord {
        const run = this.db.transaction((): HistoryJobRecord => {
            const existing = this.db.prepare(`
                SELECT job_id, kind, chat_id, input_key, options_json, progress_json, status, updated_at
                FROM history_jobs
                WHERE job_id = ?
            `).get(jobId) as Parameters<HistoryStore["rowToHistoryJob"]>[0] | undefined;
            if (!existing) {
                throw new Error(`History job not found: ${jobId}`);
            }
            this.assertActiveLease(existing.chat_id, ownerToken);

            const ts = nowIso();
            const nextProgress = progress !== undefined
                ? (typeof progress === "string" ? progress : JSON.stringify(progress))
                : existing.progress_json;

            this.db.prepare(`
                UPDATE history_jobs
                SET status = ?, progress_json = ?, updated_at = ?
                WHERE job_id = ?
            `).run(status, nextProgress, ts, jobId);

            return {
                jobId: existing.job_id,
                kind: existing.kind,
                chatId: existing.chat_id,
                inputKey: existing.input_key,
                optionsJson: existing.options_json,
                progressJson: nextProgress,
                status,
                updatedAt: ts,
            };
        });
        return run();
    }

    private recomputeChatActivityStatsInTx(chatId: string, timezone?: string): ChatActivityStats {
        const canonicalTz = timezone ?? getGlobalTimezone() ?? "UTC";
        const rows = this.db.prepare(`
            SELECT user_id, timestamp, stats_hour, qce_meta
            FROM message_log
            WHERE chat_id = ?
              AND access_control_blocked = 0
              AND (
                stats_counted = 1
                OR (
                  origin = 'legacy'
                  AND stats_counted = 0
                  AND user_id != 'system'
                  AND timestamp != '1970-01-01T00:00:00.000Z'
                )
              )
        `).all(chatId) as Array<{
            user_id: string;
            timestamp: string;
            stats_hour: number | null;
            qce_meta: string | null;
        }>;

        const distinctUsers = new Set<string>();
        const hourCounts = new Array<number>(24).fill(0);
        let datedCount = 0;
        let minDay: string | null = null;
        let maxDay: string | null = null;

        for (const row of rows) {
            const uid = row.user_id?.trim();
            if (uid) {
                distinctUsers.add(uid);
            }
            const hr = (typeof row.stats_hour === "number" && Number.isInteger(row.stats_hour) && row.stats_hour >= 0 && row.stats_hour <= 23)
                ? row.stats_hour
                : computeStatsHour(row.timestamp, canonicalTz);
            if (hr !== null) {
                hourCounts[hr]++;
            }
            if (!isTimeUnknownQceMeta(row.qce_meta) && isValidNonSentinelTimestamp(row.timestamp)) {
                const dayKey = formatCalendarDateInZone(row.timestamp, canonicalTz);
                if (dayKey) {
                    datedCount++;
                    if (minDay === null || dayKey < minDay) minDay = dayKey;
                    if (maxDay === null || dayKey > maxDay) maxDay = dayKey;
                }
            }
        }

        const activeMembers = distinctUsers.size;
        let avgMessagesPerDay = 0;
        if (datedCount > 0 && minDay && maxDay) {
            const spanDays = Math.max(1, Math.round((parseYmdUtcMs(maxDay) - parseYmdUtcMs(minDay)) / 86_400_000) + 1);
            avgMessagesPerDay = datedCount / spanDays;
        }

        const peakHours = hourCounts
            .map((count, hour) => ({ hour, count }))
            .filter(entry => entry.count > 0)
            .sort((a, b) => (b.count - a.count) || (a.hour - b.hour))
            .slice(0, 3)
            .map(entry => entry.hour);

        const groupKey = safeGroupModelKey(chatId);
        const ts = nowIso();
        const existingGroup = this.db.prepare("SELECT chat_id FROM group_models WHERE chat_id = ?").get(groupKey);
        if (existingGroup) {
            this.db.prepare(`
                UPDATE group_models
                SET active_members = ?,
                    avg_messages_per_day = ?,
                    peak_hours = ?,
                    updated_at = ?
                WHERE chat_id = ?
            `).run(activeMembers, avgMessagesPerDay, JSON.stringify(peakHours), ts, groupKey);
        } else {
            this.db.prepare(`
                INSERT INTO group_models (
                    chat_id, chat_title, active_members, avg_messages_per_day, peak_hours, updated_at
                ) VALUES (?, '', ?, ?, ?, ?)
            `).run(groupKey, activeMembers, avgMessagesPerDay, JSON.stringify(peakHours), ts);
        }

        return { activeMembers, avgMessagesPerDay, peakHours };
    }

    recomputeChatActivityStats(chatId: string, timezone?: string): ChatActivityStats {
        const run = this.db.transaction(() => this.recomputeChatActivityStatsInTx(chatId, timezone));
        return run();
    }

    finalizeQceImport(input: HistoryFinalizeQceImportInput): ChatActivityStats | null {
        const run = this.db.transaction((): ChatActivityStats | null => {
            this.assertOwnedJob(input.jobId, "qce_import", input.chatId, input.ownerToken);
            const stats = input.recomputeStats
                ? this.recomputeChatActivityStatsInTx(input.chatId, input.timezone)
                : null;
            const ts = nowIso();
            this.db.prepare(`
                UPDATE history_jobs
                SET status = 'done', progress_json = ?, updated_at = ?
                WHERE job_id = ?
            `).run(JSON.stringify(input.progress), ts, input.jobId);
            return stats;
        });
        return run();
    }

    storeIngestedBatch(entries: IngestMessage[], checkpoint?: HistoryCheckpoint): IngestBatchResult {
        if (entries.length === 0 && !checkpoint) {
            return { inserted: 0, duplicates: 0, conflicts: 0 };
        }

        const insertMsgStmt = this.db.prepare(`
            INSERT OR IGNORE INTO message_log (
                message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp,
                media_type, media_info, mentions, access_control_blocked, access_control_released,
                origin, qce_meta, stats_counted, stats_hour
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        `);
        const selectExistingMsgStmt = this.db.prepare(`
            SELECT user_id, timestamp, access_control_blocked, mentions, origin
            FROM message_log
            WHERE chat_id = ? AND message_id = ?
        `);
        const promoteQceToLiveStmt = this.db.prepare(`
            UPDATE message_log
            SET origin = 'live'
            WHERE chat_id = ? AND message_id = ? AND origin = 'qce'
        `);

        const selectIdentityStmt = this.db.prepare(`
            SELECT display_name, username, first_seen_at, last_seen_at
            FROM person_identities
            WHERE user_id = ?
        `);
        const insertIdentityStmt = this.db.prepare(`
            INSERT INTO person_identities (
                user_id, display_name, username, aliases, total_message_count,
                last_seen_at, first_seen_at, updated_at
            )
            VALUES (?, ?, ?, '[]', 1, ?, ?, ?)
        `);
        const updateIdentityStmt = this.db.prepare(`
            UPDATE person_identities
            SET display_name = ?,
                username = ?,
                total_message_count = total_message_count + 1,
                first_seen_at = ?,
                last_seen_at = ?,
                updated_at = ?
            WHERE user_id = ?
        `);

        const selectGroupProfileStmt = this.db.prepare(`
            SELECT active_hours, first_seen_at, last_seen_at
            FROM person_group_profiles
            WHERE user_id = ? AND chat_id = ?
        `);
        const insertGroupProfileStmt = this.db.prepare(`
            INSERT INTO person_group_profiles (
                user_id, chat_id, dunbar_tier, dunbar_reason, affinity_score,
                traits, interests, communication_style, relation_to_agent,
                recent_episodes, merged_memory, message_count, last_seen_at,
                active_hours, first_seen_at, updated_at
            )
            VALUES (?, ?, 4, '', 0, '[]', '[]', '', '', '[]', '[]', 1, ?, ?, ?, ?)
        `);
        const updateGroupProfileStmt = this.db.prepare(`
            UPDATE person_group_profiles
            SET message_count = message_count + 1,
                active_hours = ?,
                first_seen_at = ?,
                last_seen_at = ?,
                updated_at = ?
            WHERE user_id = ? AND chat_id = ?
        `);

        const selectJobStmt = this.db.prepare(`
            SELECT chat_id FROM history_jobs WHERE job_id = ?
        `);
        const selectLeaseStmt = this.db.prepare(`
            SELECT owner_token, expires_at_ms FROM history_leases WHERE chat_id = ?
        `);
        const updateJobProgressStmt = this.db.prepare(`
            UPDATE history_jobs SET progress_json = ?, updated_at = ? WHERE job_id = ?
        `);

        const run = this.db.transaction((): IngestBatchResult => {
            const ts = nowIso();
            if (checkpoint) {
                const job = selectJobStmt.get(checkpoint.jobId) as { chat_id: string } | undefined;
                if (!job) {
                    throw new Error(`History job not found: ${checkpoint.jobId}`);
                }
                const lease = selectLeaseStmt.get(job.chat_id) as
                    | { owner_token: string; expires_at_ms: number }
                    | undefined;
                if (!lease || lease.owner_token !== checkpoint.ownerToken || lease.expires_at_ms <= Date.now()) {
                    throw new HistoryLeaseError(`History lease invalid or expired for chat ${job.chat_id}`, job.chat_id);
                }
                for (const entry of entries) {
                    if (entry.chatId !== job.chat_id) {
                        throw new Error(
                            `storeIngestedBatch chatId mismatch: checkpoint job ${checkpoint.jobId} belongs to ${job.chat_id}, got ${entry.chatId}`,
                        );
                    }
                }
            }

            let inserted = 0;
            let duplicates = 0;
            let conflicts = 0;

            for (const entry of entries) {
                const validStatsHour =
                    typeof entry.statsHour === "number"
                    && Number.isInteger(entry.statsHour)
                    && entry.statsHour >= 0
                    && entry.statsHour <= 23
                        ? entry.statsHour
                        : null;
                const uid = typeof entry.userId === "string" ? entry.userId.trim() : "";
                const shouldCountStats = entry.accessControlBlocked !== true && entry.countAsHuman === true && uid.length > 0;
                const statsCounted = shouldCountStats ? 1 : 0;
                const statsHour = shouldCountStats ? validStatsHour : null;

                const insertRes = insertMsgStmt.run(
                    entry.messageId,
                    entry.chatId,
                    entry.userId,
                    entry.displayName,
                    entry.text,
                    entry.replyToMessageId ?? null,
                    entry.timestamp,
                    entry.mediaType ?? null,
                    entry.mediaInfo ?? null,
                    entry.mentions === undefined ? null : JSON.stringify(entry.mentions),
                    entry.accessControlBlocked ? 1 : 0,
                    entry.origin,
                    entry.qceMeta !== undefined ? JSON.stringify(entry.qceMeta) : null,
                    statsCounted,
                    statsHour,
                );

                if (insertRes.changes === 1) {
                    inserted++;
                    if (!entry.accessControlBlocked) {
                        const chatNames = entry.chatNames ?? collectChatNamesFromMessage(entry);
                        if (chatNames.length > 0) {
                            insertChatNameObservations(this.db, chatNames);
                        }
                        if (shouldCountStats) {
                            // Never substitute import wall-clock time for timeUnknown rows; leave empty until dated message arrives.
                            const validSeenTs = isValidNonSentinelTimestamp(entry.timestamp) ? entry.timestamp : "";
                            const globalDisplayName = entry.globalDisplayName?.trim() || "";
                            const username = entry.username?.trim() || "";

                            const existingIdentity = selectIdentityStmt.get(uid) as
                                | {
                                    display_name: string;
                                    username: string | null;
                                    first_seen_at: string;
                                    last_seen_at: string;
                                }
                                | undefined;
                            if (existingIdentity) {
                                const nextDisplayName = globalDisplayName || existingIdentity.display_name;
                                const nextUsername = username || existingIdentity.username || null;
                                const nextFirst = validSeenTs
                                    ? minTimestamp(existingIdentity.first_seen_at, validSeenTs)
                                    : existingIdentity.first_seen_at;
                                const nextLast = validSeenTs
                                    ? maxTimestamp(existingIdentity.last_seen_at, validSeenTs)
                                    : existingIdentity.last_seen_at;
                                updateIdentityStmt.run(nextDisplayName, nextUsername, nextFirst, nextLast, ts, uid);
                            } else {
                                insertIdentityStmt.run(
                                    uid,
                                    globalDisplayName,
                                    username || null,
                                    validSeenTs,
                                    validSeenTs,
                                    ts,
                                );
                            }

                            const existingProfile = selectGroupProfileStmt.get(uid, entry.chatId) as
                                | {
                                    active_hours: string;
                                    first_seen_at: string;
                                    last_seen_at: string;
                                }
                                | undefined;
                            if (existingProfile) {
                                const hours = parseActiveHours(existingProfile.active_hours);
                                if (statsHour !== null) {
                                    hours[statsHour] = (hours[statsHour] || 0) + 1;
                                }
                                const nextFirst = validSeenTs
                                    ? minTimestamp(existingProfile.first_seen_at, validSeenTs)
                                    : existingProfile.first_seen_at;
                                const nextLast = validSeenTs
                                    ? maxTimestamp(existingProfile.last_seen_at, validSeenTs)
                                    : existingProfile.last_seen_at;
                                updateGroupProfileStmt.run(
                                    JSON.stringify(hours),
                                    nextFirst,
                                    nextLast,
                                    ts,
                                    uid,
                                    entry.chatId,
                                );
                            } else {
                                const hours = new Array(24).fill(0);
                                if (statsHour !== null) {
                                    hours[statsHour] = 1;
                                }
                                insertGroupProfileStmt.run(
                                    uid,
                                    entry.chatId,
                                    validSeenTs,
                                    JSON.stringify(hours),
                                    validSeenTs,
                                    ts,
                                );
                            }
                        }
                    }
                } else {
                    const existing = selectExistingMsgStmt.get(entry.chatId, entry.messageId) as
                        | { user_id: string; timestamp: string; access_control_blocked: number; mentions: string | null; origin: string }
                        | undefined;
                    if (existing && existing.user_id === entry.userId && timestampsMatch(existing.timestamp, entry.timestamp)) {
                        duplicates++;
                        // Promote QCE-imported row to live provenance on same-ID live delivery without recounting stats or overwriting text.
                        if (entry.origin === "live" && existing.origin === "qce") {
                            promoteQceToLiveStmt.run(entry.chatId, entry.messageId);
                        }
                        if (Number(existing.access_control_blocked) === 0 && !entry.accessControlBlocked) {
                            const storedMentions = readMessageMentions(existing.mentions);
                            if (storedMentions?.length) {
                                const mentionNames = collectChatNamesFromMessage({
                                    chatId: entry.chatId,
                                    messageId: entry.messageId,
                                    userId: "",
                                    timestamp: existing.timestamp,
                                    mentions: storedMentions,
                                }).filter(obs => obs.kind === "mention_display");
                                if (mentionNames.length > 0) {
                                    insertChatNameObservations(this.db, mentionNames);
                                }
                            }
                        }
                    } else {
                        conflicts++;
                    }
                }
            }

            if (checkpoint) {
                updateJobProgressStmt.run(JSON.stringify(checkpoint.progress), ts, checkpoint.jobId);
            }

            return { inserted, duplicates, conflicts };
        });

        return run();
    }

    reverseDeletedMessageStats(chatId: string, messageIds: string[]): void {
        const uniqueMessageIds = [...new Set(
            messageIds.map(id => (typeof id === "string" ? id.trim() : "")).filter(Boolean),
        )];
        if (!chatId || uniqueMessageIds.length === 0) return;

        const run = this.db.transaction(() => {
            const ts = nowIso();
            const CHUNK = 200;
            const aggByUser = new Map<string, { countDelta: number; hourDeltas: Map<number, number> }>();

            for (let i = 0; i < uniqueMessageIds.length; i += CHUNK) {
                const chunk = uniqueMessageIds.slice(i, i + CHUNK);
                const placeholders = chunk.map(() => "?").join(", ");
                const rows = this.db.prepare(`
                    SELECT user_id, stats_hour
                    FROM message_log
                    WHERE chat_id = ?
                      AND message_id IN (${placeholders})
                      AND stats_counted = 1
                `).all(chatId, ...chunk) as Array<{ user_id: string; stats_hour: number | null }>;

                for (const row of rows) {
                    const uid = row.user_id?.trim();
                    if (!uid) continue;
                    let agg = aggByUser.get(uid);
                    if (!agg) {
                        agg = { countDelta: 0, hourDeltas: new Map() };
                        aggByUser.set(uid, agg);
                    }
                    agg.countDelta++;
                    if (typeof row.stats_hour === "number" && row.stats_hour >= 0 && row.stats_hour <= 23) {
                        agg.hourDeltas.set(row.stats_hour, (agg.hourDeltas.get(row.stats_hour) ?? 0) + 1);
                    }
                }
            }

            const updateIdentity = this.db.prepare(`
                UPDATE person_identities
                SET total_message_count = MAX(0, total_message_count - ?),
                    updated_at = ?
                WHERE user_id = ?
            `);
            const selectProfile = this.db.prepare(`
                SELECT message_count, active_hours
                FROM person_group_profiles
                WHERE user_id = ? AND chat_id = ?
            `);
            const updateProfile = this.db.prepare(`
                UPDATE person_group_profiles
                SET message_count = ?,
                    active_hours = ?,
                    updated_at = ?
                WHERE user_id = ? AND chat_id = ?
            `);

            for (const [uid, agg] of aggByUser) {
                updateIdentity.run(agg.countDelta, ts, uid);
                const profile = selectProfile.get(uid, chatId) as
                    | { message_count: number; active_hours: string }
                    | undefined;
                if (profile) {
                    const nextCount = Math.max(0, (profile.message_count ?? 0) - agg.countDelta);
                    const hours = parseActiveHours(profile.active_hours);
                    for (const [hr, delta] of agg.hourDeltas) {
                        hours[hr] = Math.max(0, (hours[hr] || 0) - delta);
                    }
                    updateProfile.run(nextCount, JSON.stringify(hours), ts, uid, chatId);
                }
            }
        });
        run();
    }

    upsertHistoryUnits(jobId: string, stage: HistoryUnitStage, units: HistoryUnitInput[], ownerToken: string): void {
        const run = this.db.transaction(() => {
            const job = this.db.prepare(`
                SELECT chat_id FROM history_jobs WHERE job_id = ?
            `).get(jobId) as { chat_id: string } | undefined;
            if (!job) {
                throw new Error(`History job not found: ${jobId}`);
            }
            this.assertActiveLease(job.chat_id, ownerToken);

            this.db.prepare(`
                DELETE FROM history_units
                WHERE job_id = ? AND stage = ? AND completed_at IS NULL
            `).run(jobId, stage);

            const completedRows = this.db.prepare(`
                SELECT unit_key, ordinal
                FROM history_units
                WHERE job_id = ? AND stage = ?
            `).all(jobId, stage) as Array<{ unit_key: string; ordinal: number }>;

            const completedKeys = new Set(completedRows.map(r => r.unit_key));
            const usedOrdinals = new Set(completedRows.map(r => r.ordinal));
            let nextFreeOrdinal = completedRows.length > 0
                ? Math.max(...completedRows.map(r => r.ordinal)) + 1
                : 0;

            const insertStmt = this.db.prepare(`
                INSERT INTO history_units (
                    job_id, stage, unit_key, ordinal, input_json, output_json, completed_at
                )
                VALUES (?, ?, ?, ?, ?, NULL, NULL)
            `);

            for (const unit of units) {
                if (completedKeys.has(unit.unitKey)) {
                    continue;
                }
                let ordinal = Number.isInteger(unit.ordinal) && unit.ordinal >= 0 ? unit.ordinal : nextFreeOrdinal;
                while (usedOrdinals.has(ordinal)) {
                    ordinal = nextFreeOrdinal++;
                }
                usedOrdinals.add(ordinal);
                if (ordinal >= nextFreeOrdinal) {
                    nextFreeOrdinal = ordinal + 1;
                }
                insertStmt.run(jobId, stage, unit.unitKey, ordinal, unit.inputJson);
            }
        });
        run();
    }

    listHistoryUnits(jobId: string, stage: HistoryUnitStage): HistoryUnitRecord[] {
        const rows = this.db.prepare(`
            SELECT job_id, stage, unit_key, ordinal, input_json, output_json, completed_at
            FROM history_units
            WHERE job_id = ? AND stage = ?
            ORDER BY ordinal ASC
        `).all(jobId, stage) as Array<{
            job_id: string;
            stage: HistoryUnitStage;
            unit_key: string;
            ordinal: number;
            input_json: string;
            output_json: string | null;
            completed_at: string | null;
        }>;
        return rows.map(row => ({
            jobId: row.job_id,
            stage: row.stage,
            unitKey: row.unit_key,
            ordinal: row.ordinal,
            inputJson: row.input_json,
            outputJson: row.output_json,
            completedAt: row.completed_at,
        }));
    }

    markHistoryUnitCompleted(
        jobId: string,
        ownerToken: string,
        stage: HistoryUnitStage,
        unitKey: string,
        outputJson: string,
    ): HistoryUnitRecord {
        const run = this.db.transaction((): HistoryUnitRecord => {
            const job = this.db.prepare("SELECT chat_id FROM history_jobs WHERE job_id = ?")
                .get(jobId) as { chat_id: string } | undefined;
            if (!job) {
                throw new Error(`History job not found: ${jobId}`);
            }
            this.assertActiveLease(job.chat_id, ownerToken);

            const ts = nowIso();
            const res = this.db.prepare(`
                UPDATE history_units
                SET output_json = ?, completed_at = ?
                WHERE job_id = ? AND stage = ? AND unit_key = ?
            `).run(outputJson, ts, jobId, stage, unitKey);
            if (res.changes !== 1) {
                throw new HistoryUnitStaleError(`History unit not found: ${jobId}/${stage}/${unitKey}`, unitKey);
            }

            const row = this.db.prepare(`
                SELECT job_id, stage, unit_key, ordinal, input_json, output_json, completed_at
                FROM history_units
                WHERE job_id = ? AND stage = ? AND unit_key = ?
            `).get(jobId, stage, unitKey) as {
                job_id: string;
                stage: HistoryUnitStage;
                unit_key: string;
                ordinal: number;
                input_json: string;
                output_json: string | null;
                completed_at: string | null;
            };
            return {
                jobId: row.job_id,
                stage: row.stage,
                unitKey: row.unit_key,
                ordinal: row.ordinal,
                inputJson: row.input_json,
                outputJson: row.output_json,
                completedAt: row.completed_at,
            };
        });
        return run();
    }

    getCoveredMessageIds(chatId: string): Set<string> {
        const rows = this.db.prepare(`
            SELECT message_id
            FROM history_cluster_coverage
            WHERE chat_id = ?
        `).all(chatId) as Array<{ message_id: string }>;
        return new Set(rows.map(r => r.message_id));
    }

    getHistoricalTopicsForChat(chatId: string): TopicNode[] {
        const rows = this.db.prepare(`
            SELECT *
            FROM topics
            WHERE chat_id = ? AND history_key IS NOT NULL
            ORDER BY started_at ASC, id ASC
        `).all(chatId) as Array<Record<string, unknown>>;

        return rows.map(row => {
            const messageIds = parseJsonSafe<string[]>(row.message_ids as string, []);
            return {
                id: row.id as string,
                pipelineTopicId: (row.pipeline_topic_id as string) ?? undefined,
                chatId: row.chat_id as string,
                label: row.label as string,
                summary: row.summary as string,
                keyPoints: parseJsonSafe<string[]>(row.key_points as string, []),
                participants: parseJsonSafe<string[]>(row.participants as string, []),
                messageRange: {
                    messageIds,
                    count: (row.message_count as number) ?? messageIds.length,
                },
                startedAt: row.started_at as string,
                endedAt: (row.ended_at as string) ?? null,
                sentiment: (row.sentiment as TopicNode["sentiment"]) ?? "neutral",
                relatedTopicIds: parseJsonSafe<string[]>(row.related_topic_ids as string, []),
                keywords: parseJsonSafe<string[]>(row.keywords as string, []),
                associatedMemories: parseJsonSafe(row.associated_memories as string, []),
                callbackPotential: Number(row.callback_potential ?? 0),
                historyKey: (row.history_key as string) ?? null,
                createdAt: row.created_at as string,
                updatedAt: row.updated_at as string,
            };
        });
    }

    commitHistoricalClusterUnit(input: HistoryClusterCommitInput): HistoryClusterCommitResult {
        const run = this.db.transaction((): HistoryClusterCommitResult => {
            this.assertOwnedJob(input.jobId, "initialize", input.chatId, input.ownerToken);

            // Re-verify expected eligible messages exist and match digest
            const uniqueExpectedIds = [...new Set(input.expectedMessageIds)];
            const msgById = new Map<string, DigestMessageFields>();
            const CHUNK = 200;
            for (let i = 0; i < uniqueExpectedIds.length; i += CHUNK) {
                const chunk = uniqueExpectedIds.slice(i, i + CHUNK);
                const placeholders = chunk.map(() => "?").join(", ");
                const rows = this.db.prepare(`
                    SELECT message_id, user_id, timestamp, text, reply_to_message_id, mentions
                    FROM message_log
                    WHERE chat_id = ?
                      AND access_control_blocked = 0
                      AND message_id IN (${placeholders})
                `).all(input.chatId, ...chunk) as Array<{
                    message_id: string;
                    user_id: string;
                    timestamp: string;
                    text: string;
                    reply_to_message_id: string | null;
                    mentions: string | null;
                }>;
                for (const row of rows) {
                    msgById.set(row.message_id, {
                        messageId: row.message_id,
                        userId: row.user_id,
                        timestamp: row.timestamp,
                        text: row.text,
                        replyToMessageId: row.reply_to_message_id,
                        mentions: row.mentions,
                    });
                }
            }

            if (msgById.size !== uniqueExpectedIds.length) {
                throw new HistoryUnitStaleError(
                    `Historical cluster unit ${input.unitKey} stale: expected ${uniqueExpectedIds.length} eligible messages, found ${msgById.size}`,
                    input.unitKey,
                );
            }
            const orderedRows = input.expectedMessageIds.map(id => msgById.get(id)!);
            const actualDigest = computeMessagesDigest(orderedRows);
            if (actualDigest !== input.expectedDigest) {
                throw new HistoryUnitStaleError(
                    `Historical cluster unit ${input.unitKey} stale: message digest mismatch`,
                    input.unitKey,
                );
            }

            for (const pair of input.coveredPairs) {
                if (!msgById.has(pair.messageId)) {
                    throw new HistoryUnitStaleError(
                        `Covered message ${pair.messageId} not found in eligible unit ${input.unitKey}`,
                        input.unitKey,
                    );
                }
            }
            for (const topic of input.topics) {
                if (!topic.historyKey || !topic.historyKey.trim()) {
                    throw new Error(`Historical topic missing historyKey in unit ${input.unitKey}`);
                }
                for (const mid of topic.messageIds) {
                    if (!msgById.has(mid)) {
                        throw new HistoryUnitStaleError(
                            `Topic message ${mid} not found in eligible unit ${input.unitKey}`,
                            input.unitKey,
                        );
                    }
                }
            }

            const ts = nowIso();
            const selectExistingTopic = this.db.prepare(`
                SELECT id FROM topics WHERE chat_id = ? AND history_key = ?
            `);
            const updateTopicStmt = this.db.prepare(`
                UPDATE topics
                SET pipeline_topic_id = NULL,
                    label = ?,
                    summary = ?,
                    key_points = ?,
                    participants = ?,
                    keywords = ?,
                    message_ids = ?,
                    message_count = ?,
                    started_at = ?,
                    ended_at = ?,
                    sentiment = ?,
                    related_topic_ids = ?,
                    was_engaged = 0,
                    intervention_count = 0,
                    associated_memories = '[]',
                    callback_potential = 0,
                    updated_at = ?
                WHERE id = ?
            `);
            const insertTopicStmt = this.db.prepare(`
                INSERT INTO topics (
                    id, pipeline_topic_id, chat_id, label, summary, key_points, participants,
                    keywords, message_ids, message_count, started_at, ended_at, sentiment,
                    related_topic_ids, was_engaged, intervention_count, associated_memories,
                    callback_potential, history_key, embedding, created_at, updated_at
                )
                VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', 0, ?, NULL, ?, ?)
            `);
            const selectTopicFtsStmt = this.db.prepare(`
                SELECT rowid, label, summary, keywords FROM topics WHERE id = ?
            `);
            const deleteTopicFtsStmt = this.db.prepare(`
                DELETE FROM topics_fts WHERE rowid = ?
            `);
            const insertTopicFtsStmt = this.db.prepare(`
                INSERT INTO topics_fts(rowid, label, summary, keywords) VALUES (?, ?, ?, ?)
            `);

            const topicIdByHistoryKey = new Map<string, string>();
            const committedTopicIds: string[] = [];

            for (const topic of input.topics) {
                const existing = selectExistingTopic.get(input.chatId, topic.historyKey) as { id: string } | undefined;
                const topicId = existing?.id ?? topic.id ?? randomUUID();

                if (existing) {
                    updateTopicStmt.run(
                        topic.label,
                        topic.summary,
                        JSON.stringify(topic.keyPoints),
                        JSON.stringify(topic.participants),
                        JSON.stringify(topic.keywords),
                        JSON.stringify(topic.messageIds),
                        topic.messageIds.length,
                        topic.startedAt,
                        topic.endedAt,
                        topic.sentiment,
                        JSON.stringify(topic.relatedTopicIds ?? []),
                        ts,
                        topicId,
                    );
                } else {
                    insertTopicStmt.run(
                        topicId,
                        input.chatId,
                        topic.label,
                        topic.summary,
                        JSON.stringify(topic.keyPoints),
                        JSON.stringify(topic.participants),
                        JSON.stringify(topic.keywords),
                        JSON.stringify(topic.messageIds),
                        topic.messageIds.length,
                        topic.startedAt,
                        topic.endedAt,
                        topic.sentiment,
                        JSON.stringify(topic.relatedTopicIds ?? []),
                        topic.historyKey,
                        ts,
                        ts,
                    );
                }

                // Strict internal FTS sync: any error MUST roll back the entire transaction
                const ftsRow = selectTopicFtsStmt.get(topicId) as {
                    rowid: number;
                    label: string;
                    summary: string;
                    keywords: string;
                } | undefined;
                if (!ftsRow) {
                    throw new Error(`Topic row missing for FTS sync: ${topicId}`);
                }
                deleteTopicFtsStmt.run(ftsRow.rowid);
                insertTopicFtsStmt.run(ftsRow.rowid, ftsRow.label, ftsRow.summary, ftsRow.keywords);

                topicIdByHistoryKey.set(topic.historyKey, topicId);
                committedTopicIds.push(topicId);
            }

            const upsertCoverageStmt = this.db.prepare(`
                INSERT INTO history_cluster_coverage (chat_id, message_id, topic_id)
                VALUES (?, ?, ?)
                ON CONFLICT(chat_id, message_id) DO UPDATE SET
                    topic_id = excluded.topic_id
            `);
            let coveredCount = 0;
            for (const pair of input.coveredPairs) {
                const topicId = topicIdByHistoryKey.get(pair.topicHistoryKey);
                if (!topicId) {
                    throw new Error(`Missing committed topic for historyKey=${pair.topicHistoryKey}`);
                }
                upsertCoverageStmt.run(input.chatId, pair.messageId, topicId);
                coveredCount++;
            }

            this.completeHistoryUnitInTx(input.jobId, "cluster", input.unitKey, input.outputJson, ts);

            return {
                topicIds: committedTopicIds,
                coveredCount,
            };
        });
        return run();
    }

    commitHistoricalSynthesisUnit(input: HistorySynthesisCommitInput): HistorySynthesisCommitResult {
        const run = this.db.transaction((): HistorySynthesisCommitResult => {
            this.assertOwnedJob(input.jobId, "initialize", input.chatId, input.ownerToken);
            const ts = nowIso();

            // Storage-boundary historical fact allowlist enforcement
            const expectedSubject = `group:${input.chatId}`;
            for (const fact of input.factProposals) {
                if (!fact.historyKey || !fact.historyKey.trim()) {
                    throw new Error(`Historical fact missing historyKey in unit ${input.unitKey}`);
                }
                if (fact.category !== "anecdote" && fact.category !== "general") {
                    throw new Error(
                        `Historical fact category "${fact.category}" disallowed at storage boundary (only "anecdote" or "general" permitted)`,
                    );
                }
                if (fact.subject !== expectedSubject) {
                    throw new Error(
                        `Historical fact subject "${fact.subject}" disallowed at storage boundary (expected "${expectedSubject}")`,
                    );
                }
            }

            // Revalidate cited topics and sampled/cited messages inside the commit transaction
            const topicIdsToVerify = new Set<string>();
            const citedMsgsByTopic = new Map<string, Set<string>>();
            const addCitationCheck = (topicId: string | null | undefined, messageIds: readonly string[]) => {
                if (!topicId) {
                    if (messageIds.length > 0) {
                        throw new HistoryUnitStaleError(`Synthesis citation missing topicId in unit ${input.unitKey}`, input.unitKey);
                    }
                    return;
                }
                topicIdsToVerify.add(topicId);
                let set = citedMsgsByTopic.get(topicId);
                if (!set) {
                    set = new Set<string>();
                    citedMsgsByTopic.set(topicId, set);
                }
                for (const mid of messageIds) {
                    set.add(mid);
                }
            };

            for (const ev of input.expectedEvidence ?? []) {
                addCitationCheck(ev.topicId, ev.sampledMessageIds);
            }
            for (const cit of input.groupPatchCitations ?? []) {
                addCitationCheck(cit.topicId, cit.messageIds);
            }
            for (const mp of input.memberPatches) {
                for (const ep of mp.episodes ?? []) {
                    addCitationCheck(ep.topicId, ep.messageIds);
                }
            }
            for (const fact of input.factProposals) {
                addCitationCheck(fact.sourceTopicId, fact.sourceMessageIds);
            }

            const topicMessageRangeMap = new Map<string, Set<string>>();
            const selectTopicCheckStmt = this.db.prepare(`
                SELECT id, message_ids
                FROM topics
                WHERE id = ? AND chat_id = ? AND history_key IS NOT NULL
            `);
            for (const tid of topicIdsToVerify) {
                const tRow = selectTopicCheckStmt.get(tid, input.chatId) as { id: string; message_ids: string } | undefined;
                if (!tRow) {
                    throw new HistoryUnitStaleError(
                        `Cited historical topic ${tid} no longer exists in chat ${input.chatId}`,
                        input.unitKey,
                    );
                }
                topicMessageRangeMap.set(tid, new Set(parseJsonSafe<string[]>(tRow.message_ids, [])));
            }

            const allCheckMessageIds = new Set<string>();
            for (const [tid, msgSet] of citedMsgsByTopic.entries()) {
                const topicMsgs = topicMessageRangeMap.get(tid)!;
                for (const mid of msgSet) {
                    if (!topicMsgs.has(mid)) {
                        throw new HistoryUnitStaleError(
                            `Cited message ${mid} is not in topic ${tid} message range`,
                            input.unitKey,
                        );
                    }
                    allCheckMessageIds.add(mid);
                }
            }

            const liveMessagesById = new Map<string, DigestMessageFields>();
            const checkIdsArr = [...allCheckMessageIds];
            const CHUNK = 200;
            for (let i = 0; i < checkIdsArr.length; i += CHUNK) {
                const chunk = checkIdsArr.slice(i, i + CHUNK);
                const placeholders = chunk.map(() => "?").join(", ");
                const rows = this.db.prepare(`
                    SELECT message_id, user_id, timestamp, text, reply_to_message_id, mentions
                    FROM message_log
                    WHERE chat_id = ?
                      AND access_control_blocked = 0
                      AND message_id IN (${placeholders})
                `).all(input.chatId, ...chunk) as Array<{
                    message_id: string;
                    user_id: string;
                    timestamp: string;
                    text: string;
                    reply_to_message_id: string | null;
                    mentions: string | null;
                }>;
                for (const row of rows) {
                    liveMessagesById.set(row.message_id, {
                        messageId: row.message_id,
                        userId: row.user_id,
                        timestamp: row.timestamp,
                        text: row.text,
                        replyToMessageId: row.reply_to_message_id,
                        mentions: row.mentions,
                    });
                }
            }

            for (const mid of checkIdsArr) {
                if (!liveMessagesById.has(mid)) {
                    throw new HistoryUnitStaleError(
                        `Cited/sampled message ${mid} missing or access-blocked in chat ${input.chatId}`,
                        input.unitKey,
                    );
                }
            }

            for (const ev of input.expectedEvidence ?? []) {
                const ordered = ev.sampledMessageIds.map(mid => liveMessagesById.get(mid)!);
                const actualDigest = computeMessagesDigest(ordered);
                if (actualDigest !== ev.evidenceDigest) {
                    throw new HistoryUnitStaleError(
                        `Historical synthesis unit ${input.unitKey} stale: evidence digest mismatch for topic ${ev.topicId}`,
                        input.unitKey,
                    );
                }
            }

            const selectSeedStmt = this.db.prepare(`
                SELECT rank_key, value_hash
                FROM history_seed_fields
                WHERE chat_id = ? AND entity_kind = ? AND entity_id = ? AND field = ?
            `);
            const upsertSeedStmt = this.db.prepare(`
                INSERT INTO history_seed_fields (chat_id, entity_kind, entity_id, field, rank_key, value_hash)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(chat_id, entity_kind, entity_id, field) DO UPDATE SET
                    rank_key = excluded.rank_key,
                    value_hash = excluded.value_hash
            `);

            // 1. GroupModel guarded update under exact input.chatId (never touch last_reflected_at!)
            const groupFieldsWritten: string[] = [];
            let groupRow = this.db.prepare("SELECT * FROM group_models WHERE chat_id = ?")
                .get(input.chatId) as Record<string, unknown> | undefined;

            const guildKey = safeGroupModelKey(input.chatId);
            const baseGuildRow = guildKey !== input.chatId
                ? (this.db.prepare("SELECT chat_title, is_direct_message, marked_sensitive, sensitive_reason, sensitive_at FROM group_models WHERE chat_id = ?").get(guildKey) as Record<string, unknown> | undefined)
                : undefined;

            if (!groupRow) {
                this.db.prepare(`
                    INSERT INTO group_models (
                        chat_id, chat_title, description, dominant_language, communication_norms,
                        active_members, avg_messages_per_day, peak_hours, agent_role,
                        engagement_level, recent_feedback, hot_topics, taboo_topics,
                        last_reflected_at, is_direct_message, marked_sensitive, sensitive_reason, sensitive_at, quiet_mode, updated_at
                    ) VALUES (?, ?, '', 'zh', '[]', 0, 0, '[]', '', 'medium', '', '[]', '[]', NULL, ?, ?, ?, ?, 0, ?)
                `).run(
                    input.chatId,
                    (baseGuildRow?.chat_title as string) ?? "",
                    (baseGuildRow?.is_direct_message as number) ?? 0,
                    (baseGuildRow?.marked_sensitive as number) ?? 0,
                    (baseGuildRow?.sensitive_reason as string) ?? null,
                    (baseGuildRow?.sensitive_at as string) ?? null,
                    ts,
                );
                groupRow = this.db.prepare("SELECT * FROM group_models WHERE chat_id = ?")
                    .get(input.chatId) as Record<string, unknown>;
            }

            const hasLastReflected = Boolean(groupRow.last_reflected_at);
            const groupSets: Array<{ col: string; val: unknown }> = [];

            const tryGroupScalarField = (
                field: string,
                col: string,
                currentRaw: unknown,
                incoming: string | undefined,
                isDefaultWhenNeverSeeded: (cur: string) => boolean,
            ) => {
                const cleanIncoming = typeof incoming === "string" ? incoming.trim() : "";
                if (!cleanIncoming) return;
                const current = typeof currentRaw === "string" ? currentRaw : "";
                const currentHash = hashSeedValue(current);
                const seedRow = selectSeedStmt.get(input.chatId, "group", input.chatId, field) as
                    | { rank_key: string; value_hash: string }
                    | undefined;
                const canWrite = seedRow === undefined
                    ? isDefaultWhenNeverSeeded(current)
                    : (seedRow.value_hash === currentHash && input.rankKey >= seedRow.rank_key);
                if (!canWrite) return;
                groupSets.push({ col, val: cleanIncoming });
                upsertSeedStmt.run(input.chatId, "group", input.chatId, field, input.rankKey, hashSeedValue(cleanIncoming));
                groupFieldsWritten.push(field);
            };

            const tryGroupListField = (
                field: string,
                col: string,
                currentRaw: unknown,
                incoming: string[] | undefined,
            ) => {
                const cleanIncoming = dedupeCapStrings(incoming ?? [], MAX_GROUP_LIST_SEED_ITEMS);
                if (cleanIncoming.length === 0) return;
                const current = parseJsonSafe<string[]>(currentRaw as string, []);
                const currentHash = hashSeedValue(current);
                const seedRow = selectSeedStmt.get(input.chatId, "group", input.chatId, field) as
                    | { rank_key: string; value_hash: string }
                    | undefined;
                const isEmpty = current.length === 0;
                const canWrite = seedRow === undefined
                    ? isEmpty
                    : (seedRow.value_hash === currentHash && input.rankKey >= seedRow.rank_key);
                if (!canWrite) return;
                const nextVal = isEmpty
                    ? cleanIncoming
                    : dedupeCapStrings([...cleanIncoming, ...current], MAX_GROUP_LIST_SEED_ITEMS);
                groupSets.push({ col, val: JSON.stringify(nextVal) });
                upsertSeedStmt.run(input.chatId, "group", input.chatId, field, input.rankKey, hashSeedValue(nextVal));
                groupFieldsWritten.push(field);
            };

            const gp = input.groupPatch ?? {};
            tryGroupScalarField(
                "description",
                "description",
                groupRow.description,
                gp.description,
                (cur) => cur.trim() === "",
            );
            tryGroupScalarField(
                "dominantLanguage",
                "dominant_language",
                groupRow.dominant_language,
                gp.dominantLanguage,
                (cur) => cur.trim() === "" || (!hasLastReflected && cur === "zh"),
            );
            tryGroupScalarField(
                "engagementLevel",
                "engagement_level",
                groupRow.engagement_level,
                gp.engagementLevel,
                (cur) => cur.trim() === "" || (!hasLastReflected && cur === "medium"),
            );
            tryGroupListField("communicationNorms", "communication_norms", groupRow.communication_norms, gp.communicationNorms);
            tryGroupListField("hotTopics", "hot_topics", groupRow.hot_topics, gp.hotTopics);
            tryGroupListField("tabooTopics", "taboo_topics", groupRow.taboo_topics, gp.tabooTopics);
            // Hard-coded newcomer observer agentRole at storage boundary (never accept caller-supplied agentRole)
            tryGroupScalarField(
                "agentRole",
                "agent_role",
                groupRow.agent_role,
                NEWCOMER_AGENT_ROLE,
                (cur) => cur.trim() === "",
            );

            if (groupSets.length > 0) {
                const setSql = groupSets.map(s => `${s.col} = ?`).join(", ");
                this.db.prepare(`
                    UPDATE group_models
                    SET ${setSql}, updated_at = ?
                    WHERE chat_id = ?
                `).run(...groupSets.map(s => s.val), ts, input.chatId);
            }

            // 2. PersonGroupProfile guarded update + Hard-Coded Newcomer Guard
            let membersUpdated = 0;
            const selectMemberStmt = this.db.prepare(`
                SELECT * FROM person_group_profiles WHERE user_id = ? AND chat_id = ?
            `);
            const insertMemberStmt = this.db.prepare(`
                INSERT INTO person_group_profiles (
                    user_id, chat_id, dunbar_tier, dunbar_reason, affinity_score,
                    traits, interests, communication_style, relation_to_agent,
                    recent_episodes, merged_memory, message_count, last_seen_at,
                    active_hours, first_seen_at, updated_at
                )
                VALUES (?, ?, 4, '', 0, '[]', '[]', '', '', '[]', '[]', 0, ?, '[]', ?, ?)
            `);
            const countLiveInteractionsStmt = this.db.prepare(`
                SELECT COUNT(*) as cnt
                FROM interactions
                WHERE chat_id = ? AND user_id = ? AND type != 'agent_replied'
            `);

            for (const mp of input.memberPatches) {
                const uid = mp.userId?.trim();
                if (!uid) continue;

                let existing = selectMemberStmt.get(uid, input.chatId) as Record<string, unknown> | undefined;
                if (!existing) {
                    insertMemberStmt.run(uid, input.chatId, ts, ts, ts);
                    existing = selectMemberStmt.get(uid, input.chatId) as Record<string, unknown>;
                }

                const existingEpisodes = parseJsonSafe<InteractionEpisode[]>(existing.recent_episodes as string, []);
                const liveInteractions = (countLiveInteractionsStmt.get(input.chatId, uid) as { cnt: number }).cnt > 0;
                const hasLiveEpisode = existingEpisodes.some(ep => ep.origin !== "offline_history");
                const hasLiveRelationFields =
                    (typeof existing.relation_to_agent === "string" && existing.relation_to_agent.trim() !== "")
                    || Number(existing.affinity_score ?? 0) > 0
                    || Number(existing.dunbar_tier ?? 4) < 4;
                const hasLiveRelationshipEvidence = liveInteractions || hasLiveEpisode || hasLiveRelationFields;

                const memberSets: Array<{ col: string; val: unknown }> = [];
                if (!hasLiveRelationshipEvidence) {
                    memberSets.push({ col: "dunbar_tier", val: 4 });
                    memberSets.push({ col: "affinity_score", val: 0 });
                    memberSets.push({ col: "dunbar_reason", val: "" });
                    memberSets.push({ col: "relation_to_agent", val: "" });
                }

                // Guarded traits (never overwrite if seedRow exists & live/manual cleared or edited)
                const incomingTraits = dedupeCapStrings(mp.traits ?? [], MAX_MEMBER_LIST_SEED_ITEMS);
                if (incomingTraits.length > 0) {
                    const curTraits = parseJsonSafe<string[]>(existing.traits as string, []);
                    const curHash = hashSeedValue(curTraits);
                    const seedRow = selectSeedStmt.get(input.chatId, "member", uid, "traits") as
                        | { rank_key: string; value_hash: string }
                        | undefined;
                    const isEmpty = curTraits.length === 0;
                    const canWrite = seedRow === undefined
                        ? isEmpty
                        : (seedRow.value_hash === curHash && input.rankKey >= seedRow.rank_key);
                    if (canWrite) {
                        const nextTraits = isEmpty
                            ? incomingTraits
                            : dedupeCapStrings([...incomingTraits, ...curTraits], MAX_MEMBER_LIST_SEED_ITEMS);
                        memberSets.push({ col: "traits", val: JSON.stringify(nextTraits) });
                        upsertSeedStmt.run(input.chatId, "member", uid, "traits", input.rankKey, hashSeedValue(nextTraits));
                    }
                }

                // Guarded interests
                const incomingInterests = dedupeCapStrings(mp.interests ?? [], MAX_MEMBER_LIST_SEED_ITEMS);
                if (incomingInterests.length > 0) {
                    const curInterests = parseJsonSafe<string[]>(existing.interests as string, []);
                    const curHash = hashSeedValue(curInterests);
                    const seedRow = selectSeedStmt.get(input.chatId, "member", uid, "interests") as
                        | { rank_key: string; value_hash: string }
                        | undefined;
                    const isEmpty = curInterests.length === 0;
                    const canWrite = seedRow === undefined
                        ? isEmpty
                        : (seedRow.value_hash === curHash && input.rankKey >= seedRow.rank_key);
                    if (canWrite) {
                        const nextInterests = isEmpty
                            ? incomingInterests
                            : dedupeCapStrings([...incomingInterests, ...curInterests], MAX_MEMBER_LIST_SEED_ITEMS);
                        memberSets.push({ col: "interests", val: JSON.stringify(nextInterests) });
                        upsertSeedStmt.run(input.chatId, "member", uid, "interests", input.rankKey, hashSeedValue(nextInterests));
                    }
                }

                // Guarded communicationStyle
                const incomingStyle = typeof mp.communicationStyle === "string" ? mp.communicationStyle.trim() : "";
                if (incomingStyle) {
                    const curStyle = typeof existing.communication_style === "string" ? existing.communication_style : "";
                    const curHash = hashSeedValue(curStyle);
                    const seedRow = selectSeedStmt.get(input.chatId, "member", uid, "communicationStyle") as
                        | { rank_key: string; value_hash: string }
                        | undefined;
                    const isEmpty = curStyle.trim() === "";
                    const canWrite = seedRow === undefined
                        ? isEmpty
                        : (seedRow.value_hash === curHash && input.rankKey >= seedRow.rank_key);
                    if (canWrite) {
                        memberSets.push({ col: "communication_style", val: incomingStyle });
                        upsertSeedStmt.run(input.chatId, "member", uid, "communicationStyle", input.rankKey, hashSeedValue(incomingStyle));
                    }
                }

                // Offline episodes: merge by deterministic ID, cap separately, preserve all live episodes intact
                if (mp.episodes && mp.episodes.length > 0) {
                    const liveEps = existingEpisodes.filter(ep => ep.origin !== "offline_history");
                    const offlineMap = new Map<string, InteractionEpisode>();
                    for (const ep of existingEpisodes) {
                        if (ep.origin === "offline_history") {
                            offlineMap.set(ep.id, ep);
                        }
                    }
                    for (const incomingEp of mp.episodes) {
                        offlineMap.set(incomingEp.id, {
                            id: incomingEp.id,
                            date: incomingEp.date,
                            chatId: input.chatId,
                            userId: uid,
                            topicId: incomingEp.topicId,
                            type: "reaction",
                            summary: incomingEp.summary,
                            sentiment: incomingEp.sentiment,
                            significance: incomingEp.significance,
                            ...(incomingEp.displayName ? { displayName: incomingEp.displayName } : {}),
                            direction: "ambient",
                            messageIds: incomingEp.messageIds,
                            ...(incomingEp.topicLabel ? { topicLabel: incomingEp.topicLabel } : {}),
                            origin: "offline_history",
                        });
                    }
                    const cappedOffline = [...offlineMap.values()]
                        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
                        .slice(-MAX_OFFLINE_EPISODES);
                    memberSets.push({ col: "recent_episodes", val: JSON.stringify([...liveEps, ...cappedOffline]) });
                }

                if (memberSets.length > 0) {
                    const setSql = memberSets.map(s => `${s.col} = ?`).join(", ");
                    this.db.prepare(`
                        UPDATE person_group_profiles
                        SET ${setSql}, updated_at = ?
                        WHERE user_id = ? AND chat_id = ?
                    `).run(...memberSets.map(s => s.val), ts, uid, input.chatId);
                    membersUpdated++;
                }
            }

            // 3. Historical core_facts atomic commit + live sensitivity check + stale embedding invalidation + strict FTS sync
            const liveSensitive = input.isPrivateOrSensitive
                || Boolean(groupRow.is_direct_message)
                || Boolean(groupRow.marked_sensitive)
                || Boolean(baseGuildRow?.is_direct_message)
                || Boolean(baseGuildRow?.marked_sensitive);
            const chatTitle = (groupRow.chat_title as string) || input.chatId;
            const visibility = liveSensitive ? "private" : "contextual";
            const selectFactByKey = this.db.prepare(`
                SELECT id, subject, content FROM core_facts WHERE source_chat_id = ? AND history_key = ?
            `);
            const selectFactById = this.db.prepare(`
                SELECT id, history_key FROM core_facts WHERE id = ?
            `);
            const updateFactStmt = this.db.prepare(`
                UPDATE core_facts
                SET subject = ?,
                    content = ?,
                    category = ?,
                    confidence = ?,
                    source = 'offline_history',
                    source_chat_title = ?,
                    source_topic_id = ?,
                    source_topic_label = ?,
                    source_message_ids = ?,
                    source_interaction_ids = '[]',
                    observed_at = ?,
                    visibility = ?,
                    sensitivity = ?,
                    embedding = CASE WHEN ? = 1 THEN NULL ELSE embedding END,
                    updated_at = ?
                WHERE id = ?
            `);
            const insertFactStmt = this.db.prepare(`
                INSERT INTO core_facts (
                    id, subject, content, category, confidence, source,
                    source_chat_id, source_chat_title, source_topic_id, source_topic_label,
                    source_message_ids, source_interaction_ids, observed_at,
                    visibility, sensitivity, history_key, embedding, created_at, updated_at, expires_at
                )
                VALUES (?, ?, ?, ?, ?, 'offline_history', ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, NULL, ?, ?, NULL)
            `);
            const selectFactFtsStmt = this.db.prepare(`
                SELECT rowid, content, subject FROM core_facts WHERE id = ?
            `);
            const deleteFactFtsStmt = this.db.prepare(`
                DELETE FROM core_facts_fts WHERE rowid = ?
            `);
            const insertFactFtsStmt = this.db.prepare(`
                INSERT INTO core_facts_fts(rowid, content, subject) VALUES (?, ?, ?)
            `);
            const deleteFactVecStmt = this.isSqliteVecAvailable()
                ? this.db.prepare(`DELETE FROM facts_vec WHERE fact_id = ?`)
                : null;

            let factsCommitted = 0;
            for (const fact of input.factProposals) {
                const existingByKey = selectFactByKey.get(input.chatId, fact.historyKey) as
                    | { id: string; subject: string; content: string }
                    | undefined;
                if (!existingByKey && fact.id) {
                    const existingById = selectFactById.get(fact.id) as { id: string; history_key: string | null } | undefined;
                    if (existingById && existingById.history_key === null) {
                        // Never overwrite a live fact
                        continue;
                    }
                }
                const factId = existingByKey?.id ?? fact.id ?? randomUUID();
                const confidence = fact.confidence ?? 0.85;
                const sensitivity = fact.sensitivity ?? "low";
                const msgIdsJson = JSON.stringify(fact.sourceMessageIds);

                if (existingByKey) {
                    const contentChanged = existingByKey.content !== fact.content || existingByKey.subject !== fact.subject;
                    updateFactStmt.run(
                        fact.subject,
                        fact.content,
                        fact.category,
                        confidence,
                        chatTitle,
                        fact.sourceTopicId,
                        fact.sourceTopicLabel ?? null,
                        msgIdsJson,
                        fact.observedAt,
                        visibility,
                        sensitivity,
                        contentChanged ? 1 : 0,
                        ts,
                        factId,
                    );
                    if (contentChanged && deleteFactVecStmt) {
                        deleteFactVecStmt.run(factId);
                    }
                } else {
                    insertFactStmt.run(
                        factId,
                        fact.subject,
                        fact.content,
                        fact.category,
                        confidence,
                        input.chatId,
                        chatTitle,
                        fact.sourceTopicId,
                        fact.sourceTopicLabel ?? null,
                        msgIdsJson,
                        fact.observedAt,
                        visibility,
                        sensitivity,
                        fact.historyKey,
                        ts,
                        ts,
                    );
                }

                // Strict internal FTS sync: throws & rolls back on error
                const ftsRow = selectFactFtsStmt.get(factId) as {
                    rowid: number;
                    content: string;
                    subject: string;
                } | undefined;
                if (!ftsRow) {
                    throw new Error(`Fact row missing for FTS sync: ${factId}`);
                }
                deleteFactFtsStmt.run(ftsRow.rowid);
                insertFactFtsStmt.run(ftsRow.rowid, ftsRow.content, ftsRow.subject);
                factsCommitted++;
            }

            this.completeHistoryUnitInTx(input.jobId, "synthesize", input.unitKey, input.outputJson, ts);

            return {
                groupFieldsWritten,
                membersUpdated,
                factsCommitted,
            };
        });
        return run();
    }

    commitHistoricalEmbeddingUnit(input: HistoryEmbeddingCommitInput): void {
        const run = this.db.transaction(() => {
            this.assertOwnedJob(input.jobId, "initialize", input.chatId, input.ownerToken);

            if (!(input.embedding instanceof Float32Array) || input.embedding.length === 0) {
                throw new Error(`Invalid embedding for ${input.unitKey}: expected non-empty Float32Array`);
            }
            if (input.expectedDimensions > 0 && input.embedding.length !== input.expectedDimensions) {
                throw new Error(
                    `Embedding dimension mismatch for ${input.unitKey}: expected ${input.expectedDimensions}, got ${input.embedding.length}`,
                );
            }
            for (let i = 0; i < input.embedding.length; i++) {
                if (!Number.isFinite(input.embedding[i])) {
                    throw new Error(`Non-finite embedding value at index ${i} for ${input.unitKey}`);
                }
            }

            const buf = embeddingToBuffer(input.embedding);
            const ts = nowIso();

            if (input.kind === "topic") {
                const row = this.db.prepare(`
                    SELECT id, label, summary
                    FROM topics
                    WHERE id = ? AND chat_id = ? AND history_key IS NOT NULL
                `).get(input.targetId, input.chatId) as { id: string; label: string; summary: string } | undefined;
                if (!row) {
                    throw new HistoryUnitStaleError(
                        `Historical topic ${input.targetId} missing in chat ${input.chatId}`,
                        input.unitKey,
                    );
                }
                const liveText = `${row.label} ${row.summary}`.trim();
                if (computeEmbeddingContentHash(liveText) !== input.expectedContentHash) {
                    throw new HistoryUnitStaleError(
                        `Historical topic ${input.targetId} text changed since embedding generation`,
                        input.unitKey,
                    );
                }
                this.db.prepare(`UPDATE topics SET embedding = ?, updated_at = ? WHERE id = ?`).run(buf, ts, row.id);
                if (this.isSqliteVecAvailable()) {
                    this.db.prepare(`DELETE FROM topics_vec WHERE topic_id = ?`).run(row.id);
                    this.db.prepare(`INSERT INTO topics_vec(topic_id, chat_id, embedding) VALUES (?, ?, ?)`).run(
                        row.id,
                        input.chatId,
                        buf,
                    );
                }
            } else {
                const row = this.db.prepare(`
                    SELECT id, subject, content
                    FROM core_facts
                    WHERE id = ? AND source_chat_id = ? AND history_key IS NOT NULL
                      AND (expires_at IS NULL OR expires_at > datetime('now'))
                `).get(input.targetId, input.chatId) as { id: string; subject: string; content: string } | undefined;
                if (!row) {
                    throw new HistoryUnitStaleError(
                        `Historical fact ${input.targetId} missing or expired in chat ${input.chatId}`,
                        input.unitKey,
                    );
                }
                const liveText = `${row.subject}: ${row.content}`.trim();
                if (computeEmbeddingContentHash(liveText) !== input.expectedContentHash) {
                    throw new HistoryUnitStaleError(
                        `Historical fact ${input.targetId} text changed since embedding generation`,
                        input.unitKey,
                    );
                }
                this.db.prepare(`UPDATE core_facts SET embedding = ?, updated_at = ? WHERE id = ?`).run(buf, ts, row.id);
                if (this.isSqliteVecAvailable()) {
                    this.db.prepare(`DELETE FROM facts_vec WHERE fact_id = ?`).run(row.id);
                    this.db.prepare(`INSERT INTO facts_vec(fact_id, embedding) VALUES (?, ?)`).run(row.id, buf);
                }
            }

            this.completeHistoryUnitInTx(input.jobId, "embed", input.unitKey, input.outputJson, ts);
        });
        run();
    }

    private completeHistoryUnitInTx(
        jobId: string,
        stage: HistoryUnitStage,
        unitKey: string,
        outputJson: string,
        ts: string,
    ): void {
        const res = this.db.prepare(`
            UPDATE history_units
            SET output_json = ?, completed_at = ?
            WHERE job_id = ? AND stage = ? AND unit_key = ?
        `).run(outputJson, ts, jobId, stage, unitKey);
        if (res.changes !== 1) {
            throw new HistoryUnitStaleError(
                `History unit not found for completion: ${jobId}/${stage}/${unitKey}`,
                unitKey,
            );
        }
    }
}

function hashSeedValue(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function dedupeCapStrings(values: readonly string[], cap: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= cap) break;
    }
    return out;
}
