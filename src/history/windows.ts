import { createHash } from "node:crypto";
import { getRawId } from "../core/chat-id.js";
import { loadConfig } from "../core/config.js";
import { readMessageMentions } from "../core/message-provenance.js";
import { getGlobalTimezone } from "../core/timezone.js";
import { computeMessagesDigest, type DigestMessageFields } from "../memory-v2/history-store.js";
import type { MemoryStoreV2 } from "../memory-v2/memory-v2.js";
import type { TopicNode } from "../memory-v2/types.js";
import { HistoryUsageError } from "./errors.js";
import { assertValidIanaTimezone, parseStrictTimestampMs } from "./time-utils.js";

export interface HistoryWindowConfig {
    windowMessages?: number;
    windowHours?: number;
    gapMinutes?: number;
    /** Windows smaller than this are folded into the nearer neighbour; 0 disables. */
    minWindowMessages?: number;
    since?: string;
    until?: string;
    timezone?: string;
}

export interface HistoryMessageRow {
    messageId: string;
    chatId: string;
    userId: string;
    displayName: string;
    text: string;
    replyToMessageId: string | null;
    timestamp: string;
    timestampMs: number;
    mentions: string | null;
    mediaType: string | null;
    mediaInfo: string | null;
    qceMeta: string | null;
}

export interface HistoryWindow {
    unitKey: string;
    messages: HistoryMessageRow[];
    messageIds: string[];
    startedAt: string;
    endedAt: string;
    inputDigest: string;
}

export interface SampledSynthesisMessage {
    messageId: string;
    userId: string;
    displayName: string;
    timestamp: string;
    text: string;
    replyToMessageId: string | null;
    mentionsText: string;
}

export interface SynthesisTopicBlock {
    topic: TopicNode;
    allTopicMessages: HistoryMessageRow[];
    sampledRawMessages: HistoryMessageRow[];
    sampledMessages: SampledSynthesisMessage[];
    eligibleMessageIds: Set<string>;
    eligibleParticipants: Set<string>;
    evidenceDigest: string;
}

export interface SynthesisMacroBatch {
    unitKey: string;
    isoWeek: string;
    rankKey: string;
    topics: TopicNode[];
    topicBlocks: SynthesisTopicBlock[];
    inputJson: string;
}

export interface SkippedPartialTopic {
    topicId: string;
    label: string;
    reason: string;
}

export interface BuildSynthesisMacroBatchesResult {
    batches: SynthesisMacroBatch[];
    skippedPartialTopics: SkippedPartialTopic[];
}

export const DEFAULT_WINDOW_MESSAGES = 120;
export const DEFAULT_WINDOW_HOURS = 4;
export const DEFAULT_GAP_MINUTES = 30;
export const DEFAULT_MIN_WINDOW_MESSAGES = 10;
export const DEFAULT_MAX_TOPICS_PER_BATCH = 24;
export const DEFAULT_MAX_SAMPLE_MESSAGES_PER_TOPIC = 12;
export const SYNTHESIS_PROMPT_REVISION = "synth-v2";

interface ParsedQceMetaFlags {
    timeUnknown?: boolean;
    recalled?: boolean;
    system?: boolean;
    hasForward?: boolean;
    evidenceText?: string;
}

function parseQceMetaFlags(raw: string | null | undefined): ParsedQceMetaFlags {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as ParsedQceMetaFlags;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export function isEligibleHistoryMessageRow(row: {
    userId: string;
    timestamp: string;
    timestampMs: number;
    qceMeta: string | null;
}): boolean {
    if (!row.userId || row.userId === "system") return false;
    if (row.timestamp === "1970-01-01T00:00:00.000Z") return false;
    if (!Number.isFinite(row.timestampMs) || row.timestampMs <= 86_400_000) return false;
    const meta = parseQceMetaFlags(row.qceMeta);
    if (meta.timeUnknown === true) return false;
    if (meta.recalled === true) return false;
    if (meta.system === true) return false;
    return true;
}

function resolveCanonicalWindowTimezone(explicitTimezone?: string): string {
    let configTz: string | undefined;
    try {
        configTz = loadConfig().timezone;
    } catch {
        configTz = undefined;
    }
    return assertValidIanaTimezone(explicitTimezone ?? configTz ?? getGlobalTimezone() ?? "UTC");
}

function parseOptionalBoundaryMs(raw: string | undefined, timezone: string, name: string): number | undefined {
    if (raw === undefined) return undefined;
    return parseStrictTimestampMs(raw, timezone, name);
}

export function loadEligibleHistoryMessages(
    memory: MemoryStoreV2,
    chatId: string,
    options: { since?: string; until?: string; timezone?: string } = {},
): HistoryMessageRow[] {
    const timezone = resolveCanonicalWindowTimezone(options.timezone);
    const sinceMs = parseOptionalBoundaryMs(options.since, timezone, "since");
    const untilMs = parseOptionalBoundaryMs(options.until, timezone, "until");
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs >= untilMs) {
        throw new HistoryUsageError(
            `Invalid date range: since (${options.since}) must be earlier than until (${options.until})`,
        );
    }

    const result: HistoryMessageRow[] = [];
    let cursor: { timestampMs: number; messageId: string } | null = null;
    const PAGE_SIZE = 500;

    while (true) {
        const page = memory.listEligibleHistoryMessagePage(chatId, cursor, PAGE_SIZE, {
            sinceMs,
            untilMs,
        });
        if (page.length === 0) break;

        for (const row of page) {
            cursor = { timestampMs: row.timestampMs, messageId: row.messageId };
            if (!isEligibleHistoryMessageRow(row)) continue;
            if (sinceMs !== undefined && row.timestampMs < sinceMs) continue;
            if (untilMs !== undefined && row.timestampMs >= untilMs) continue;
            result.push(row);
        }

        if (page.length < PAGE_SIZE) break;
    }

    return result;
}

export function toDigestFields(messages: readonly HistoryMessageRow[]): DigestMessageFields[] {
    return messages.map(m => ({
        messageId: m.messageId,
        userId: m.userId,
        timestamp: m.timestamp,
        text: m.text,
        replyToMessageId: m.replyToMessageId,
        mentions: m.mentions,
    }));
}

/**
 * Fold windows below `minMessages` into a neighbour so a handful of stray
 * late-night messages does not cost its own pair of LLM calls. A tiny window
 * joins whichever side is closer in time, as long as the result still fits
 * `maxMessages`; the gap and duration limits are deliberately not re-applied.
 */
function mergeTinyGroups(
    groups: HistoryMessageRow[][],
    minMessages: number,
    maxMessages: number,
): HistoryMessageRow[][] {
    if (minMessages <= 1 || groups.length <= 1) return groups;
    const merged: HistoryMessageRow[][] = [];
    for (let i = 0; i < groups.length; i++) {
        const cur = groups[i];
        const prev = merged[merged.length - 1];
        if (!prev || prev.length + cur.length > maxMessages) {
            merged.push([...cur]);
            continue;
        }
        const prevTiny = prev.length < minMessages;
        const curTiny = cur.length < minMessages;
        if (!prevTiny && !curTiny) {
            merged.push([...cur]);
            continue;
        }
        const next = groups[i + 1];
        const prefersNext = curTiny && !prevTiny && next !== undefined
            && cur.length + next.length <= maxMessages
            && (next[0].timestampMs - cur[cur.length - 1].timestampMs)
                < (cur[0].timestampMs - prev[prev.length - 1].timestampMs);
        if (prefersNext) {
            merged.push([...cur]);
        } else {
            prev.push(...cur);
        }
    }
    return merged;
}

export function buildHistoryWindows(
    messages: readonly HistoryMessageRow[],
    config: HistoryWindowConfig = {},
): HistoryWindow[] {
    if (messages.length === 0) return [];

    const windowMessages = Math.max(1, Math.floor(config.windowMessages ?? DEFAULT_WINDOW_MESSAGES));
    const windowHours = Math.max(1 / 60, config.windowHours ?? DEFAULT_WINDOW_HOURS);
    const gapMinutes = Math.max(1, config.gapMinutes ?? DEFAULT_GAP_MINUTES);
    const maxSpanMs = windowHours * 3_600_000;
    const maxGapMs = gapMinutes * 60_000;
    const minWindowMessages = Math.min(
        Math.max(0, Math.floor(config.minWindowMessages ?? DEFAULT_MIN_WINDOW_MESSAGES)),
        Math.floor(windowMessages / 2),
    );

    const sorted = [...messages].sort((a, b) =>
        (a.timestampMs - b.timestampMs)
        || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0),
    );

    const groups: HistoryMessageRow[][] = [];
    let current: HistoryMessageRow[] = [];

    const flushCurrent = () => {
        if (current.length === 0) return;
        groups.push(current);
        current = [];
    };

    for (const msg of sorted) {
        if (current.length === 0) {
            current.push(msg);
            continue;
        }
        const first = current[0];
        const prev = current[current.length - 1];
        const gapExceeded = (msg.timestampMs - prev.timestampMs) > maxGapMs;
        const durationExceeded = (msg.timestampMs - first.timestampMs) >= maxSpanMs;
        const countExceeded = current.length >= windowMessages;
        if (gapExceeded || durationExceeded || countExceeded) {
            flushCurrent();
        }
        current.push(msg);
    }
    flushCurrent();

    return mergeTinyGroups(groups, minWindowMessages, windowMessages).map((group) => {
        const first = group[0];
        const last = group[group.length - 1];
        const inputDigest = computeMessagesDigest(toDigestFields(group));
        return {
            unitKey: `cluster:${first.messageId}:${last.messageId}:${inputDigest.slice(0, 12)}`,
            messages: group,
            messageIds: group.map(m => m.messageId),
            startedAt: first.timestamp,
            endedAt: last.timestamp,
            inputDigest,
        };
    });
}

export function selectWindowsForMode(
    windows: readonly HistoryWindow[],
    mode: "quick" | "full",
    coveredIds: ReadonlySet<string>,
    config: HistoryWindowConfig = {},
): HistoryWindow[] {
    if (windows.length === 0) return [];

    // Filter out messages already in coveredIds and re-window uncovered messages cleanly
    let uncoveredWindows: HistoryWindow[];
    if (coveredIds.size === 0) {
        uncoveredWindows = [...windows];
    } else {
        const uncoveredMessages: HistoryMessageRow[] = [];
        for (const w of windows) {
            for (const msg of w.messages) {
                if (!coveredIds.has(msg.messageId)) {
                    uncoveredMessages.push(msg);
                }
            }
        }
        if (uncoveredMessages.length === 0) return [];
        uncoveredWindows = buildHistoryWindows(uncoveredMessages, config);
    }

    if (mode === "full" || uncoveredWindows.length <= 6) {
        return uncoveredWindows;
    }

    const endMs = (w: HistoryWindow): number => w.messages[w.messages.length - 1]?.timestampMs ?? Date.parse(w.endedAt);
    const startMs = (w: HistoryWindow): number => w.messages[0]?.timestampMs ?? Date.parse(w.startedAt);

    const byRecency = [...uncoveredWindows]
        .sort((a, b) => (endMs(b) - endMs(a)) || b.unitKey.localeCompare(a.unitKey))
        .slice(0, 6);

    const byCount = [...uncoveredWindows]
        .sort((a, b) =>
            (b.messages.length - a.messages.length)
            || (endMs(b) - endMs(a))
            || b.unitKey.localeCompare(a.unitKey),
        )
        .slice(0, 6);

    const deduped = new Map<string, HistoryWindow>();
    for (const w of [...byRecency, ...byCount]) {
        deduped.set(w.unitKey, w);
    }

    return [...deduped.values()].sort((a, b) =>
        (startMs(a) - startMs(b))
        || (endMs(a) - endMs(b))
        || a.unitKey.localeCompare(b.unitKey),
    );
}

/**
 * Strip nested forwarded message body text (both `[转发聊天记录...` and upstream `[转发消息...`,
 * across multiple lines to end of string) so forwarded bodies and any multi-line continuation
 * lines are never treated as direct evidence.
 */
export function stripForwardedBodyText(text: string): string {
    if (!text) return "";
    return text.replace(/\[转发(?:聊天记录|消息)[\s\S]*/g, "[转发聊天记录]");
}

/**
 * Resolve clean LLM prompt evidence text for a historical message row.
 * When QCE normalization produced `qceMeta.evidenceText` for a forwarded message,
 * return it directly (strictly built from non-forward top-level elements + pure
 * `[转发聊天记录]` placeholders); otherwise fall back to `stripForwardedBodyText`.
 */
export function getHistoryMessageEvidenceText(row: Pick<HistoryMessageRow, "text" | "qceMeta">): string {
    const meta = parseQceMetaFlags(row.qceMeta);
    if (meta.hasForward && typeof meta.evidenceText === "string") {
        return meta.evidenceText;
    }
    return stripForwardedBodyText(row.text || "");
}

export function getUtcIsoWeekKey(isoTimestamp: string): string {
    const parsed = new Date(isoTimestamp);
    const ms = parsed.getTime();
    if (!Number.isFinite(ms)) return "1970-W01";
    const date = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function sampleTopicMessages(
    messages: readonly HistoryMessageRow[],
    maxCount: number = DEFAULT_MAX_SAMPLE_MESSAGES_PER_TOPIC,
): HistoryMessageRow[] {
    if (messages.length <= maxCount) return [...messages];
    if (maxCount <= 0) return [];
    if (maxCount === 1) return [messages[0]];

    const pickedIndices = new Set<number>();
    pickedIndices.add(0);
    pickedIndices.add(messages.length - 1);
    for (let i = 1; i < maxCount - 1; i++) {
        const idx = Math.round((i * (messages.length - 1)) / (maxCount - 1));
        pickedIndices.add(Math.min(messages.length - 1, Math.max(0, idx)));
    }
    const sortedIndices = [...pickedIndices].sort((a, b) => a - b);
    return sortedIndices.map(i => messages[i]);
}

function formatMentionsText(mentionsJson: string | null, chatId?: string): string {
    const mentions = readMessageMentions(mentionsJson);
    if (!mentions || mentions.length === 0) return "";
    const isOneBot = Boolean(chatId && chatId.startsWith("onebot:"));
    const parts = mentions
        .filter(m => {
            if (!m.userId || m.isAll || m.nameSource === "account_fallback" || !m.displayName?.trim()) {
                return false;
            }
            if (isOneBot && m.nameSource !== "chat" && m.nameSource !== "qce") {
                return false;
            }
            return true;
        })
        .map(m => `@${m.displayName!.trim()} [${m.userId}]`);
    return parts.join(", ");
}

export function buildSynthesisTopicBlock(
    topic: TopicNode,
    topicMessages: readonly HistoryMessageRow[],
    memory: Pick<MemoryStoreV2, "getChatDisplayNames">,
    chatId: string,
    maxSampleMessagesPerTopic: number = DEFAULT_MAX_SAMPLE_MESSAGES_PER_TOPIC,
): SynthesisTopicBlock {
    const sampledRawMessages = sampleTopicMessages(topicMessages, maxSampleMessagesPerTopic);
    const userIds = [...new Set(sampledRawMessages.map(m => m.userId).filter(Boolean))];
    const chatDisplayNames = memory.getChatDisplayNames(chatId, userIds);

    const sampledMessages: SampledSynthesisMessage[] = sampledRawMessages.map(m => {
        const localName = chatDisplayNames.get(m.userId)?.trim()
            || m.displayName?.trim()
            || getRawId(m.userId);
        return {
            messageId: m.messageId,
            userId: m.userId,
            displayName: localName,
            timestamp: m.timestamp,
            text: getHistoryMessageEvidenceText(m),
            replyToMessageId: m.replyToMessageId,
            mentionsText: formatMentionsText(m.mentions, chatId),
        };
    });

    const sanitizedTopic: TopicNode = {
        ...topic,
        summary: stripForwardedBodyText(topic.summary || ""),
    };

    return {
        topic: sanitizedTopic,
        allTopicMessages: [...topicMessages],
        sampledRawMessages,
        sampledMessages,
        eligibleMessageIds: new Set(sampledMessages.map(m => m.messageId)),
        eligibleParticipants: new Set(
            sampledMessages
                .map(m => m.userId)
                .filter(uid => uid && uid !== "system"),
        ),
        evidenceDigest: computeMessagesDigest(toDigestFields(sampledRawMessages)),
    };
}

export function buildSynthesisMacroBatches(
    topics: readonly TopicNode[],
    memory: MemoryStoreV2,
    options: {
        chatId: string;
        since?: string;
        until?: string;
        timezone?: string;
        maxTopicsPerBatch?: number;
        maxSampleMessagesPerTopic?: number;
    },
): BuildSynthesisMacroBatchesResult {
    const {
        chatId,
        since,
        until,
        timezone: rawTz,
        maxTopicsPerBatch = DEFAULT_MAX_TOPICS_PER_BATCH,
        maxSampleMessagesPerTopic = DEFAULT_MAX_SAMPLE_MESSAGES_PER_TOPIC,
    } = options;

    const timezone = resolveCanonicalWindowTimezone(rawTz);
    const sinceMs = parseOptionalBoundaryMs(since, timezone, "since");
    const untilMs = parseOptionalBoundaryMs(until, timezone, "until");
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs >= untilMs) {
        throw new HistoryUsageError(`Invalid date range: since (${since}) must be earlier than until (${until})`);
    }

    const skippedPartialTopics: SkippedPartialTopic[] = [];
    const scopedTopicEntries: Array<{ topic: TopicNode; messages: HistoryMessageRow[] }> = [];

    const sortedTopics = [...topics].sort((a, b) =>
        a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
    );

    for (const topic of sortedTopics) {
        const msgIds = topic.messageRange?.messageIds ?? [];
        if (msgIds.length === 0) {
            skippedPartialTopics.push({
                topicId: topic.id,
                label: topic.label,
                reason: "empty_message_range",
            });
            continue;
        }

        // Fetch ONLY this topic's message IDs in bounded chunks (never loading the entire chat)
        const fetched = memory.getEligibleHistoryMessagesByIds(chatId, msgIds);
        const fetchedById = new Map<string, HistoryMessageRow>(
            fetched.map(row => [row.messageId, row]),
        );

        const resolvedMessages: HistoryMessageRow[] = [];
        let outOfScopeOrIneligible = false;
        let inRangeCount = 0;
        for (const mid of msgIds) {
            const msg = fetchedById.get(mid);
            if (!msg || !isEligibleHistoryMessageRow(msg)) {
                outOfScopeOrIneligible = true;
                break;
            }
            const inSince = sinceMs === undefined || msg.timestampMs >= sinceMs;
            const inUntil = untilMs === undefined || msg.timestampMs < untilMs;
            if (!inSince || !inUntil) {
                outOfScopeOrIneligible = true;
            } else {
                inRangeCount++;
            }
            resolvedMessages.push(msg);
        }

        if (outOfScopeOrIneligible) {
            skippedPartialTopics.push({
                topicId: topic.id,
                label: topic.label,
                reason: inRangeCount > 0 ? "partial_date_range_intersection" : "out_of_scope_or_ineligible_messages",
            });
            continue;
        }

        resolvedMessages.sort((a, b) =>
            (a.timestampMs - b.timestampMs)
            || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0),
        );
        scopedTopicEntries.push({ topic, messages: resolvedMessages });
    }

    // Group chronologically by UTC ISO week
    const weekGroups: Array<{ isoWeek: string; entries: Array<{ topic: TopicNode; messages: HistoryMessageRow[] }> }> = [];
    for (const entry of scopedTopicEntries) {
        const isoWeek = getUtcIsoWeekKey(entry.topic.startedAt);
        const lastGroup = weekGroups[weekGroups.length - 1];
        if (lastGroup && lastGroup.isoWeek === isoWeek) {
            lastGroup.entries.push(entry);
        } else {
            weekGroups.push({ isoWeek, entries: [entry] });
        }
    }

    const boundedMaxTopics = Math.max(1, Math.floor(maxTopicsPerBatch));
    const batches: SynthesisMacroBatch[] = [];

    for (const group of weekGroups) {
        for (let offset = 0, subIdx = 0; offset < group.entries.length; offset += boundedMaxTopics, subIdx++) {
            const chunk = group.entries.slice(offset, offset + boundedMaxTopics);
            const topicBlocks = chunk.map(item =>
                buildSynthesisTopicBlock(item.topic, item.messages, memory, chatId, maxSampleMessagesPerTopic),
            );
            const batchTopics = chunk.map(item => item.topic);
            const orderedKeys = batchTopics.map(t => t.historyKey ?? t.id);
            const sampledDigestPayload = topicBlocks.map(b => `${b.topic.historyKey ?? b.topic.id}:${b.evidenceDigest}`);
            const unitDigest = createHash("sha256")
                .update(JSON.stringify({
                    chatId,
                    promptRev: SYNTHESIS_PROMPT_REVISION,
                    keys: orderedKeys,
                    evidence: sampledDigestPayload,
                }))
                .digest("hex")
                .slice(0, 24);
            const unitKey = `synth:${group.isoWeek}:${unitDigest}`;
            const lastEnded = batchTopics[batchTopics.length - 1]?.endedAt
                ?? batchTopics[batchTopics.length - 1]?.startedAt
                ?? "";
            const rankKey = `${group.isoWeek}#${String(subIdx).padStart(4, "0")}:${lastEnded}`;
            const inputJson = JSON.stringify({
                isoWeek: group.isoWeek,
                promptRevision: SYNTHESIS_PROMPT_REVISION,
                topicIds: batchTopics.map(t => t.id),
                historyKeys: orderedKeys,
                maxSampleMessagesPerTopic,
            });
            batches.push({
                unitKey,
                isoWeek: group.isoWeek,
                rankKey,
                topics: batchTopics,
                topicBlocks,
                inputJson,
            });
        }
    }

    return {
        batches,
        skippedPartialTopics,
    };
}
