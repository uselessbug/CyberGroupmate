import {
    chatNameKindRank,
    type ChatNameKind,
    type CoreFact,
    type FactCategory,
    type FactSearchResult,
    type GroupModel,
    type InteractionSearchResult,
    type MessageSearchResult,
    type PersonGroupProfile,
    type PersonIdentity,
    type SessionDigestEntry,
    type SessionDigestSearchOptions,
    type TimelineEntry,
    type TimelineOptions,
    type TopicSearchResult,
    type UserProfileSearchResult,
    type MemoryStoreV2,
} from "../../memory-v2/index.js";
import { timestampInputToIso } from "../../core/timezone.js";
import { isPrivateChat, scrubAssociatedMemoriesByVisibility, scrubFactsByVisibility, scrubRowsByVisibility, type PolicyContext } from "../../core/visibility-policy.js";

export interface MemorySearchEntitiesOptions {
    chatId?: string;
    after?: string | number | Date;
    before?: string | number | Date;
    categories?: FactCategory[];
    limit?: number;
}

export type MemoryIdentityMatchType =
    | "exact_user_id"
    | "exact_display_name"
    | "exact_alias"
    | "exact_username"
    | "partial_display_name"
    | "partial_alias"
    | "partial_username"
    | "fact_subject"
    | "topic_participant";

export interface MemoryIdentityMatch {
    identity: PersonIdentity;
    profile: UserProfileSearchResult;
    matchType: MemoryIdentityMatchType;
    score: number;
    reasons: string[];
    chatName?: {
        chatId: string;
        displayName: string;
        kind: ChatNameKind;
    };
}

export interface MemorySearchEntitiesResult {
    identities: MemoryIdentityMatch[];
    recentSessions: TopicSearchResult[];
    sessionDigests: SessionDigestEntry[];
    coreFacts: FactSearchResult[];
    topicKeywords: string[];
}

export interface MemoryResolvePersonOptions {
    chatId?: string;
    limit?: number;
}

export interface MemoryResolvePersonResult {
    matches: MemoryIdentityMatch[];
}

export interface MemoryGetPersonDossierOptions {
    chatId?: string;
    limit?: number;
    factsLimit?: number;
    interactionsLimit?: number;
    topicsLimit?: number;
    messagesLimit?: number;
    groupProfilesLimit?: number;
}

export interface MemoryDossierGroupProfile extends PersonGroupProfile {
    chatTitle?: string;
    isDirectMessage?: boolean;
}

export interface MemoryPersonDossier {
    match: MemoryIdentityMatch;
    groupProfiles: MemoryDossierGroupProfile[];
    facts: CoreFact[];
    recentInteractions: InteractionSearchResult[];
    recentTopics: TopicSearchResult[];
    recentMessages: MessageSearchResult[];
}

export interface MemoryGetPersonDossierResult {
    dossiers: MemoryPersonDossier[];
}

type MemoryEntityReader = Pick<MemoryStoreV2,
    "searchByAlias" |
    "searchFacts" |
    "searchTopics" |
    "getPersonIdentity" |
    "getUserProfile" |
    "getProfilesForChat" |
    "listGroupModels" |
    "listCoreFacts" |
    "getRecentInteractions" |
    "getRecentTopics" |
    "queryMessages"
    | "listSessionDigests"
    | "searchAgentMemory"
    | "getTimeline"
> & Partial<Pick<MemoryStoreV2, "searchChatNames" | "getChatDisplayName" | "getLatestChatNameForUser" | "getGroupModel" | "sanitizeGroupProfileHistoryAccess">>;


const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_DOSSIER_LIMIT = 3;
const MAX_DOSSIER_LIMIT = 10;

/**
 * R1（聚合）— 就地擦除一个 identity match 的 profile.recentFacts 里来自私密会话的 fact。
 * identity 的 profile 由 getUserProfile 跨会话构建、不带 visibility 过滤，是私密 fact 的旁路泄露点。
 */
export function scrubMatchProfile(match: MemoryIdentityMatch | undefined, ctx: PolicyContext): void {
    const profile = match?.profile as {
        recentFacts?: FactSearchResult[];
        groupProfile?: { chatId?: string } | null;
    } | undefined;
    if (!profile) return;
    if (Array.isArray(profile.recentFacts)) {
        profile.recentFacts = scrubFactsByVisibility(profile.recentFacts, ctx, "memory.identityProfile").kept;
    }
    // groupProfile 是按 chatId 取的本群画像；若来自私密会话且 ≠ 当前会话，整块丢弃（含 recentEpisodes 摘要）。
    const gpChatId = profile.groupProfile?.chatId;
    if (gpChatId && gpChatId !== ctx.boundChatId && isPrivateChat(gpChatId, ctx.deps)) {
        profile.groupProfile = null;
    }
}

/** 批量擦除 identity match 列表（resolvePerson.matches / searchEntities.identities 共用）。 */
export function scrubIdentityMatches(matches: MemoryIdentityMatch[] | undefined, ctx: PolicyContext): void {
    for (const match of matches ?? []) scrubMatchProfile(match, ctx);
}

/**
 * R1（聚合）— 就地按 viewer 的 visibility 兜底擦除人物档案里来自私密会话的数据。
 * 两个 chokepoint（subagent host-call-handler / meta wrapper）共用，避免重复枚举 dossier 字段。
 */
export function scrubDossiers(dossiers: MemoryPersonDossier[] | undefined, ctx: PolicyContext): void {
    for (const d of dossiers ?? []) {
        scrubMatchProfile(d.match, ctx); // match.profile.recentFacts 也是泄露点
        d.facts = scrubFactsByVisibility(d.facts ?? [], ctx, "memory.getPersonDossier").kept;
        d.recentMessages = scrubRowsByVisibility(d.recentMessages ?? [], (r) => r.chatId, ctx).kept;
        d.recentTopics = scrubRowsByVisibility(d.recentTopics ?? [], (r) => r.chatId, ctx).kept;
        d.recentTopics = scrubAssociatedMemoriesByVisibility(d.recentTopics, ctx, "memory.getPersonDossier.recentTopics").kept;
        d.recentInteractions = scrubRowsByVisibility(d.recentInteractions ?? [], (r) => r.chatId, ctx).kept;
        d.groupProfiles = scrubRowsByVisibility(d.groupProfiles ?? [], (r) => r.chatId, ctx).kept;
    }
}

export function createMemoryApi(
    memory: MemoryEntityReader,
    viewer?: { boundChatId?: string },
) {
    const resolveEffectiveChatId = (requestedChatId?: string): string | undefined =>
        viewer?.boundChatId ?? requestedChatId;

    return {
        resolvePerson: async (
            query: string,
            options: MemoryResolvePersonOptions = {},
        ): Promise<MemoryResolvePersonResult> => {
            const normalizedQuery = query.trim();
            const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
            if (!normalizedQuery) {
                return { matches: [] };
            }

            const effectiveChatId = resolveEffectiveChatId(options.chatId);
            return {
                matches: resolvePersonMatches(memory, normalizedQuery, effectiveChatId, limit),
            };
        },

        getPersonDossier: async (
            queryOrUserId: string,
            options: MemoryGetPersonDossierOptions = {},
        ): Promise<MemoryGetPersonDossierResult> => {
            const normalizedQuery = queryOrUserId.trim();
            const identityLimit = clampLimit(options.limit, DEFAULT_DOSSIER_LIMIT, MAX_DOSSIER_LIMIT);
            if (!normalizedQuery) {
                return { dossiers: [] };
            }

            const effectiveChatId = resolveEffectiveChatId(options.chatId);
            const matches = resolvePersonMatches(memory, normalizedQuery, effectiveChatId, identityLimit);
            const factsLimit = clampLimit(options.factsLimit, 12, MAX_SEARCH_LIMIT);
            const interactionsLimit = clampLimit(options.interactionsLimit, 8, MAX_SEARCH_LIMIT);
            const topicsLimit = clampLimit(options.topicsLimit, 8, MAX_SEARCH_LIMIT);
            const messagesLimit = clampLimit(options.messagesLimit, 8, MAX_SEARCH_LIMIT);
            const groupProfilesLimit = clampLimit(options.groupProfilesLimit, 8, MAX_SEARCH_LIMIT);

            return {
                dossiers: matches.map((match) => buildPersonDossier(memory, match, {
                    chatId: effectiveChatId,
                    factsLimit,
                    interactionsLimit,
                    topicsLimit,
                    messagesLimit,
                    groupProfilesLimit,
                })),
            };
        },

        searchEntities: async (
            query: string,
            options: MemorySearchEntitiesOptions = {},
        ): Promise<MemorySearchEntitiesResult> => {
            const normalizedQuery = query.trim();
            const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
            const after = timestampInputToIso(options.after) ?? undefined;
            const before = timestampInputToIso(options.before) ?? undefined;
            const effectiveChatId = resolveEffectiveChatId(options.chatId);

            if (!normalizedQuery) {
                return {
                    identities: [],
                    recentSessions: [],
                    sessionDigests: [],
                    coreFacts: [],
                    topicKeywords: [],
                };
            }

            const directMatches = resolvePersonMatches(memory, normalizedQuery, effectiveChatId, limit);
            const scoredIdentities = new Map<string, ScoredIdentity>();
            for (const match of directMatches) {
                scoredIdentities.set(match.identity.userId, {
                    identity: match.identity,
                    score: match.score,
                    matchTier: match.matchType === "exact_user_id" ? 6 : match.chatName ? 5 : 4,
                    kindRank: match.chatName ? chatNameKindRank(match.chatName.kind) : 0,
                    observedAt: match.identity.lastSeenAt,
                    matchType: match.matchType,
                    reasons: match.reasons,
                    chatName: match.chatName,
                });
            }

            const recentSessions = memory.searchTopics(normalizedQuery, {
                chatId: effectiveChatId,
                authorizedChatId: effectiveChatId,
                includeAllHistory: false,
                after,
                before,
                limit,
            });
            const directFactMatches = memory.searchFacts(normalizedQuery, {
                categories: options.categories,
                limit,
                authorizedChatId: effectiveChatId,
                includeAllHistory: false,
            });

            const directIdentityIds = new Set<string>();
            for (const match of directMatches) {
                directIdentityIds.add(match.identity.userId);
            }
            for (const fact of directFactMatches) {
                const identity = memory.getPersonIdentity(fact.subject);
                if (identity) {
                    directIdentityIds.add(identity.userId);
                    addScoredIdentity(scoredIdentities, {
                        identity,
                        score: 60,
                        matchTier: 0,
                        kindRank: 0,
                        observedAt: identity.lastSeenAt,
                        matchType: "fact_subject",
                        reason: `core fact subject matched "${normalizedQuery}"`,
                    });
                }
            }
            for (const session of recentSessions) {
                for (const participantId of session.participants) {
                    const identity = memory.getPersonIdentity(participantId);
                    if (identity) {
                        addScoredIdentity(scoredIdentities, {
                            identity,
                            score: 20,
                            matchTier: 0,
                            kindRank: 0,
                            observedAt: identity.lastSeenAt,
                            matchType: "topic_participant",
                            reason: `participant in topic "${session.label}"`,
                        });
                    }
                }
            }

            const identities = sortScoredIdentities(scoredIdentities)
                .slice(0, limit)
                .map((entry) => scoredIdentityToMatch(memory, entry, effectiveChatId));

            const relatedFacts = identities
                .filter((entry) => directIdentityIds.has(entry.identity.userId))
                .flatMap((entry) => entry.profile.recentFacts);
            const coreFacts = dedupeFacts([...directFactMatches, ...relatedFacts])
                .sort((left, right) => compareFacts(left, right, directIdentityIds))
                .slice(0, limit);
            const directTopicParticipantIds = new Set(directIdentityIds);
            const sortedRecentSessions = [...recentSessions]
                .sort((left, right) => compareTopics(left, right, directTopicParticipantIds))
                .slice(0, limit);
            const topicKeywords = [...new Set(recentSessions.flatMap((session) => session.keywords))]
                .slice(0, limit * 5);
            const sessionDigests = memory.searchAgentMemory(normalizedQuery, { chatId: effectiveChatId, after, before, limit });

            return {
                identities,
                recentSessions: sortedRecentSessions,
                sessionDigests,
                coreFacts,
                topicKeywords,
            };
        },

        searchAgentMemory: async (
            query: string,
            options: SessionDigestSearchOptions = {},
        ): Promise<{ sessionDigests: SessionDigestEntry[] }> => {
            const normalizedQuery = query.trim();
            if (!normalizedQuery) return { sessionDigests: [] };
            const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
            return {
                sessionDigests: memory.searchAgentMemory(normalizedQuery, {
                    ...options,
                    limit,
                    after: timestampInputToIso(options.after) ?? undefined,
                    before: timestampInputToIso(options.before) ?? undefined,
                }),
            };
        },

        getTimeline: async (
            options: TimelineOptions = {},
        ): Promise<{ entries: TimelineEntry[] }> => {
            const limit = clampLimit(options.limit, 30, 100);
            const effectiveChatId = resolveEffectiveChatId(options.chatId);
            const authorizedChatId = viewer?.boundChatId ?? options.chatId;
            return {
                entries: memory.getTimeline({
                    chatId: effectiveChatId,
                    after: timestampInputToIso(options.after) ?? undefined,
                    before: timestampInputToIso(options.before) ?? undefined,
                    limit,
                    includeTopics: options.includeTopics,
                    includeDigests: options.includeDigests,
                    authorizedChatId,
                    includeAllHistory: false,
                }),
            };
        },
    };
}

interface ScoredIdentity {
    identity: PersonIdentity;
    score: number;
    matchTier: number;
    kindRank: number;
    observedAt: string;
    matchType: MemoryIdentityMatchType;
    reasons: string[];
    chatName?: {
        chatId: string;
        displayName: string;
        kind: ChatNameKind;
    };
}

function resolvePersonMatches(
    memory: MemoryEntityReader,
    query: string,
    chatId: string | undefined,
    limit: number,
): MemoryIdentityMatch[] {
    const scored = new Map<string, ScoredIdentity>();

    const exactIdentity = memory.getPersonIdentity(query);
    if (exactIdentity) {
        const scopedChatName = chatId ? memory.getLatestChatNameForUser?.(chatId, exactIdentity.userId) : null;
        const localName = scopedChatName?.displayName
            ?? (chatId ? memory.getChatDisplayName?.(chatId, exactIdentity.userId) : null)
            ?? null;
        const resolvedIdentity = !exactIdentity.displayName && localName
            ? { ...exactIdentity, displayName: localName }
            : exactIdentity;
        const chatName = scopedChatName
            ? {
                chatId: scopedChatName.chatId,
                displayName: scopedChatName.displayName,
                kind: scopedChatName.kind,
            }
            : (chatId && localName
                ? {
                    chatId,
                    displayName: localName,
                    kind: "sender_display" as ChatNameKind,
                }
                : undefined);
        addScoredIdentity(scored, {
            identity: resolvedIdentity,
            score: 100,
            matchTier: 6,
            kindRank: chatName ? chatNameKindRank(chatName.kind) : 0,
            observedAt: exactIdentity.lastSeenAt ?? "",
            matchType: "exact_user_id",
            reason: "exact userId match",
            ...(chatName ? { chatName } : {}),
        });
    } else if (chatId) {
        const scopedChatName = memory.getLatestChatNameForUser?.(chatId, query);
        if (scopedChatName) {
            const syntheticIdentity: PersonIdentity = {
                userId: scopedChatName.userId,
                displayName: scopedChatName.displayName,
                aliases: [],
                totalMessageCount: 0,
                firstSeenAt: scopedChatName.observedAt,
                lastSeenAt: scopedChatName.observedAt,
                updatedAt: scopedChatName.observedAt,
            };
            addScoredIdentity(scored, {
                identity: syntheticIdentity,
                score: 100,
                matchTier: 6,
                kindRank: chatNameKindRank(scopedChatName.kind),
                observedAt: scopedChatName.observedAt,
                matchType: "exact_user_id",
                reason: `exact userId match via chat_name (${scopedChatName.kind}) in ${scopedChatName.chatId}`,
                chatName: {
                    chatId: scopedChatName.chatId,
                    displayName: scopedChatName.displayName,
                    kind: scopedChatName.kind,
                },
            });
        }
    }

    if (chatId && memory.searchChatNames) {
        const chatHits = memory.searchChatNames(chatId, query, Math.min(limit * 3, MAX_SEARCH_LIMIT));
        for (const hit of chatHits) {
            const existing = memory.getPersonIdentity(hit.userId);
            const identity: PersonIdentity = existing
                ? { ...existing, displayName: existing.displayName || hit.displayName }
                : {
                    userId: hit.userId,
                    displayName: hit.displayName,
                    aliases: [],
                    totalMessageCount: 0,
                    firstSeenAt: hit.observedAt,
                    lastSeenAt: hit.observedAt,
                    updatedAt: hit.observedAt,
                };
            const matchTier = hit.match === "exact" ? 5 : hit.match === "prefix" ? 3 : 1;
            const baseScore = hit.match === "exact" ? 98 : hit.match === "prefix" ? 85 : 75;
            const kindRank = chatNameKindRank(hit.kind);
            const matchType: MemoryIdentityMatchType = hit.match === "exact"
                ? "exact_display_name"
                : "partial_display_name";
            addScoredIdentity(scored, {
                identity,
                score: baseScore + kindRank * 0.05,
                matchTier,
                kindRank,
                observedAt: hit.observedAt,
                matchType,
                reason: `${hit.match} chat_name (${hit.kind}) match in ${hit.chatId}`,
                chatName: {
                    chatId: hit.chatId,
                    displayName: hit.displayName,
                    kind: hit.kind,
                },
            });
        }
    }

    for (const identity of memory.searchByAlias(query, Math.min(limit * 3, MAX_SEARCH_LIMIT))) {
        const { matchType, score, matchTier, reason } = scoreAliasMatch(identity, query);
        addScoredIdentity(scored, {
            identity,
            score,
            matchTier,
            kindRank: 0,
            observedAt: identity.lastSeenAt ?? "",
            matchType,
            reason,
        });
    }

    return sortScoredIdentities(scored)
        .slice(0, limit)
        .map((entry) => scoredIdentityToMatch(memory, entry, chatId));
}

function scoreAliasMatch(identity: PersonIdentity, query: string): {
    matchType: MemoryIdentityMatchType;
    score: number;
    matchTier: number;
    reason: string;
} {
    const normalizedQuery = normalizeForMatch(query);
    const candidates: Array<{ value: string | undefined; type: "display_name" | "alias" | "username" }> = [
        { value: identity.displayName, type: "display_name" },
        { value: identity.username, type: "username" },
        ...identity.aliases.map((alias) => ({ value: alias, type: "alias" as const })),
    ];

    for (const candidate of candidates) {
        if (normalizeForMatch(candidate.value) === normalizedQuery) {
            return {
                matchType: exactMatchType(candidate.type),
                score: 95,
                matchTier: 4,
                reason: `exact ${candidate.type} match`,
            };
        }
    }

    for (const candidate of candidates) {
        const value = normalizeForMatch(candidate.value);
        if (value && value.startsWith(normalizedQuery)) {
            return {
                matchType: partialMatchType(candidate.type),
                score: 82,
                matchTier: 2,
                reason: `prefix ${candidate.type} match`,
            };
        }
    }

    for (const candidate of candidates) {
        const value = normalizeForMatch(candidate.value);
        if (value && value.includes(normalizedQuery)) {
            return {
                matchType: partialMatchType(candidate.type),
                score: 72,
                matchTier: 0,
                reason: `partial ${candidate.type} match`,
            };
        }
    }

    return {
        matchType: "partial_alias",
        score: 65,
        matchTier: 0,
        reason: "alias search fallback match",
    };
}

function exactMatchType(type: "display_name" | "alias" | "username"): MemoryIdentityMatchType {
    if (type === "display_name") return "exact_display_name";
    if (type === "username") return "exact_username";
    return "exact_alias";
}

function partialMatchType(type: "display_name" | "alias" | "username"): MemoryIdentityMatchType {
    if (type === "display_name") return "partial_display_name";
    if (type === "username") return "partial_username";
    return "partial_alias";
}

function addScoredIdentity(
    scored: Map<string, ScoredIdentity>,
    candidate: {
        identity: PersonIdentity;
        score: number;
        matchTier: number;
        kindRank: number;
        observedAt: string;
        matchType: MemoryIdentityMatchType;
        reason: string;
        chatName?: {
            chatId: string;
            displayName: string;
            kind: ChatNameKind;
        };
    },
): void {
    const { identity } = candidate;
    const existing = scored.get(identity.userId);
    const recencyBonus = identity.lastSeenAt ? 1 : 0;
    const activityBonus = Math.min(Math.log10(Math.max(identity.totalMessageCount, 1)), 4);
    const finalScore = candidate.score + recencyBonus + activityBonus;

    if (!existing) {
        scored.set(identity.userId, {
            identity,
            score: finalScore,
            matchTier: candidate.matchTier,
            kindRank: candidate.kindRank,
            observedAt: candidate.observedAt,
            matchType: candidate.matchType,
            reasons: [candidate.reason],
            ...(candidate.chatName ? { chatName: candidate.chatName } : {}),
        });
        return;
    }

    existing.reasons.push(candidate.reason);
    if (candidate.chatName && !existing.chatName) {
        existing.chatName = candidate.chatName;
    }
    if (!existing.identity.displayName && identity.displayName) {
        existing.identity = { ...existing.identity, displayName: identity.displayName };
    }
    if (
        candidate.matchTier > existing.matchTier
        || (candidate.matchTier === existing.matchTier && finalScore > existing.score)
    ) {
        existing.score = finalScore;
        existing.matchTier = candidate.matchTier;
        existing.kindRank = candidate.kindRank;
        existing.observedAt = candidate.observedAt;
        existing.matchType = candidate.matchType;
        if (candidate.chatName) existing.chatName = candidate.chatName;
    }
}

function sortScoredIdentities(scored: Map<string, ScoredIdentity>): ScoredIdentity[] {
    return [...scored.values()].sort((left, right) =>
        right.matchTier - left.matchTier
        || right.kindRank - left.kindRank
        || right.observedAt.localeCompare(left.observedAt)
        || right.identity.totalMessageCount - left.identity.totalMessageCount
        || left.identity.userId.localeCompare(right.identity.userId)
    );
}

function scoredIdentityToMatch(
    memory: MemoryEntityReader,
    entry: ScoredIdentity,
    chatId?: string,
): MemoryIdentityMatch {
    let chatName = entry.chatName;
    if (!chatName && chatId) {
        const latest = memory.getLatestChatNameForUser?.(chatId, entry.identity.userId);
        if (latest) {
            chatName = {
                chatId: latest.chatId,
                displayName: latest.displayName,
                kind: latest.kind,
            };
        }
    }
    return {
        identity: entry.identity,
        profile: memory.getUserProfile(entry.identity.userId, chatId, {
            authorizedChatId: chatId,
            includeAllHistory: false,
        }),
        matchType: entry.matchType,
        score: Number(entry.score.toFixed(3)),
        reasons: [...new Set(entry.reasons)],
        ...(chatName ? { chatName } : {}),
    };
}

function buildPersonDossier(
    memory: MemoryEntityReader,
    match: MemoryIdentityMatch,
    limits: {
        chatId?: string;
        factsLimit: number;
        interactionsLimit: number;
        topicsLimit: number;
        messagesLimit: number;
        groupProfilesLimit: number;
    },
): MemoryPersonDossier {
    const scopedChatId = limits.chatId;
    const groupModels = new Map(memory.listGroupModels().map((model) => [model.chatId, model]));
    const groupProfiles = scopedChatId
        ? collectScopedGroupProfiles(memory, match.identity.userId, scopedChatId, groupModels)
        : collectGroupProfiles(memory, match.identity.userId, groupModels, limits.groupProfilesLimit);
    const facts = memory.listCoreFacts({
        subject: match.identity.userId,
        limit: limits.factsLimit,
        authorizedChatId: scopedChatId,
        includeAllHistory: false,
    }).items;
    const recentInteractions = memory.getRecentInteractions(
        scopedChatId ?? undefined,
        match.identity.userId,
        limits.interactionsLimit,
    );
    const recentTopics = collectRecentTopics(
        memory,
        match.identity.userId,
        groupProfiles,
        limits.topicsLimit,
        scopedChatId,
    );
    const recentMessages = memory.queryMessages({
        ...(scopedChatId ? { chatIds: [scopedChatId] } : {}),
        userIds: [match.identity.userId],
        limit: limits.messagesLimit,
    });

    return {
        match,
        groupProfiles,
        facts,
        recentInteractions,
        recentTopics,
        recentMessages,
    };
}

function collectScopedGroupProfiles(
    memory: MemoryEntityReader,
    userId: string,
    chatId: string,
    groupModels: Map<string, GroupModel>,
): MemoryDossierGroupProfile[] {
    const profile = memory.getProfilesForChat(chatId).find((entry) => entry.userId === userId);
    if (!profile) return [];
    const group = groupModels.get(chatId) ?? memory.getGroupModel?.(chatId);
    return [{
        ...profile,
        chatTitle: group?.chatTitle ?? profile.chatTitle,
        isDirectMessage: group?.isDirectMessage,
    }];
}

function collectGroupProfiles(
    memory: MemoryEntityReader,
    userId: string,
    groupModels: Map<string, GroupModel>,
    limit: number,
): MemoryDossierGroupProfile[] {
    const profiles: MemoryDossierGroupProfile[] = [];
    for (const group of groupModels.values()) {
        const rawProfile = memory.getProfilesForChat(group.chatId).find((entry) => entry.userId === userId);
        if (!rawProfile) continue;
        const profile = memory.sanitizeGroupProfileHistoryAccess
            ? memory.sanitizeGroupProfileHistoryAccess(rawProfile, { includeAllHistory: false })
            : {
                ...rawProfile,
                recentEpisodes: (rawProfile.recentEpisodes ?? []).filter(ep => ep.origin !== "offline_history"),
            };
        profiles.push({
            ...profile,
            chatTitle: group.chatTitle,
            isDirectMessage: group.isDirectMessage,
        });
    }

    return profiles
        .sort((left, right) =>
            right.messageCount - left.messageCount
            || right.affinityScore - left.affinityScore
            || right.lastSeenAt.localeCompare(left.lastSeenAt)
        )
        .slice(0, limit);
}

function collectRecentTopics(
    memory: MemoryEntityReader,
    userId: string,
    groupProfiles: MemoryDossierGroupProfile[],
    limit: number,
    scopedChatId?: string,
): TopicSearchResult[] {
    const chatIds = scopedChatId
        ? [scopedChatId]
        : groupProfiles.slice(0, Math.max(3, limit)).map((profile) => profile.chatId);
    const topics = new Map<string, TopicSearchResult>();
    for (const chatId of chatIds) {
        const rows = memory.getRecentTopics(chatId, limit * 2, scopedChatId ? undefined : { liveOnly: true })
            .filter((topic) => topic.participants.includes(userId))
            .map((topic) => ({
                topicId: topic.id,
                chatId: topic.chatId,
                label: topic.label,
                summary: topic.summary,
                keywords: topic.keywords,
                participants: topic.participants,
                startedAt: topic.startedAt,
                endedAt: topic.endedAt,
                sentiment: topic.sentiment,
                callbackPotential: topic.callbackPotential ?? 0,
                associatedMemories: topic.associatedMemories ?? [],
            }));
        for (const topic of rows) {
            topics.set(topic.topicId, topic);
        }
    }

    return [...topics.values()]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit);
}

function dedupeFacts(facts: FactSearchResult[]): FactSearchResult[] {
    const merged = new Map<string, FactSearchResult>();
    for (const fact of facts) {
        merged.set(fact.factId, fact);
    }
    return [...merged.values()];
}

function compareFacts(left: FactSearchResult, right: FactSearchResult, directIdentityIds: Set<string>): number {
    const leftDirect = directIdentityIds.has(left.subject) ? 1 : 0;
    const rightDirect = directIdentityIds.has(right.subject) ? 1 : 0;
    return rightDirect - leftDirect
        || right.updatedAt.localeCompare(left.updatedAt)
        || right.confidence - left.confidence;
}

function compareTopics(left: TopicSearchResult, right: TopicSearchResult, directIdentityIds: Set<string>): number {
    const leftDirect = left.participants.some((id) => directIdentityIds.has(id)) ? 1 : 0;
    const rightDirect = right.participants.some((id) => directIdentityIds.has(id)) ? 1 : 0;
    return rightDirect - leftDirect
        || right.startedAt.localeCompare(left.startedAt)
        || right.callbackPotential - left.callbackPotential;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
    return Math.min(Math.max(value ?? fallback, 1), max);
}

function normalizeForMatch(value: string | undefined): string {
    return (value ?? "").trim().toLocaleLowerCase();
}

