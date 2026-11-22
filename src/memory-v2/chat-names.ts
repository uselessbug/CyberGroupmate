import type Database from "better-sqlite3";
import type { MessageMention } from "../core/message-provenance.js";

export type ChatNameKind =
    | "sender_display"
    | "sender_card"
    | "sender_nickname"
    | "sender_name"
    | "mention_display"
    | "self_claim";

export interface ChatNameObservation {
    chatId: string;
    messageId: string;
    userId: string;
    kind: ChatNameKind;
    displayName: string;
    observedAt: string;
}

export interface ChatNameHit {
    chatId: string;
    userId: string;
    displayName: string;
    kind: ChatNameKind;
    observedAt: string;
    match: "exact" | "prefix" | "substring";
}

export interface LatestChatNameRecord {
    chatId: string;
    userId: string;
    displayName: string;
    kind: ChatNameKind;
    observedAt: string;
}

const KIND_RANK: Record<ChatNameKind, number> = {
    sender_card: 6,
    sender_display: 5,
    sender_nickname: 4,
    sender_name: 3,
    self_claim: 2,
    mention_display: 1,
};

const MATCH_RANK: Record<ChatNameHit["match"], number> = {
    exact: 3,
    prefix: 2,
    substring: 1,
};

export function chatNameKindRank(kind: ChatNameKind): number {
    return KIND_RANK[kind] ?? 0;
}

export function cleanDisplayName(name: string | undefined | null): string | undefined {
    if (typeof name !== "string") return undefined;
    const cleaned = name.trim().replace(/\s+/g, " ");
    return cleaned.length > 0 ? cleaned : undefined;
}

export function normalizeChatNameKey(name: string): string {
    return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function isUsableUserId(userId: string | undefined | null): userId is string {
    if (typeof userId !== "string") return false;
    const trimmed = userId.trim();
    return trimmed.length > 0 && trimmed !== "system" && trimmed !== "onebot:all";
}

export function collectChatNamesFromMessage(entry: {
    chatId: string;
    messageId: string;
    userId: string;
    displayName?: string;
    displayNameSource?: "chat" | "account_fallback" | "qce";
    timestamp: string;
    mentions?: MessageMention[];
    accessControlBlocked?: boolean;
    qceMeta?: Record<string, unknown>;
}): ChatNameObservation[] {
    if (entry.accessControlBlocked === true) return [];
    const chatId = typeof entry.chatId === "string" ? entry.chatId.trim() : "";
    const messageId = typeof entry.messageId === "string" ? entry.messageId.trim() : "";
    const observedAt = typeof entry.timestamp === "string" ? entry.timestamp.trim() : "";
    if (!chatId || !messageId || !observedAt) return [];

    const observations: ChatNameObservation[] = [];
    const seen = new Set<string>();

    const add = (userId: string | undefined | null, kind: ChatNameKind, rawName: unknown) => {
        if (!isUsableUserId(userId)) return;
        const displayName = cleanDisplayName(typeof rawName === "string" ? rawName : undefined);
        if (!displayName) return;
        const nameKey = normalizeChatNameKey(displayName);
        if (!nameKey) return;
        const uid = userId.trim();
        const dedupeKey = `${uid}\0${kind}\0${nameKey}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        observations.push({
            chatId,
            messageId,
            userId: uid,
            kind,
            displayName,
            observedAt,
        });
    };

    if (entry.qceMeta && typeof entry.qceMeta === "object") {
        add(entry.userId, "sender_card", entry.qceMeta.card ?? entry.qceMeta.senderCard);
        add(entry.userId, "sender_nickname", entry.qceMeta.nickname ?? entry.qceMeta.senderNickname);
        add(entry.userId, "sender_name", entry.qceMeta.name ?? entry.qceMeta.senderName);
    }

    if (entry.displayNameSource !== "account_fallback") {
        add(entry.userId, "sender_display", entry.displayName);
    }

    if (Array.isArray(entry.mentions)) {
        const isOneBot = chatId.startsWith("onebot:");
        for (const mention of entry.mentions) {
            if (!mention || mention.isAll === true || mention.nameSource === "account_fallback") {
                continue;
            }
            if (isOneBot && mention.nameSource !== "chat" && mention.nameSource !== "qce") {
                continue;
            }
            add(mention.userId, "mention_display", mention.displayName);
        }
    }

    return observations;
}

export function insertChatNameObservations(
    db: Database.Database,
    observations: ChatNameObservation[],
): number {
    if (observations.length === 0) return 0;

    const stmt = db.prepare(`
        INSERT OR IGNORE INTO person_chat_names
            (chat_id, message_id, user_id, kind, name_key, display_name, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const apply = db.transaction((items: ChatNameObservation[]) => {
        let inserted = 0;
        for (const item of items) {
            const chatId = item.chatId?.trim();
            const messageId = item.messageId?.trim();
            const userId = item.userId?.trim();
            const observedAt = item.observedAt?.trim();
            const displayName = cleanDisplayName(item.displayName);
            if (!chatId || !messageId || !isUsableUserId(userId) || !observedAt || !displayName) {
                continue;
            }
            const nameKey = normalizeChatNameKey(displayName);
            if (!nameKey) continue;
            const res = stmt.run(chatId, messageId, userId, item.kind, nameKey, displayName, observedAt);
            inserted += res.changes;
        }
        return inserted;
    });

    return apply(observations);
}

export function deleteSenderChatNamesForMessage(
    db: Database.Database,
    chatId: string,
    messageId: string,
): number {
    if (!chatId || !messageId) return 0;
    const res = db.prepare(`
        DELETE FROM person_chat_names
        WHERE chat_id = ?
          AND message_id = ?
          AND kind IN ('sender_display', 'sender_card', 'sender_nickname', 'sender_name')
    `).run(chatId, messageId);
    return res.changes;
}

export function deleteSelfClaimChatNamesForMessage(
    db: Database.Database,
    chatId: string,
    messageId: string,
): number {
    if (!chatId || !messageId) return 0;
    const res = db.prepare(`
        DELETE FROM person_chat_names
        WHERE chat_id = ?
          AND message_id = ?
          AND kind = 'self_claim'
    `).run(chatId, messageId);
    return res.changes;
}

function compareChatNameHits(left: ChatNameHit, right: ChatNameHit): number {
    return (
        MATCH_RANK[right.match] - MATCH_RANK[left.match]
        || KIND_RANK[right.kind] - KIND_RANK[left.kind]
        || right.observedAt.localeCompare(left.observedAt)
        || left.userId.localeCompare(right.userId)
    );
}

export function searchChatNames(
    db: Database.Database,
    chatId: string,
    query: string,
    limit: number = 20,
): ChatNameHit[] {
    if (!chatId || typeof chatId !== "string" || !query || typeof query !== "string") {
        return [];
    }
    const stripped = query.trim().replace(/^[@＠]/, "");
    const key = normalizeChatNameKey(stripped);
    if (!key) return [];

    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const rows = db.prepare(`
        SELECT
            n.chat_id,
            n.user_id,
            n.kind,
            n.name_key,
            n.display_name,
            n.observed_at
        FROM person_chat_names n
        INNER JOIN message_log m
            ON m.chat_id = n.chat_id AND m.message_id = n.message_id
        WHERE n.chat_id = ?
          AND m.access_control_blocked = 0
          AND (n.name_key = ? OR instr(n.name_key, ?) > 0)
    `).all(chatId, key, key) as Array<{
        chat_id: string;
        user_id: string;
        kind: ChatNameKind;
        name_key: string;
        display_name: string;
        observed_at: string;
    }>;

    const bestByUser = new Map<string, ChatNameHit>();
    for (const row of rows) {
        let match: ChatNameHit["match"];
        if (row.name_key === key) {
            match = "exact";
        } else if (row.name_key.startsWith(key)) {
            match = "prefix";
        } else {
            match = "substring";
        }

        const candidate: ChatNameHit = {
            chatId: row.chat_id,
            userId: row.user_id,
            displayName: row.display_name,
            kind: row.kind,
            observedAt: row.observed_at,
            match,
        };

        const existing = bestByUser.get(candidate.userId);
        if (!existing || compareChatNameHits(candidate, existing) < 0) {
            bestByUser.set(candidate.userId, candidate);
        }
    }

    return [...bestByUser.values()]
        .sort(compareChatNameHits)
        .slice(0, boundedLimit);
}

function latestNameKindPriority(kind: ChatNameKind): number {
    switch (kind) {
        case "sender_card": return 6;
        case "sender_display": return 5;
        case "sender_nickname": return 4;
        case "sender_name": return 3;
        case "self_claim": return 2;
        default: return 1;
    }
}

interface RawLatestChatNameRow {
    chat_id: string;
    user_id: string;
    display_name: string;
    kind: ChatNameKind;
    observed_at: string;
}

function createLatestChatNameResolvers(db: Database.Database) {
    // Uses idx_chat_names_user(chat_id, user_id, observed_at DESC) without full-table sorts.
    const stmtLatestPrimary = db.prepare(`
        SELECT n.chat_id, n.user_id, n.display_name, n.kind, n.observed_at
        FROM person_chat_names n
        INNER JOIN message_log m
            ON m.chat_id = n.chat_id AND m.message_id = n.message_id
        WHERE n.chat_id = ?
          AND n.user_id = ?
          AND n.kind != 'mention_display'
          AND n.display_name != ''
          AND m.access_control_blocked = 0
        ORDER BY n.observed_at DESC
        LIMIT 1
    `);
    const stmtPrimaryAtTimestamp = db.prepare(`
        SELECT n.chat_id, n.user_id, n.display_name, n.kind, n.observed_at
        FROM person_chat_names n
        INNER JOIN message_log m
            ON m.chat_id = n.chat_id AND m.message_id = n.message_id
        WHERE n.chat_id = ?
          AND n.user_id = ?
          AND n.observed_at = ?
          AND n.kind != 'mention_display'
          AND n.display_name != ''
          AND m.access_control_blocked = 0
    `);
    const stmtLatestMention = db.prepare(`
        SELECT n.chat_id, n.user_id, n.display_name, n.kind, n.observed_at
        FROM person_chat_names n
        INNER JOIN message_log m
            ON m.chat_id = n.chat_id AND m.message_id = n.message_id
        WHERE n.chat_id = ?
          AND n.user_id = ?
          AND n.kind = 'mention_display'
          AND n.display_name != ''
          AND m.access_control_blocked = 0
        ORDER BY n.observed_at DESC
        LIMIT 1
    `);

    const resolveOne = (chatId: string, userId: string): RawLatestChatNameRow | undefined => {
        const primary = stmtLatestPrimary.get(chatId, userId) as RawLatestChatNameRow | undefined;
        if (primary) {
            const tied = stmtPrimaryAtTimestamp.all(chatId, userId, primary.observed_at) as RawLatestChatNameRow[];
            let best = primary;
            let bestPrio = latestNameKindPriority(primary.kind);
            for (const row of tied) {
                const prio = latestNameKindPriority(row.kind);
                if (prio > bestPrio) {
                    best = row;
                    bestPrio = prio;
                }
            }
            return best;
        }
        return stmtLatestMention.get(chatId, userId) as RawLatestChatNameRow | undefined;
    };

    return { resolveOne };
}

export function resolveLatestChatDisplayNames(
    db: Database.Database,
    chatId: string,
    userIds?: string[],
): Map<string, string> {
    const result = new Map<string, string>();
    if (!chatId || typeof chatId !== "string") return result;

    if (userIds && userIds.length === 0) return result;

    const uniqueUserIds = userIds
        ? [...new Set(userIds.filter(Boolean))]
        : (db.prepare(`
            SELECT DISTINCT user_id
            FROM person_chat_names
            WHERE chat_id = ?
        `).all(chatId) as Array<{ user_id: string }>).map(r => r.user_id).filter(Boolean);

    if (uniqueUserIds.length === 0) return result;

    const { resolveOne } = createLatestChatNameResolvers(db);
    for (const uid of uniqueUserIds) {
        const row = resolveOne(chatId, uid);
        if (row && row.display_name) {
            result.set(uid, row.display_name);
        }
    }

    return result;
}

export function resolveLatestUserChatDisplayNames(
    db: Database.Database,
    userId: string,
): Map<string, string> {
    const result = new Map<string, string>();
    if (!userId || typeof userId !== "string") return result;

    const rows = db.prepare(`
        SELECT n.chat_id, n.display_name
        FROM person_chat_names n
        INNER JOIN message_log m
            ON m.chat_id = n.chat_id AND m.message_id = n.message_id
        WHERE n.user_id = ?
          AND m.access_control_blocked = 0
        ORDER BY
            CASE WHEN n.kind = 'mention_display' THEN 1 ELSE 0 END ASC,
            n.observed_at DESC,
            CASE n.kind
                WHEN 'sender_card' THEN 6
                WHEN 'sender_display' THEN 5
                WHEN 'sender_nickname' THEN 4
                WHEN 'sender_name' THEN 3
                WHEN 'self_claim' THEN 2
                ELSE 1
            END DESC
    `).all(userId) as Array<{ chat_id: string; display_name: string }>;

    for (const row of rows) {
        if (!result.has(row.chat_id) && row.display_name) {
            result.set(row.chat_id, row.display_name);
        }
    }
    return result;
}

export function resolveLatestChatNameRecord(
    db: Database.Database,
    chatId: string,
    userId: string,
): LatestChatNameRecord | null {
    if (!chatId || typeof chatId !== "string" || !userId || typeof userId !== "string") {
        return null;
    }
    const { resolveOne } = createLatestChatNameResolvers(db);
    const row = resolveOne(chatId, userId);
    if (!row || !row.display_name) return null;
    return {
        chatId: row.chat_id,
        userId: row.user_id,
        displayName: row.display_name,
        kind: row.kind,
        observedAt: row.observed_at,
    };
}
