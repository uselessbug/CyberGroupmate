import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi } from "../src/meta-sandbox/meta-api/memory.js";
import { resolveQuoteRefs } from "../src/meta-sandbox/meta-api/quotes.js";
import { createTestMemory, cleanupTestMemory } from "./helpers/test-db.js";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";

describe("createMemoryApi", () => {
    let memory: MemoryStoreV2;

    before(() => {
        memory = createTestMemory("meta-api-memory");

        memory.upsertPersonIdentity("u1", {
            displayName: "alice",
            aliases: ["爱丽丝", "Alice"],
            firstSeenAt: "2026-01-01T00:00:00Z",
            lastSeenAt: "2026-01-03T00:00:00Z",
        });
        memory.upsertPersonIdentity("u2", {
            displayName: "bob",
            aliases: ["鲍勃", "Bob"],
            firstSeenAt: "2026-01-01T00:00:00Z",
            lastSeenAt: "2026-01-02T00:00:00Z",
        });
        memory.upsertPersonIdentity("u3", {
            displayName: "carol",
            aliases: ["Carol"],
            firstSeenAt: "2026-01-01T00:00:00Z",
            lastSeenAt: "2026-01-04T00:00:00Z",
        });

        memory.upsertPersonGroupProfile("u1", "g1", {
            lastSeenAt: "2026-01-03T00:00:00Z",
            firstSeenAt: "2026-01-01T00:00:00Z",
            relationToAgent: "经常追问旅行细节",
            messageCount: 12,
        });
        memory.upsertPersonGroupProfile("u1", "g2", {
            lastSeenAt: "2026-01-04T00:00:00Z",
            firstSeenAt: "2026-01-01T00:00:00Z",
            relationToAgent: "跨群技术协作者",
            messageCount: 5,
        });
        memory.upsertGroupModel("g1", {
            chatTitle: "旅行群",
            updatedAt: "2026-01-03T00:00:00Z",
        } as any);
        memory.upsertGroupModel("g2", {
            chatTitle: "技术群",
            updatedAt: "2026-01-04T00:00:00Z",
        } as any);

        memory.upsertTopic("topic_kyoto_meta", {
            chatId: "g1",
            label: "京都旅行",
            summary: "爱丽丝在问京都路线，Bob 补充交通建议",
            keywords: ["京都", "旅行", "交通"],
            participants: ["u1", "u2", "u3"],
            messageRange: { messageIds: ["m1", "m2"], count: 2 },
            startedAt: "2026-01-03T09:00:00Z",
        });
        memory.upsertTopic("topic_agent_meta", {
            chatId: "g2",
            label: "Agent 设计",
            summary: "alice 讨论跨群 agent 记忆检索",
            keywords: ["agent", "记忆"],
            participants: ["u1"],
            messageRange: { messageIds: ["m3"], count: 1 },
            startedAt: "2026-01-04T09:00:00Z",
        });
        memory.storeMessageBatch([
            {
                chatId: "g1",
                messageId: "m1",
                userId: "u1",
                displayName: "alice",
                text: "京都路线怎么安排",
                timestamp: "2026-01-03T09:00:00Z",
            },
            {
                chatId: "g2",
                messageId: "m3",
                userId: "u1",
                displayName: "alice",
                text: "agent 记忆检索要先解析人",
                timestamp: "2026-01-04T09:00:00Z",
            },
        ]);
        memory.storeInteraction({
            date: "2026-01-04T10:00:00Z",
            chatId: "g2",
            userId: "u1",
            topicId: "topic_agent_meta",
            type: "agent_mentioned",
            summary: "alice 要求优化人物检索",
            sentiment: "positive",
            significance: 0.8,
        });

        memory.storeFact("u1", "alice 是前端程序员", "biographical");
        memory.storeFact("u2", "bob 擅长 Rust 和 Python", "biographical");
        memory.appendSessionDigest({
            createdAt: "2026-01-05T00:00:00.000Z",
            content: "Meta 想跟进 Soha 的 Chiikawa Park 话题",
            kind: "meta_turn",
            actorType: "meta",
            actorId: "__meta__",
            sourceChatId: "__meta__",
            targetChatId: "g1",
            tags: ["followup"],
        });
    });

    after(() => {
        cleanupTestMemory(memory, "meta-api-memory");
    });

    it("searches entities through aliases and augments with recent sessions and core facts", async () => {
        const api = createMemoryApi(memory);
        const result = await api.searchEntities("爱丽丝", { chatId: "g1", limit: 10 });

        assert.equal(result.identities[0].identity.userId, "u1");
        assert.equal(result.identities[0].matchType, "exact_alias");
        assert.ok(result.recentSessions.some((row) => row.label === "京都旅行"));
        assert.ok(result.coreFacts.some((row) => row.content.includes("前端程序员")));
        assert.ok(result.topicKeywords.includes("京都"));
    });

    it("keeps direct alias matches above newer topic participants by default", async () => {
        const api = createMemoryApi(memory);
        const result = await api.searchEntities("爱丽丝");

        assert.ok(result.identities.length <= 10);
        assert.equal(result.identities[0].identity.userId, "u1");
        assert.equal(result.identities[0].matchType, "exact_alias");
        assert.ok(result.identities.some((entry) => entry.identity.userId === "u3"));
    });

    it("resolves people and builds an entity-centric dossier", async () => {
        const api = createMemoryApi(memory);
        const resolved = await api.resolvePerson("爱丽丝", { limit: 5 });
        assert.equal(resolved.matches[0].identity.userId, "u1");

        const dossier = await api.getPersonDossier("爱丽丝", {
            limit: 1,
            factsLimit: 5,
            interactionsLimit: 5,
            topicsLimit: 5,
            messagesLimit: 5,
            groupProfilesLimit: 5,
        });
        assert.equal(dossier.dossiers.length, 1);
        assert.equal(dossier.dossiers[0].match.identity.userId, "u1");
        assert.ok(dossier.dossiers[0].groupProfiles.some((profile) => profile.chatId === "g2"));
        assert.ok(dossier.dossiers[0].facts.some((fact) => fact.content.includes("前端程序员")));
        assert.ok(dossier.dossiers[0].recentInteractions.some((interaction) => interaction.summary.includes("人物检索")));
        assert.ok(dossier.dossiers[0].recentTopics.some((topic) => topic.label === "Agent 设计"));
        assert.ok(dossier.dossiers[0].recentMessages.some((message) => message.content.includes("先解析人")));
    });

    it("surfaces participant identities from topic keyword matches", async () => {
        const api = createMemoryApi(memory);
        const result = await api.searchEntities("京都", { chatId: "g1", limit: 10 });

        assert.ok(result.recentSessions.some((row) => row.label === "京都旅行"));
        assert.ok(result.topicKeywords.includes("交通"));
        assert.ok(result.identities.some((row) => row.identity.userId === "u1"));
        assert.ok(result.identities.some((row) => row.identity.userId === "u2"));
    });

    it("links core fact hits back to person identities", async () => {
        const api = createMemoryApi(memory);
        const result = await api.searchEntities("Rust", { limit: 10 });

        assert.ok(result.coreFacts.some((row) => row.content.includes("Rust")));
        assert.ok(result.identities.some((row) => row.identity.userId === "u2"));
    });

    it("searches session digests from global state", async () => {
        const api = createMemoryApi(memory);
        const result = await api.searchEntities("soha", { limit: 10 });

        assert.equal(result.sessionDigests.length, 1);
        assert.equal(result.sessionDigests[0].kind, "meta_turn");
        assert.equal(result.sessionDigests[0].actorType, "meta");
        assert.equal(result.sessionDigests[0].targetChatId, "g1");
        assert.match(result.sessionDigests[0].content, /Chiikawa Park/);
    });

    it("searches agent memory and returns timeline entries", async () => {
        const api = createMemoryApi(memory);
        const agentMemory = await api.searchAgentMemory("Chiikawa", { limit: 5 });
        assert.equal(agentMemory.sessionDigests.length, 1);
        assert.equal(agentMemory.sessionDigests[0].sourceChatId, "__meta__");

        const timeline = await api.getTimeline({ limit: 10, includeTopics: false });
        assert.ok(timeline.entries.some((entry) => entry.type === "session_digest" && entry.content.includes("Chiikawa")));
    });

    it("migrates legacy session digests idempotently", () => {
        const legacy = [{ createdAt: "2026-01-06T00:00:00.000Z", content: "legacy dream note" }];
        assert.equal(memory.migrateLegacySessionDigests(legacy), 1);
        assert.equal(memory.migrateLegacySessionDigests(legacy), 0);
        const rows = memory.searchAgentMemory("legacy dream", { limit: 10 });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, "legacy");
        assert.equal(rows[0].metadata?.migratedFrom, "global-state.sessionDigests");
    });

    it("migrates legacy OneBot mentions into person_chat_names, quarantines global names, and isolates across chats", async () => {
        const dir = mkdtempSync(join(tmpdir(), "onebot-legacy-mig-"));
        const dbPath = join(dir, "legacy.db");
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE message_log (
                message_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                reply_to_message_id TEXT,
                timestamp TEXT NOT NULL,
                media_type TEXT,
                media_info TEXT,
                mentions TEXT,
                access_control_blocked INTEGER NOT NULL DEFAULT 0,
                access_control_released INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (chat_id, message_id)
            );
            CREATE TABLE person_identities (
                user_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                aliases TEXT NOT NULL DEFAULT '[]',
                total_message_count INTEGER DEFAULT 0,
                last_seen_at TEXT,
                first_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `);
        legacy.prepare(`
            INSERT INTO person_identities (user_id, display_name, aliases, total_message_count, last_seen_at, first_seen_at, updated_at)
            VALUES (?, ?, ?, 5, ?, ?, ?)
        `).run("onebot:9001", "LeakedGroupACard", JSON.stringify(["GroupANick"]), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
        legacy.prepare(`
            INSERT INTO message_log (message_id, chat_id, user_id, display_name, text, timestamp, mentions)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            "m_legacy_1",
            "onebot:group:100",
            "onebot:8001",
            "SpeakerA",
            "hi @MentionedLegacy",
            "2026-01-02T00:00:00Z",
            JSON.stringify([{ userId: "onebot:9002", displayName: "MentionedLegacy", nameSource: "chat" }]),
        );
        legacy.close();

        const migratedMem = new MemoryStoreV2(dbPath);
        try {
            // 1. Quarantined legacy OneBot global identity must not leak into unrelated chats
            const identity = migratedMem.getPersonIdentity("onebot:9001");
            assert.equal(identity?.displayName, "");
            assert.deepEqual(identity?.aliases, []);
            const rawLegacy = (migratedMem as any).db.prepare(
                "SELECT legacy_onebot_names FROM person_identities WHERE user_id = ?"
            ).get("onebot:9001") as { legacy_onebot_names: string };
            assert.ok(rawLegacy.legacy_onebot_names.includes("LeakedGroupACard"));

            const api = createMemoryApi(migratedMem);
            // 2. Actual @ mention name resolves in group:100 without replay
            const hitIn100 = await api.resolvePerson("MentionedLegacy", { chatId: "onebot:group:100" });
            assert.equal(hitIn100.matches.length, 1);
            assert.equal(hitIn100.matches[0].identity.userId, "onebot:9002");
            assert.equal(hitIn100.matches[0].chatName?.kind, "mention_display");
            assert.equal(hitIn100.matches[0].identity.totalMessageCount, 0);
            // Mention-only user must NOT have a fabricated DB row in person_identities
            assert.equal(migratedMem.getPersonIdentity("onebot:9002"), null);

            // 3. Does NOT leak to group:200
            const hitIn200 = await api.resolvePerson("MentionedLegacy", { chatId: "onebot:group:200" });
            assert.equal(hitIn200.matches.length, 0);
            const leakedIn200 = await api.resolvePerson("LeakedGroupACard", { chatId: "onebot:group:200" });
            assert.equal(leakedIn200.matches.length, 0);
        } finally {
            migratedMem.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("excludes blocked and released-blocked messages from resolvePerson and getPersonDossier, and enforces sandbox viewer lock", async () => {
        const mem = createTestMemory("meta-api-scoped-lock");
        try {
            const chatA = "onebot:group:111";
            const chatB = "onebot:group:222";
            mem.storeIngestedBatch([
                {
                    messageId: "a1",
                    chatId: chatA,
                    userId: "onebot:501",
                    displayName: "GroupAUser",
                    text: "normal msg",
                    timestamp: "2026-02-01T10:00:00Z",
                    origin: "live",
                    countAsHuman: true,
                    statsHour: 10,
                },
                {
                    messageId: "a_blocked",
                    chatId: chatA,
                    userId: "onebot:502",
                    displayName: "BlockedName",
                    text: "secret blocked text",
                    timestamp: "2026-02-01T10:05:00Z",
                    accessControlBlocked: true,
                    origin: "live",
                    countAsHuman: false,
                    statsHour: null,
                },
                {
                    messageId: "a_released_blocked",
                    chatId: chatA,
                    userId: "onebot:503",
                    displayName: "ReleasedBlockedName",
                    text: "released blocked text",
                    timestamp: "2026-02-01T10:06:00Z",
                    accessControlBlocked: true,
                    origin: "live",
                    countAsHuman: false,
                    statsHour: null,
                },
                {
                    messageId: "b1",
                    chatId: chatB,
                    userId: "onebot:504",
                    displayName: "GroupBSecretNick",
                    text: "hello from B",
                    timestamp: "2026-02-01T11:00:00Z",
                    origin: "live",
                    countAsHuman: true,
                    statsHour: 11,
                },
            ]);
            // Release a_released_blocked (access_control_released = 1, access_control_blocked remains 1)
            mem.markAccessControlMessagesReleased(chatA);

            const trustedApi = createMemoryApi(mem);
            assert.equal((await trustedApi.resolvePerson("BlockedName", { chatId: chatA })).matches.length, 0);
            assert.equal((await trustedApi.resolvePerson("ReleasedBlockedName", { chatId: chatA })).matches.length, 0);

            // Even if looked up by userId, blocked messages must not appear in getPersonDossier
            const blockedDossier = await trustedApi.getPersonDossier("onebot:501", { chatId: chatA });
            assert.equal(blockedDossier.dossiers.length, 1);
            assert.ok(blockedDossier.dossiers[0].recentMessages.every(m => m.messageId === "a1"));

            // Sandbox viewer locked to chatA CANNOT override options.chatId to read chatB's local names
            const sandboxApi = createMemoryApi(mem, { boundChatId: chatA });
            const crossAttempt = await sandboxApi.resolvePerson("GroupBSecretNick", { chatId: chatB });
            assert.equal(crossAttempt.matches.length, 0);
            const ownHit = await sandboxApi.resolvePerson("GroupAUser", { chatId: chatB });
            assert.equal(ownHit.matches.length, 1);
            assert.equal(ownHit.matches[0].identity.userId, "onebot:501");

            // Dossier in sandbox cannot leak chatB's messages even if chatId: chatB is requested
            const crossDossier = await sandboxApi.getPersonDossier("onebot:504", { chatId: chatB });
            assert.equal(crossDossier.dossiers[0]?.recentMessages.length ?? 0, 0);
        } finally {
            cleanupTestMemory(mem, "meta-api-scoped-lock");
        }
    });

    it("returns distinct candidates for identical display names and avoids double counting in storeIngestedBatch", async () => {
        const mem = createTestMemory("meta-api-dup-names");
        try {
            const chat = "onebot:group:333";
            const msg1 = {
                messageId: "m1",
                chatId: chat,
                userId: "onebot:601",
                displayName: "SameNick",
                text: "first user",
                timestamp: "2026-03-01T08:00:00Z",
                origin: "live" as const,
                countAsHuman: true,
                statsHour: 8,
            };
            const msg2 = {
                messageId: "m2",
                chatId: chat,
                userId: "onebot:602",
                displayName: "SameNick",
                text: "second user",
                timestamp: "2026-03-01T09:00:00Z",
                origin: "live" as const,
                countAsHuman: true,
                statsHour: 9,
            };
            const res1 = mem.storeIngestedBatch([msg1, msg2]);
            assert.deepEqual(res1, { inserted: 2, duplicates: 0, conflicts: 0 });

            // Replay duplicate write: must NOT double-count message_count or active_hours
            const res2 = mem.storeIngestedBatch([msg1, msg2]);
            assert.deepEqual(res2, { inserted: 0, duplicates: 2, conflicts: 0 });

            const profiles = mem.getProfilesForChat(chat);
            const p601 = profiles.find(p => p.userId === "onebot:601");
            assert.equal(p601?.messageCount, 1);
            assert.equal(p601?.activeHours[8], 1);
            assert.equal(p601?.displayName, "SameNick");

            const api = createMemoryApi(mem);
            const resolved = await api.resolvePerson("SameNick", { chatId: chat });
            assert.equal(resolved.matches.length, 2);
            assert.deepEqual(
                resolved.matches.map(m => m.identity.userId).sort(),
                ["onebot:601", "onebot:602"],
            );
        } finally {
            cleanupTestMemory(mem, "meta-api-dup-names");
        }
    });

    it("rejects uncorroborated legacy OneBot mentions during migration, keeps corroborated ones, and resolves mention-only users by exact userId", async () => {
        const dir = mkdtempSync(join(tmpdir(), "onebot-legacy-corrob-"));
        const dbPath = join(dir, "legacy.db");
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE message_log (
                message_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                reply_to_message_id TEXT,
                timestamp TEXT NOT NULL,
                media_type TEXT,
                media_info TEXT,
                mentions TEXT,
                access_control_blocked INTEGER NOT NULL DEFAULT 0,
                access_control_released INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (chat_id, message_id)
            );
            CREATE TABLE person_identities (
                user_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                aliases TEXT NOT NULL DEFAULT '[]',
                total_message_count INTEGER DEFAULT 0,
                last_seen_at TEXT,
                first_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `);
        // Legacy pre-fix mention WITHOUT nameSource:
        // - onebot:9003 has NO sender observation in group:100 (e.g. leaked Group A card) -> MUST NOT be indexed
        // - onebot:9004 HAS a matching sender observation in group:100 -> corroborated, indexed
        // - onebot:9005 has nameSource: "chat" (mention-only user) -> indexed and resolvable by exact userId
        legacy.prepare(`
            INSERT INTO message_log (message_id, chat_id, user_id, display_name, text, timestamp, mentions)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            "m1",
            "onebot:group:100",
            "onebot:8001",
            "Speaker",
            "ping",
            "2026-01-01T00:00:00Z",
            JSON.stringify([
                { userId: "onebot:9003", displayName: "UncorroboratedCard" },
                { userId: "onebot:9004", displayName: "CorroboratedName" },
                { userId: "onebot:9005", displayName: "MentionOnlyScoped", nameSource: "chat" },
            ]),
        );
        legacy.prepare(`
            INSERT INTO message_log (message_id, chat_id, user_id, display_name, text, timestamp, mentions)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            "m2",
            "onebot:group:100",
            "onebot:9004",
            "CorroboratedName",
            "hello",
            "2026-01-02T00:00:00Z",
            null,
        );
        legacy.close();

        const mem = new MemoryStoreV2(dbPath);
        try {
            const api = createMemoryApi(mem);
            assert.equal((await api.resolvePerson("UncorroboratedCard", { chatId: "onebot:group:100" })).matches.length, 0);
            assert.equal((await api.resolvePerson("CorroboratedName", { chatId: "onebot:group:100" })).matches[0]?.identity.userId, "onebot:9004");

            // Exact userId lookup for mention-only user without person_identities row
            const byId = await api.resolvePerson("onebot:9005", { chatId: "onebot:group:100" });
            assert.equal(byId.matches.length, 1);
            assert.equal(byId.matches[0].identity.userId, "onebot:9005");
            assert.equal(byId.matches[0].identity.totalMessageCount, 0);
            assert.equal(byId.matches[0].chatName?.displayName, "MentionOnlyScoped");
            assert.equal(mem.getPersonIdentity("onebot:9005"), null);
        } finally {
            mem.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("deduplicates deleteMessages stats reversal, keeps manual edits across duplicate delivery, deletes self_claim on text edit, and renders scoped chatName in person quote header", async () => {
        const mem = createTestMemory("meta-api-stats-edit-quote");
        try {
            const chat = "onebot:group:444";
            const msg = {
                messageId: "m_stats_1",
                chatId: chat,
                userId: "onebot:701",
                displayName: "BadSenderName",
                text: "叫我SelfClaimedAlias",
                timestamp: "2026-03-01T08:00:00Z",
                origin: "live" as const,
                countAsHuman: true,
                statsHour: 8,
            };
            mem.storeIngestedBatch([msg]);
            // Insert an extra message so profile remains and check count=2
            mem.storeIngestedBatch([{
                ...msg,
                messageId: "m_stats_2",
                displayName: "GoodLocalCard",
                text: "normal text",
                statsHour: 9,
            }]);

            assert.equal(mem.getPersonIdentity("onebot:701")?.totalMessageCount, 2);

            // Repeated delete ID (including >200 chunk boundary) must only decrement by 1
            const bulkDuplicateIds = ["m_stats_1", ...Array.from({ length: 210 }, (_, i) => `nonexistent_${i}`), "m_stats_1"];
            const deleted = mem.deleteMessages(chat, bulkDuplicateIds);
            assert.equal(deleted, 1);
            assert.equal(mem.getPersonIdentity("onebot:701")?.totalMessageCount, 1);
            const profileAfterDel = mem.getProfilesForChat(chat).find(p => p.userId === "onebot:701")!;
            assert.equal(profileAfterDel.messageCount, 1);
            assert.equal(profileAfterDel.activeHours[8], 0);
            assert.equal(profileAfterDel.activeHours[9], 1);

            // Also test self_claim deletion on text edit + duplicate delivery not resurrecting invalidated sender name
            const msg3 = {
                messageId: "m_edit_1",
                chatId: chat,
                userId: "onebot:702",
                displayName: "OriginalWrongName",
                text: "以后叫我TempClaim",
                timestamp: "2026-03-01T10:00:00Z",
                origin: "live" as const,
                countAsHuman: true,
                statsHour: 10,
            };
            mem.storeIngestedBatch([msg3]);
            mem.insertChatNameObservations([{
                chatId: chat,
                messageId: "m_edit_1",
                userId: "onebot:702",
                kind: "self_claim",
                displayName: "TempClaim",
                observedAt: msg3.timestamp,
            }]);
            assert.equal(mem.searchChatNames(chat, "TempClaim").length, 1);
            assert.equal(mem.searchChatNames(chat, "OriginalWrongName").length, 1);

            mem.updateMessage(chat, "m_edit_1", { displayName: "Cleaned", text: "普通文本" });
            assert.equal(mem.searchChatNames(chat, "OriginalWrongName").length, 0);
            assert.equal(mem.searchChatNames(chat, "TempClaim").length, 0);

            // Replay duplicate delivery of msg3 must NOT resurrect OriginalWrongName
            const dupRes = mem.storeIngestedBatch([msg3]);
            assert.equal(dupRes.duplicates, 1);
            assert.equal(mem.searchChatNames(chat, "OriginalWrongName").length, 0);

            // Global displayName vs scoped chatName in person quote header
            mem.upsertPersonIdentity("discord:801", { displayName: "GlobalAccountName" });
            mem.storeIngestedBatch([{
                messageId: "d_local_1",
                chatId: "discord:g1:c1",
                userId: "discord:801",
                displayName: "ScopedServerNick",
                text: "hi",
                timestamp: "2026-03-01T11:00:00Z",
                origin: "live" as const,
                countAsHuman: true,
                statsHour: 11,
            }]);
            const quoted = await resolveQuoteRefs(
                [{ kind: "person", raw: "@person[discord:801 in discord:g1:c1]", query: "discord:801", chatId: "discord:g1:c1", source: "test" }],
                { memory: mem, boundChatId: "discord:g1:c1" },
            );
            assert.ok(quoted.items[0].content.includes("Candidate 1: ScopedServerNick (discord:801)"));
            assert.ok(!quoted.items[0].content.includes("Candidate 1: GlobalAccountName"));
        } finally {
            cleanupTestMemory(mem, "meta-api-stats-edit-quote");
        }
    });
});
