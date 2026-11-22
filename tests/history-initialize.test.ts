import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import type { AppConfig, LLMConfig } from "../src/core/config.js";
import { createMemoryApi } from "../src/meta-sandbox/meta-api/memory.js";
import { resolveQuoteRefs } from "../src/meta-sandbox/meta-api/quotes.js";
import { createSandboxHostCallHandler } from "../src/sandbox/host-call-handler.js";
import {
    HistoryLeaseError,
    HistoryUnitStaleError,
    NEWCOMER_AGENT_ROLE,
    computeMessagesDigest,
    localEmbed,
    mergeEpisodes,
    runReflection,
    trimProfileByTier,
} from "../src/memory-v2/index.js";
import { attestMemeTerm, looksTruncatedJson, runHistoryInitialization, runHistoryInitializationWithMemory, type HistoryLlmCallFn } from "../src/history/initialize.js";
import { dryRunQceImport, importQce } from "../src/history/qce-import.js";
import { openSqliteReadOnlyStrict } from "../src/history/sqlite-readonly.js";
import {
    DEFAULT_MAX_TOPICS_PER_BATCH,
    buildHistoryWindows,
    buildSynthesisMacroBatches,
    loadEligibleHistoryMessages,
    selectWindowsForMode,
    toDigestFields,
} from "../src/history/windows.js";
import { cleanupTestMemory, createTestMemory } from "./helpers/test-db.js";

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDirSafe(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    const defaultProfile: LLMConfig = {
        provider: "openai",
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "gpt-4o-mini",
        temperature: 0.3,
        maxTokens: 2048,
    };
    return {
        llmProfiles: {
            default: defaultProfile,
            fast: { ...defaultProfile, model: "fast-model" },
        },
        llmRouting: {
            recording_cluster: "default",
            recording_triage: "default",
            reflection: "default",
        },
        persona: { name: "Bot", description: "Test bot" },
        notification: { mentionKeywords: [] },
        reflection: {},
        embedding: {
            enabled: false,
            provider: "local",
            baseUrl: "https://example.invalid/v1",
            apiKey: "",
            model: "local",
            dimensions: 64,
            similarityMetric: "cosine",
        },
        privacy: {
            sensitiveChats: [],
            dmAutoPrivate: true,
            allowLlmMarkSensitive: true,
            enforce: "block",
        },
        ...overrides,
    };
}

function seedMessages(
    mem: ReturnType<typeof createTestMemory>,
    chatId: string,
    entries: Array<{
        id: string;
        userId: string;
        name: string;
        text: string;
        ts: string;
        qceMeta?: Record<string, unknown>;
        blocked?: boolean;
    }>,
): void {
    mem.storeIngestedBatch(entries.map(e => ({
        messageId: e.id,
        chatId,
        userId: e.userId,
        displayName: e.name,
        text: e.text,
        timestamp: e.ts,
        origin: "qce" as const,
        countAsHuman: e.userId !== "system",
        statsHour: 12,
        accessControlBlocked: e.blocked,
        qceMeta: e.qceMeta,
    })));
}

describe("History offline clustering & social memory initialization", () => {
    it("1. handles equal timestamps, gap/duration/count splits, quick selection, and full coverage reuse without duplicating topics", async () => {
        const mem = createTestMemory("hist-windows-mode");
        const chatId = "onebot:group:10001";
        try {
            const baseMs = Date.parse("2025-01-01T00:00:00.000Z");
            const msgs: Array<{ id: string; userId: string; name: string; text: string; ts: string }> = [];

            // Create 10 distinct windows separated by 1 hour (> gapMinutes 30)
            // Window 0: 5 msgs with identical timestamps
            for (let j = 0; j < 5; j++) {
                msgs.push({
                    id: `m_0_${j}`,
                    userId: j % 2 === 0 ? "onebot:111" : "onebot:222",
                    name: j % 2 === 0 ? "Alice" : "Bob",
                    text: `equal ts msg ${j}`,
                    ts: new Date(baseMs).toISOString(),
                });
            }
            // Windows 1..9: varying counts so highest-count & most-recent differ
            for (let w = 1; w <= 9; w++) {
                const count = w <= 4 ? 12 - w : 2; // w=1..4 have 11,10,9,8 msgs; w=5..9 have 2 msgs
                const start = baseMs + w * 3_600_000;
                for (let j = 0; j < count; j++) {
                    msgs.push({
                        id: `m_${w}_${String(j).padStart(2, "0")}`,
                        userId: j % 2 === 0 ? "onebot:111" : "onebot:222",
                        name: j % 2 === 0 ? "Alice" : "Bob",
                        text: `window ${w} msg ${j}`,
                        ts: new Date(start + j * 1000).toISOString(),
                    });
                }
            }
            // Also test count split: window 10 has 6 msgs where windowMessages = 4 -> splits into 4 + 2
            const w10Start = baseMs + 10 * 3_600_000;
            for (let j = 0; j < 6; j++) {
                msgs.push({
                    id: `m_10_${j}`,
                    userId: "onebot:111",
                    name: "Alice",
                    text: `count split ${j}`,
                    ts: new Date(w10Start + j * 1000).toISOString(),
                });
            }

            seedMessages(mem, chatId, msgs);
            const eligible = loadEligibleHistoryMessages(mem, chatId);
            const windows = buildHistoryWindows(eligible, { windowMessages: 12, windowHours: 4, gapMinutes: 30, minWindowMessages: 0 });
            // Window 0 (5 identical ts stay together) + Windows 1..10 = 11 windows
            assert.equal(windows.length, 11);
            assert.equal(windows[0].messages.length, 5);

            // Tiny windows fold into a neighbour, but never past windowMessages: window 0 (5)
            // cannot join window 1 (11), while the five 2-message windows pack into 12 + 6.
            const mergedWins = buildHistoryWindows(eligible, { windowMessages: 12, windowHours: 4, gapMinutes: 30 });
            assert.deepEqual(mergedWins.map(w => w.messages.length), [5, 11, 10, 9, 12, 6, 6]);
            assert.deepEqual(mergedWins.flatMap(w => w.messageIds), windows.flatMap(w => w.messageIds));

            // Check count split when windowMessages = 4
            const splitWins = buildHistoryWindows(eligible, { windowMessages: 4, windowHours: 4, gapMinutes: 30, minWindowMessages: 0 });
            assert.ok(splitWins.some(w => w.messages.length === 4 && w.messageIds[0] === "m_0_0"));

            // Quick mode selects top 6 recent + top 6 highest-count, deduplicated & chronological
            const quickSelected = selectWindowsForMode(windows, "quick", new Set());
            assert.ok(quickSelected.length <= 12 && quickSelected.length >= 6);
            for (let i = 1; i < quickSelected.length; i++) {
                assert.ok(quickSelected[i - 1].startedAt <= quickSelected[i].startedAt);
            }

            // Run quick init with mock LLM
            let clusterCalls = 0;
            const llmCall: HistoryLlmCallFn = async (opts) => {
                if (opts.stage === "cluster") {
                    clusterCalls++;
                    const ids = [...opts.messages[1].content.matchAll(/\[(m_[^\]]+)\]/g)].map(m => m[1]);
                    return {
                        content: JSON.stringify({
                            topics: [{ tempId: "t1", label: `Topic_${clusterCalls}`, messageIds: ids }],
                        }),
                    };
                }
                if (opts.stage === "summary") {
                    return {
                        content: JSON.stringify({
                            summaries: [{ tempId: "t_1", label: `Topic_${clusterCalls}`, summary: "sum", keyPoints: ["kp"], keywords: ["kw"], sentiment: "neutral" }],
                        }),
                    };
                }
                return { content: JSON.stringify({ groupUpdates: {}, memberProfiles: [], memes: [], groupObservations: [] }) };
            };

            const quickRes = await runHistoryInitializationWithMemory(mem, {
                chatId,
                mode: "quick",
                stage: "cluster",
                minWindowMessages: 0,
                config: makeTestConfig(),
                llmCall,
            });
            assert.equal(quickRes.processedClusterUnits, quickSelected.length);
            const coveredAfterQuick = mem.getCoveredMessageIds(chatId);
            const expectedQuickCovered = quickSelected.reduce((n, w) => n + w.messageIds.length, 0);
            assert.equal(coveredAfterQuick.size, expectedQuickCovered);

            // Full mode reuses history_cluster_coverage and only clusters uncovered windows!
            const beforeCalls = clusterCalls;
            const fullRes = await runHistoryInitializationWithMemory(mem, {
                chatId,
                mode: "full",
                stage: "cluster",
                minWindowMessages: 0,
                config: makeTestConfig(),
                llmCall,
            });
            assert.equal(fullRes.processedClusterUnits, windows.length - quickSelected.length);
            assert.equal(clusterCalls - beforeCalls, windows.length - quickSelected.length);
            assert.equal(mem.getCoveredMessageIds(chatId).size, eligible.length);
            // Total topics equals total windows (no duplicates)
            assert.equal(mem.getHistoricalTopicsForChat(chatId).length, windows.length);
        } finally {
            cleanupTestMemory(mem, "hist-windows-mode");
        }
    });

    it("2. splits chronologically on context-length errors and leaves unit paused/resumable on invalid JSON", async () => {
        const mem = createTestMemory("hist-shrink-resume");
        const chatId = "onebot:group:10002";
        try {
            const baseMs = Date.parse("2025-02-01T00:00:00.000Z");
            const msgs = Array.from({ length: 30 }, (_, i) => ({
                id: `msg_${String(i).padStart(2, "0")}`,
                userId: i % 2 === 0 ? "onebot:111" : "onebot:222",
                name: i % 2 === 0 ? "Alice" : "Bob",
                text: `message ${i}`,
                ts: new Date(baseMs + i * 10_000).toISOString(),
            }));
            seedMessages(mem, chatId, msgs);

            // Part A: context length error splits 30 -> 15 + 15 and covers ALL 30 messages
            const splitSizes: number[] = [];
            const shrinkLlm: HistoryLlmCallFn = async (opts) => {
                if (opts.stage === "cluster") {
                    const ids = [...opts.messages[1].content.matchAll(/\[(msg_\d+)\]/g)].map(m => m[1]);
                    splitSizes.push(ids.length);
                    if (ids.length > 15) {
                        throw new Error("maximum context length exceeded (context_length_exceeded)");
                    }
                    return {
                        content: JSON.stringify({
                            topics: [{ tempId: "t1", label: `Half_${ids[0]}`, messageIds: ids }],
                        }),
                    };
                }
                if (opts.stage === "summary") {
                    return {
                        content: JSON.stringify({
                            summaries: [{ tempId: "t_1", label: "Half", summary: "summary", keyPoints: ["k"], keywords: ["w"], sentiment: "positive" }],
                        }),
                    };
                }
                return { content: "{}" };
            };

            const res1 = await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "cluster",
                config: makeTestConfig(),
                llmCall: shrinkLlm,
            });
            assert.deepEqual(splitSizes, [30, 15, 15]);
            assert.equal(res1.topicsCommitted, 2);
            assert.equal(mem.getCoveredMessageIds(chatId).size, 30);

            // Part B: synthesis JSON that is complete but invalid pauses job and never commits empty; --resume succeeds
            const synthTopic = mem.getHistoricalTopicsForChat(chatId)[0];
            let attempt = 0;
            const flakySynthLlm: HistoryLlmCallFn = async (opts) => {
                attempt++;
                if (attempt <= 2) {
                    // Initial + schema repair both return closed-but-invalid JSON
                    return { content: '{"groupUpdates": {"description": oops}}' };
                }
                return {
                    content: JSON.stringify({
                        groupUpdates: {
                            description: "Resumed description",
                            evidence: [{ topicId: synthTopic.id, messageIds: ["msg_00"] }],
                        },
                        memberProfiles: [],
                        memes: [],
                        groupObservations: [],
                    }),
                };
            };

            await assert.rejects(
                runHistoryInitializationWithMemory(mem, {
                    chatId,
                    stage: "synthesize",
                    config: makeTestConfig(),
                    llmCall: flakySynthLlm,
                }),
                /Malformed JSON|Expected top-level/,
            );

            const pausedJob = mem.findLatestHistoryJob("initialize", chatId);
            assert.equal(pausedJob?.status, "paused");
            const synthUnitsBefore = mem.listHistoryUnits(pausedJob!.jobId, "synthesize");
            assert.equal(synthUnitsBefore.length, 1);
            assert.equal(synthUnitsBefore[0].completedAt, null);

            const resumed = await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "synthesize",
                resume: true,
                config: makeTestConfig(),
                llmCall: flakySynthLlm,
            });
            assert.equal(resumed.processedSynthesisUnits, 1);
            assert.equal(mem.getGroupModel(chatId)?.description, "Resumed description");
            assert.equal(mem.findLatestHistoryJob("initialize", chatId)?.status, "done");
        } finally {
            cleanupTestMemory(mem, "hist-shrink-resume");
        }
    });

    it("3. rolls back topics and history_cluster_coverage cleanly when FTS sync fails", () => {
        const mem = createTestMemory("hist-fts-rollback");
        const chatId = "onebot:group:10003";
        try {
            const ts = "2025-03-01T10:00:00.000Z";
            seedMessages(mem, chatId, [
                { id: "m1", userId: "onebot:111", name: "Alice", text: "hi", ts },
            ]);
            const eligible = loadEligibleHistoryMessages(mem, chatId);
            const [win] = buildHistoryWindows(eligible);

            const lease = mem.acquireHistoryLease(chatId);
            const job = mem.upsertHistoryJob({
                kind: "initialize",
                chatId,
                inputKey: "fts-test",
                optionsJson: "{}",
                status: "running",
            }, lease.ownerToken);
            mem.upsertHistoryUnits(job.jobId, "cluster", [{
                unitKey: win.unitKey,
                ordinal: 0,
                inputJson: "{}",
            }], lease.ownerToken);

            // Inject an FTS failure by dropping topics_fts inside SQLite
            const db = (mem as unknown as { db: import("better-sqlite3").Database }).db;
            db.exec(`DROP TABLE topics_fts;`);

            assert.throws(() => {
                mem.commitHistoricalClusterUnit({
                    jobId: job.jobId,
                    ownerToken: lease.ownerToken,
                    chatId,
                    unitKey: win.unitKey,
                    expectedMessageIds: win.messageIds,
                    expectedDigest: win.inputDigest,
                    topics: [{
                        historyKey: "hist_topic:t1",
                        label: "Rollback Topic",
                        summary: "Should roll back",
                        keyPoints: [],
                        participants: ["onebot:111"],
                        keywords: ["test"],
                        messageIds: ["m1"],
                        startedAt: ts,
                        endedAt: ts,
                        sentiment: "neutral",
                    }],
                    coveredPairs: [{ messageId: "m1", topicHistoryKey: "hist_topic:t1" }],
                    outputJson: "{}",
                });
            }, /no such table: topics_fts/);

            // Zero orphans in topics or history_cluster_coverage, unit still incomplete
            assert.equal(mem.getHistoricalTopicsForChat(chatId).length, 0);
            assert.equal(mem.getCoveredMessageIds(chatId).size, 0);
            assert.equal(mem.listHistoryUnits(job.jobId, "cluster")[0].completedAt, null);

            // Recreate topics_fts and also verify stale digest throws HistoryUnitStaleError
            db.exec(`CREATE VIRTUAL TABLE topics_fts USING fts5(label, summary, keywords);`);
            assert.throws(() => {
                mem.commitHistoricalClusterUnit({
                    jobId: job.jobId,
                    ownerToken: lease.ownerToken,
                    chatId,
                    unitKey: win.unitKey,
                    expectedMessageIds: win.messageIds,
                    expectedDigest: "deadbeef",
                    topics: [{
                        historyKey: "hist_topic:t1",
                        label: "Stale Topic",
                        summary: "Should fail stale",
                        keyPoints: [],
                        participants: ["onebot:111"],
                        keywords: [],
                        messageIds: ["m1"],
                        startedAt: ts,
                        endedAt: ts,
                        sentiment: "neutral",
                    }],
                    coveredPairs: [{ messageId: "m1", topicHistoryKey: "hist_topic:t1" }],
                    outputJson: "{}",
                });
            }, HistoryUnitStaleError);

            mem.releaseHistoryLease(chatId, lease.ownerToken);
        } finally {
            cleanupTestMemory(mem, "hist-fts-rollback");
        }
    });

    it("4. enforces citation grounding, rejects personalClaims/biographical from banter, and stores memes with boundaries", async () => {
        const mem = createTestMemory("hist-grounding-memes");
        const chatId = "onebot:group:10004";
        try {
            seedMessages(mem, chatId, [
                { id: "m1", userId: "onebot:111", name: "Alice", text: "Bob真是现充闲虫哈哈哈", ts: "2025-03-02T10:00:00.000Z" },
                { id: "m2", userId: "onebot:222", name: "Bob", text: "别叫我闲虫了，晚上打游戏吗", ts: "2025-03-02T10:01:00.000Z" },
                { id: "m3", userId: "onebot:111", name: "Alice", text: "好啊，晚上开黑打游戏", ts: "2025-03-02T10:02:00.000Z" },
            ]);

            const llmCall: HistoryLlmCallFn = async (opts) => {
                if (opts.stage === "cluster") {
                    return {
                        content: JSON.stringify({
                            topics: [{ tempId: "t1", label: "闲虫调侃", messageIds: ["m1", "m2", "m3"] }],
                        }),
                    };
                }
                if (opts.stage === "summary") {
                    return {
                        content: JSON.stringify({
                            summaries: [{ tempId: "t_1", label: "闲虫调侃", summary: "Alice调侃Bob是现充", keyPoints: ["玩梗"], keywords: ["现充", "闲虫"], sentiment: "positive" }],
                        }),
                    };
                }
                const topic = mem.getHistoricalTopicsForChat(chatId)[0];
                return {
                    content: JSON.stringify({
                        groupUpdates: {
                            description: "轻松互损的熟人游戏群",
                            dominantLanguage: "zh",
                            engagementLevel: "high",
                            communicationNorms: ["喜欢互相玩梗调侃"],
                            hotTopics: ["游戏"],
                            evidence: [{ topicId: topic.id, messageIds: ["m1", "m2"] }],
                        },
                        // Attempt to fabricate personalClaims + invalid citations + valid trait
                        personalClaims: [
                            { subject: "onebot:222", content: "Bob现实中是个大现充", category: "biographical", topicId: topic.id, messageIds: ["m1"] },
                        ],
                        memberProfiles: [
                            {
                                userId: "onebot:111",
                                traits: [
                                    { value: "喜欢开玩笑调侃群友", topicId: topic.id, messageIds: ["m1"] },
                                    { value: "幻觉特征", topicId: "nonexistent_topic", messageIds: ["m1"] },
                                    { value: "跨群幻觉特征", topicId: topic.id, messageIds: ["other_chat_msg"] },
                                ],
                                interests: [],
                                episodes: [
                                    { summary: "调侃Bob为闲虫", sentiment: "positive", significance: 4, topicId: topic.id, messageIds: ["m1"] },
                                ],
                            },
                        ],
                        memes: [
                            {
                                canonicalKey: "xiancong",
                                term: "闲虫",
                                meaning: "对“现充”的谐音反讽调侃，并非真的指虫子或社交达人",
                                originContext: "Alice常拿Bob在群里开玩笑称他闲虫",
                                participants: ["onebot:111", "onebot:222"],
                                usageBoundaries: "仅限本群熟人开玩笑语境，不要当成真实履历或对陌生人乱用",
                                topicId: topic.id,
                                messageIds: ["m1", "m2"],
                            },
                            {
                                canonicalKey: "invalid-meme",
                                term: "假梗",
                                meaning: "没有有效引用",
                                topicId: topic.id,
                                messageIds: ["not_in_batch"],
                            },
                        ],
                        groupObservations: [
                            {
                                canonicalKey: "evening-gaming",
                                content: "群友习惯在玩笑后约晚上一起打游戏",
                                topicId: topic.id,
                                messageIds: ["m2", "m3"],
                            },
                        ],
                    }),
                };
            };

            const res = await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "all",
                config: makeTestConfig(),
                llmCall,
            });

            // Only 2 grounded facts (1 meme + 1 observation); personalClaims and invalid meme rejected!
            assert.equal(res.factsCommitted, 2);
            const allFacts = mem.listCoreFacts({ sourceChatId: chatId, includeAllHistory: true }).items;
            assert.equal(allFacts.length, 2);
            assert.ok(allFacts.every(f => f.category !== "biographical"));

            const memeFact = allFacts.find(f => f.category === "anecdote");
            assert.ok(memeFact);
            assert.equal(memeFact.subject, `group:${chatId}`);
            assert.match(memeFact.content, /闲虫/);
            assert.match(memeFact.content, /使用边界/);
            assert.deepEqual(memeFact.sourceMessageIds, ["m1", "m2"]);

            const aliceProfile = mem.getProfilesForChat(chatId).find(p => p.userId === "onebot:111")!;
            assert.deepEqual(aliceProfile.traits, ["喜欢开玩笑调侃群友"]);
            assert.equal(aliceProfile.recentEpisodes.length, 1);
            assert.equal(aliceProfile.recentEpisodes[0].origin, "offline_history");
        } finally {
            cleanupTestMemory(mem, "hist-grounding-memes");
        }
    });

    it("5. enforces newcomer guard, excludes offline episodes from live reflection merge, and preserves live/manual edits via hash guard", async () => {
        const mem = createTestMemory("hist-newcomer-hashguard");
        const chatId = "onebot:group:10005";
        try {
            seedMessages(mem, chatId, [
                { id: "m1", userId: "onebot:111", name: "Alice", text: "今天代码又崩了", ts: "2024-01-01T10:00:00.000Z" },
                { id: "m2", userId: "onebot:222", name: "Bob", text: "哈哈我也是", ts: "2024-01-01T10:05:00.000Z" },
            ]);
            // Pre-commit historical topic so we can run synthesize with an in-flight manual edit
            const lease0 = mem.acquireHistoryLease(chatId);
            const job0 = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "pre", optionsJson: "{}", status: "running" }, lease0.ownerToken);
            const eligible = loadEligibleHistoryMessages(mem, chatId);
            const [win] = buildHistoryWindows(eligible);
            mem.upsertHistoryUnits(job0.jobId, "cluster", [{ unitKey: win.unitKey, ordinal: 0, inputJson: "{}" }], lease0.ownerToken);
            mem.commitHistoricalClusterUnit({
                jobId: job0.jobId,
                ownerToken: lease0.ownerToken,
                chatId,
                unitKey: win.unitKey,
                expectedMessageIds: win.messageIds,
                expectedDigest: win.inputDigest,
                topics: [{
                    historyKey: "hist_topic:t1",
                    label: "写代码日常",
                    summary: "聊写代码崩了",
                    keyPoints: [],
                    participants: ["onebot:111", "onebot:222"],
                    keywords: ["代码"],
                    messageIds: ["m1", "m2"],
                    startedAt: "2024-01-01T10:00:00.000Z",
                    endedAt: "2024-01-01T10:05:00.000Z",
                    sentiment: "neutral",
                }],
                coveredPairs: [
                    { messageId: "m1", topicHistoryKey: "hist_topic:t1" },
                    { messageId: "m2", topicHistoryKey: "hist_topic:t1" },
                ],
                outputJson: "{}",
            });
            mem.updateHistoryJobStatus(job0.jobId, lease0.ownerToken, "done");
            mem.releaseHistoryLease(chatId, lease0.ownerToken);

            const topicId = mem.getHistoricalTopicsForChat(chatId)[0].id;

            // Simulate concurrent live/manual edits while LLM synthesis call is in flight!
            const llmCall: HistoryLlmCallFn = async () => {
                // While LLM is running, user manually edits group description and member communicationStyle
                mem.upsertGroupModel(chatId, { description: "人工手动维护的群描述" });
                mem.upsertPersonGroupProfile("onebot:111", chatId, { communicationStyle: "人工维护的风格" });

                return {
                    content: JSON.stringify({
                        groupUpdates: {
                            description: "离线LLM试图覆盖的描述",
                            dominantLanguage: "zh",
                            engagementLevel: "high",
                            communicationNorms: ["经常吐槽写代码"],
                            agentRole: "试图篡改的群宠",
                            evidence: [{ topicId, messageIds: ["m1", "m2"] }],
                        },
                        memberProfiles: [
                            {
                                userId: "onebot:111",
                                traits: [{ value: "爱吐槽bug", topicId, messageIds: ["m1"] }],
                                communicationStyle: { value: "离线LLM试图覆盖的风格", topicId, messageIds: ["m1"] },
                                relationToAgent: "核心死党",
                                dunbarTier: 1,
                                affinityScore: 95,
                                episodes: [
                                    { summary: "吐槽代码崩了", sentiment: "neutral", significance: 4, topicId, messageIds: ["m1"] },
                                ],
                            },
                        ],
                        globalPersonUpdates: [
                            { userId: "onebot:111", relationToAgent: "全局挚友" },
                        ],
                        memes: [],
                        groupObservations: [],
                    }),
                };
            };

            await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "synthesize",
                config: makeTestConfig(),
                llmCall,
            });

            const gm = mem.getGroupModel(chatId)!;
            assert.equal(gm.description, "人工手动维护的群描述"); // Manual edit won!
            assert.equal(gm.agentRole, "新入群观察者（正在熟悉群聊文化与成员）"); // Code-chosen newcomer role!
            assert.equal(gm.lastReflectedAt, null); // Reflection cursor untouched!

            const alice = mem.getProfilesForChat(chatId).find(p => p.userId === "onebot:111")!;
            // Newcomer guard enforced:
            assert.equal(alice.dunbarTier, 4);
            assert.equal(alice.affinityScore, 0);
            assert.equal(alice.relationToAgent, "");
            assert.equal(alice.communicationStyle, "人工维护的风格"); // Manual edit won!
            assert.deepEqual(alice.traits, ["爱吐槽bug"]);
            assert.equal(mem.listInteractions({ chatId }).total, 0); // Zero fake interactions!
            assert.equal(mem.getPersonProfile("onebot:111"), null); // Global profile untouched!

            // Live reflection episode helpers MUST NOT age, merge, or promote offline_history episodes!
            assert.equal(trimProfileByTier("onebot:111", chatId, mem), false);
            assert.equal(await mergeEpisodes("onebot:111", chatId, mem), 0);
            const aliceAfterReflection = mem.getProfilesForChat(chatId).find(p => p.userId === "onebot:111")!;
            assert.equal(aliceAfterReflection.recentEpisodes.length, 1);
            assert.equal(aliceAfterReflection.recentEpisodes[0].origin, "offline_history");
            assert.equal(aliceAfterReflection.mergedMemory.length, 0);
            assert.equal(mem.getPersonProfile("onebot:111"), null);
        } finally {
            cleanupTestMemory(mem, "hist-newcomer-hashguard");
        }
    });

    it("6. enforces same-chat scoping before LIMIT, protects historical facts from live Reflection, isolates liveOnly topics, and supports Discord exact-chat culture overlay", async () => {
        const mem = createTestMemory("hist-scoping-isolation");
        const chatA = "onebot:group:20001";
        const chatB = "onebot:group:20002";
        const discordChannel = "discord:guild99:chan42";
        try {
            seedMessages(mem, chatA, [
                { id: "a1", userId: "onebot:111", name: "Alice", text: "咱们群特有暗号叫量子咸鱼", ts: "2025-04-01T10:00:00.000Z" },
                { id: "a2", userId: "onebot:222", name: "Bob", text: "对对对，量子咸鱼启动", ts: "2025-04-01T10:01:00.000Z" },
            ]);
            seedMessages(mem, chatB, [
                { id: "b1", userId: "onebot:333", name: "Carol", text: "普通聊天", ts: "2025-04-01T11:00:00.000Z" },
            ]);

            const llmCallA: HistoryLlmCallFn = async (opts) => {
                if (opts.stage === "cluster") {
                    return { content: JSON.stringify({ topics: [{ tempId: "t1", label: "量子咸鱼暗号", messageIds: ["a1", "a2"] }] }) };
                }
                if (opts.stage === "summary") {
                    return { content: JSON.stringify({ summaries: [{ tempId: "t_1", label: "量子咸鱼暗号", summary: "量子咸鱼是本群专属暗号", keyPoints: ["量子咸鱼"], keywords: ["量子咸鱼"], sentiment: "positive" }] }) };
                }
                const topic = mem.getHistoricalTopicsForChat(chatA)[0];
                return {
                    content: JSON.stringify({
                        groupUpdates: {
                            description: "ChatA 文化",
                            evidence: [{ topicId: topic.id, messageIds: ["a1", "a2"] }],
                        },
                        memberProfiles: [],
                        memes: [{
                            canonicalKey: "quantum-fish",
                            term: "量子咸鱼",
                            meaning: "ChatA 专属暗号，指一边摸鱼一边说在工作",
                            usageBoundaries: "仅限 ChatA 内部",
                            topicId: topic.id,
                            messageIds: ["a1", "a2"],
                        }],
                        groupObservations: [],
                    }),
                };
            };

            await runHistoryInitializationWithMemory(mem, {
                chatId: chatA,
                stage: "all",
                config: makeTestConfig(),
                llmCall: llmCallA,
            });

            // Live fact that also matches "量子咸鱼" (space-delimited token for FTS5)
            mem.storeFact("onebot:999", "量子咸鱼 是通用网络词汇示例", "general", "live");

            // 1. Unscoped searchFacts (authorizedChatId omitted) MUST exclude historical fact BEFORE LIMIT!
            const unscopedFacts = mem.searchFacts("量子咸鱼", { limit: 1 });
            assert.equal(unscopedFacts.length, 1);
            assert.equal(unscopedFacts[0].subject, "onebot:999");

            // 2. ChatB-scoped searchFacts MUST exclude ChatA historical fact!
            const chatBFacts = mem.searchFacts("量子咸鱼", { limit: 10, authorizedChatId: chatB });
            assert.equal(chatBFacts.length, 1);
            assert.equal(chatBFacts[0].subject, "onebot:999");

            // 3. ChatA-scoped searchFacts & recall & createMemoryApi CAN see ChatA's historical meme & topic!
            const chatAFacts = mem.searchFacts("量子咸鱼", { limit: 10, authorizedChatId: chatA });
            assert.equal(chatAFacts.length, 2);
            const chatARecall = await mem.recall("量子咸鱼", { chatId: chatA, maxResults: 10 });
            assert.equal(chatARecall.topics.length, 1);
            assert.ok(chatARecall.facts.some(f => f.sourceChatId === chatA));

            // 4. Unscoped recall & browseHistory MUST NOT leak ChatA historical topics or facts!
            const unscopedRecall = await mem.recall("量子咸鱼", { maxResults: 10 });
            assert.equal(unscopedRecall.topics.length, 0);
            assert.ok(unscopedRecall.facts.every(f => f.sourceChatId !== chatA));

            const unscopedBrowse = await mem.browseHistory({ intent: "量子咸鱼", skipIntentLlm: true });
            assert.equal(unscopedBrowse.segments.length, 0);

            const scopedApi = createMemoryApi(mem, { boundChatId: chatA });
            const scopedSearch = await scopedApi.searchEntities("量子咸鱼");
            assert.equal(scopedSearch.recentSessions.length, 1);
            assert.ok(scopedSearch.coreFacts.some(f => f.sourceChatId === chatA));

            const unscopedApi = createMemoryApi(mem);
            const unscopedSearch = await unscopedApi.searchEntities("量子咸鱼");
            assert.equal(unscopedSearch.recentSessions.length, 0);
            assert.ok(unscopedSearch.coreFacts.every(f => f.sourceChatId !== chatA));

            // 5. getTopicsSince(liveOnly: true) excludes offline topics and includes newly added live topic
            assert.equal(mem.getTopicsSince(chatA, "1970-01-01T00:00:00.000Z", { liveOnly: true }).length, 0);
            mem.upsertTopic("live_pipe_1", {
                chatId: chatA,
                label: "Live Topic",
                summary: "Live summary",
                startedAt: "2025-05-01T10:00:00.000Z",
            });
            const liveTopics = mem.getTopicsSince(chatA, "1970-01-01T00:00:00.000Z", { liveOnly: true });
            assert.equal(liveTopics.length, 1);
            assert.equal(liveTopics[0].label, "Live Topic");

            // 6. Live Reflection cannot delete or update historical fact!
            const histFactId = mem.listCoreFacts({ sourceChatId: chatA, includeAllHistory: true }).items[0].id;
            assert.equal(mem.isHistoricalFact(histFactId), true);
            // Mock fetch for runReflection LLM call
            const origFetch = globalThis.fetch;
            globalThis.fetch = (async () => new Response(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            personUpdates: [],
                            groupUpdates: {},
                            factUpdates: [
                                { id: histFactId, action: "delete", subject: `group:${chatA}`, content: "", category: "anecdote" },
                            ],
                            topicsSummary: [],
                            insights: "ok",
                        }),
                    },
                }],
            }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
            try {
                await runReflection(chatA, mem, makeTestConfig().llmProfiles.default ? [makeTestConfig().llmProfiles.default] : []);
            } finally {
                globalThis.fetch = origFetch;
            }
            assert.ok(mem.getFactById(histFactId) !== null);

            // 7. Discord exact-chat culture overlay without overwriting guild-wide row
            mem.upsertGroupModel("discord:guild99", {
                chatTitle: "Guild 99",
                description: "Guild-wide default",
                quietMode: true,
                markedSensitive: true,
            });
            seedMessages(mem, discordChannel, [
                { id: "d1", userId: "discord:u1", name: "Dan", text: "channel 42 dev chat", ts: "2025-04-02T10:00:00.000Z" },
            ]);
            const leaseDc = mem.acquireHistoryLease(discordChannel);
            const jobDc = mem.upsertHistoryJob({ kind: "initialize", chatId: discordChannel, inputKey: "dc", optionsJson: "{}", status: "running" }, leaseDc.ownerToken);
            mem.upsertHistoryUnits(jobDc.jobId, "synthesize", [{ unitKey: "dc-synth", ordinal: 0, inputJson: "{}" }], leaseDc.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: jobDc.jobId,
                ownerToken: leaseDc.ownerToken,
                chatId: discordChannel,
                unitKey: "dc-synth",
                rankKey: "2025-W14#0000",
                groupPatch: { description: "Channel 42 Dev Culture", hotTopics: ["Rust"] },
                memberPatches: [],
                factProposals: [],
                outputJson: "{}",
                isPrivateOrSensitive: true,
            });
            mem.releaseHistoryLease(discordChannel, leaseDc.ownerToken);

            // Guild-wide description preserved!
            assert.equal(mem.getGroupModel("discord:guild99")?.description, "Guild-wide default");
            // Culture overlay merges channel description with guild-level quietMode & markedSensitive!
            const overlaid = mem.getGroupCultureModel(discordChannel)!;
            assert.equal(overlaid.description, "Channel 42 Dev Culture");
            assert.deepEqual(overlaid.hotTopics, ["Rust"]);
            assert.equal(overlaid.quietMode, true);
            assert.equal(overlaid.markedSensitive, true);
        } finally {
            cleanupTestMemory(mem, "hist-scoping-isolation");
        }
    });

    it("7. blocks private chats without --allow-private-llm, enforces strict --profile, and makes 0 LLM calls/DB writes on --dry-run", async () => {
        const mem = createTestMemory("hist-privacy-dryrun");
        const privChat = "onebot:private:55555";
        const pubChat = "onebot:group:55556";
        try {
            seedMessages(mem, privChat, [
                { id: "p1", userId: "onebot:55555", name: "PrivUser", text: "secret message", ts: "2025-04-05T10:00:00.000Z" },
            ]);
            seedMessages(mem, pubChat, [
                { id: "g1", userId: "onebot:111", name: "Alice", text: "public message", ts: "2025-04-05T10:00:00.000Z" },
            ]);

            let llmCalls = 0;
            const countingLlm: HistoryLlmCallFn = async () => {
                llmCalls++;
                return { content: "{}" };
            };

            // Private chat blocked before any LLM call
            await assert.rejects(
                runHistoryInitializationWithMemory(mem, {
                    chatId: privChat,
                    stage: "all",
                    config: makeTestConfig(),
                    llmCall: countingLlm,
                }),
                /--allow-private-llm/,
            );
            assert.equal(llmCalls, 0);

            // Missing --profile throws strictly
            await assert.rejects(
                runHistoryInitializationWithMemory(mem, {
                    chatId: pubChat,
                    stage: "all",
                    profile: "nonexistent-profile",
                    config: makeTestConfig(),
                    llmCall: countingLlm,
                }),
                /not found in config\.llmProfiles/,
            );
            assert.equal(llmCalls, 0);

            // --dry-run makes 0 LLM calls and 0 DB writes
            const dryRes = await runHistoryInitializationWithMemory(mem, {
                chatId: pubChat,
                stage: "all",
                dryRun: true,
                config: makeTestConfig(),
                llmCall: countingLlm,
            });
            assert.equal(dryRes.dryRun, true);
            assert.equal(dryRes.selectedWindows, 1);
            assert.equal(dryRes.estimatedClusterCalls, 2);
            assert.equal(llmCalls, 0);
            assert.equal(mem.getHistoricalTopicsForChat(pubChat).length, 0);
            assert.equal(mem.findLatestHistoryJob("initialize", pubChat), null);
        } finally {
            cleanupTestMemory(mem, "hist-privacy-dryrun");
        }
    });

    it("8. CLI exit codes and dry-run smoke test", () => {
        const dir = makeTempDir("hist-cli-smoke-");
        try {
            const tsxLoader = path.resolve("node_modules/tsx/dist/loader.mjs");
            const cliEntry = path.resolve("src/cli.ts");
            const runCli = (args: string[], cwd = dir) => spawnSync(
                process.execPath,
                ["--import", tsxLoader, cliEntry, ...args],
                { cwd, encoding: "utf8" },
            );

            const helpImport = runCli(["history", "import", "--help"]);
            assert.equal(helpImport.status, 0);
            assert.match(helpImport.stdout, /history import/);

            const helpInit = runCli(["history", "init", "--help"]);
            assert.equal(helpInit.status, 0);
            assert.match(helpInit.stdout, /history init/);

            const badFormatPath = path.join(dir, "bad.html");
            fs.writeFileSync(badFormatPath, "<html></html>", "utf8");
            const badFormatRes = runCli(["history", "import", badFormatPath, "--db", path.join(dir, "bad-format.db")]);
            assert.equal(badFormatRes.status, 2);

            const missingInputRes = runCli(["history", "init", "--stage", "import"]);
            assert.equal(missingInputRes.status, 2);

            const freshDir = path.join(dir, "fresh-dry-run");
            fs.mkdirSync(freshDir, { recursive: true });
            const qcePath = path.join(freshDir, "fixture.json");
            fs.writeFileSync(qcePath, JSON.stringify({
                chatInfo: { name: "CLI Smoke Group", type: "group", uin: "777001" },
                messages: [
                    { id: "1", timestamp: 1714521600, sender: { uin: "10001", nickname: "Alice" }, content: { text: "hello cli" } },
                ],
            }), "utf8");
            const dryRunRes = runCli(["history", "import", qcePath, "--dry-run"], freshDir);
            assert.equal(dryRunRes.status, 0, dryRunRes.stderr);
            const jsonStart = dryRunRes.stdout.indexOf("{");
            assert.ok(jsonStart >= 0, `Expected JSON output in stdout: ${dryRunRes.stdout}`);
            const parsed = JSON.parse(dryRunRes.stdout.slice(jsonStart));
            assert.equal(parsed.dryRun, true);
            assert.equal(parsed.chatId, "onebot:group:777001");
            assert.equal(fs.existsSync(path.join(freshDir, "workspace", "memory.db")), false);
        } finally {
            rmDirSafe(dir);
        }
    });

    it("9. blocks sandbox includeAllHistory bypass, foreign shared-chat history readers, blocked/released text leakage, and verifies index range seek", async () => {
        const mem = createTestMemory("hist-remediation-a");
        const chatA = "onebot:group:9101";
        const chatB = "onebot:group:9102";
        const chatC = "onebot:group:9103";
        try {
            // Seed shared ChatB with historical topic/fact/member profile AND a live topic/fact/msg
            seedMessages(mem, chatB, [
                { id: "hb1", userId: "onebot:u2", name: "BobInB", text: "历史暗号 蓝莓派", ts: "2025-03-01T10:00:00.000Z" },
            ]);
            const leaseB = mem.acquireHistoryLease(chatB);
            const jobB = mem.upsertHistoryJob({ kind: "initialize", chatId: chatB, inputKey: "b", optionsJson: "{}", status: "running" }, leaseB.ownerToken);
            mem.upsertHistoryUnits(jobB.jobId, "cluster", [{ unitKey: "b-c1", ordinal: 0, inputJson: "{}" }], leaseB.ownerToken);
            const cRes = mem.commitHistoricalClusterUnit({
                jobId: jobB.jobId,
                ownerToken: leaseB.ownerToken,
                chatId: chatB,
                unitKey: "b-c1",
                expectedMessageIds: ["hb1"],
                expectedDigest: computeMessagesDigest(toDigestFields(loadEligibleHistoryMessages(mem, chatB))),
                topics: [{
                    historyKey: "b:hist:1",
                    label: "历史话题 蓝莓派",
                    summary: "ChatB 离线历史蓝莓派讨论",
                    keyPoints: ["蓝莓派"],
                    participants: ["onebot:u2"],
                    keywords: ["蓝莓派"],
                    messageIds: ["hb1"],
                    startedAt: "2025-03-01T10:00:00.000Z",
                    endedAt: "2025-03-01T10:05:00.000Z",
                    sentiment: "neutral",
                }],
                coveredPairs: [{ messageId: "hb1", topicHistoryKey: "b:hist:1" }],
                outputJson: "{}",
            });
            const histTopicId = cRes.topicIds[0];
            mem.upsertHistoryUnits(jobB.jobId, "synthesize", [{ unitKey: "b-s1", ordinal: 0, inputJson: "{}" }], leaseB.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: jobB.jobId,
                ownerToken: leaseB.ownerToken,
                chatId: chatB,
                unitKey: "b-s1",
                rankKey: "2025-W09#0000",
                groupPatch: {},
                memberPatches: [{
                    userId: "onebot:u2",
                    traits: ["历史特质_蓝莓派"],
                    interests: ["历史兴趣_蓝莓"],
                    communicationStyle: "离线历史风格",
                    episodes: [{
                        id: "ep_hist_b",
                        date: "2025-03-01T10:00:00.000Z",
                        topicId: histTopicId,
                        summary: "离线历史互动_蓝莓派",
                        sentiment: "positive",
                        significance: 0.8,
                        messageIds: ["hb1"],
                    }],
                }],
                factProposals: [{
                    historyKey: "fact:b:1",
                    subject: `group:${chatB}`,
                    category: "anecdote",
                    content: "蓝莓派 离线历史事实",
                    sourceTopicId: histTopicId,
                    sourceMessageIds: ["hb1"],
                    observedAt: "2025-03-01T10:00:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(chatB, leaseB.ownerToken);
            // Also insert a legacy/direct historical person-subject fact via SQL to verify getUserProfile isolation
            (mem as any).db.prepare(`
                INSERT INTO core_facts (id, subject, content, category, confidence, source_chat_id, history_key, created_at, updated_at)
                VALUES ('legacy_hist_u2', 'onebot:u2', 'legacy hist fact', 'anecdote', 0.8, ?, 'legacy:fact:u2', '2025-03-01T10:00:00.000Z', '2025-03-01T10:00:00.000Z')
            `).run(chatB);

            // Live topic & fact in ChatB
            mem.upsertTopic("live_b_1", {
                chatId: chatB,
                label: "实时话题 蓝莓派",
                summary: "ChatB 实时蓝莓派",
                participants: ["onebot:u2"],
                keywords: ["蓝莓派"],
                startedAt: "2026-03-01T10:00:00.000Z",
            });
            // Also give onebot:u2 a profile in unrelated ChatC to test recall resolvePersonsFromTopics
            mem.upsertPersonGroupProfile("onebot:u2", chatC, {
                relationToAgent: "ChatC关系",
                traits: ["ChatC特质"],
            });

            // Sandbox handler bound to ChatA
            const handler = createSandboxHostCallHandler(chatA, {
                appConfig: {},
                globalState: {},
                accumulator: { ingest: () => undefined },
                memory: mem,
                adapters: [],
                sandbox: {},
                sandboxPool: {},
                mcpBridge: {},
                buildEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
                getCurrentEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
                setCurrentEnvPlan: () => undefined,
            } as any);

            // 1. Sandbox cannot bypass via includeAllHistory: true or authorizedChatId: chatB
            const factBypass = await handler("memory.searchFacts", ["蓝莓派", { includeAllHistory: true, authorizedChatId: chatB }]) as any[];
            assert.equal(factBypass.length, 0);

            const topicBypass = await handler("memory.searchTopics", ["蓝莓派", { chatId: chatB, includeAllHistory: true, authorizedChatId: chatB }]) as any[];
            assert.equal(topicBypass.length, 1);
            assert.equal(topicBypass[0].label, "实时话题 蓝莓派");

            const timelineBypass = await handler("memory.getTimeline", [{ chatId: chatB, includeAllHistory: true, includeDigests: false }]) as { entries: any[] };
            assert.equal(timelineBypass.entries.length, 1);
            assert.equal(timelineBypass.entries[0].title, "实时话题 蓝莓派");

            const profileBypass = await handler("memory.getUserProfile", ["onebot:u2", chatB]) as any;
            assert.equal(profileBypass.recentFacts.length, 0);
            assert.deepEqual(profileBypass.groupProfile.recentEpisodes, []);
            assert.deepEqual(profileBypass.groupProfile.traits, []);
            assert.deepEqual(profileBypass.groupProfile.interests, []);
            assert.equal(profileBypass.groupProfile.communicationStyle, "");

            // 2. Direct @topic quote blocks foreign historical topic, allows own historical topic
            const foreignTopicQuote = await resolveQuoteRefs(
                [{ kind: "topic", raw: `@topic[${histTopicId}]`, topicId: histTopicId, source: "test" }],
                { memory: mem, boundChatId: chatA },
            );
            assert.equal(foreignTopicQuote.items[0].content, "");
            assert.equal(foreignTopicQuote.items[0].title.includes("历史话题 蓝莓派"), false);
            assert.equal(foreignTopicQuote.renderedMarkdown?.includes("历史话题 蓝莓派"), false);
            assert.equal(foreignTopicQuote.renderedMarkdown?.includes("历史上在ChatB聊过蓝莓派"), false);
            assert.ok(foreignTopicQuote.items[0].warnings.some(w => w.includes("离线历史话题")));

            const ownTopicQuote = await resolveQuoteRefs(
                [{ kind: "topic", raw: `@topic[${histTopicId}]`, topicId: histTopicId, source: "test" }],
                { memory: mem, boundChatId: chatB },
            );
            assert.ok(ownTopicQuote.items[0].content.includes("蓝莓派"));

            // 3. recall attaches ChatB's profile for topic participant, never ChatC's unrelated profile
            const recallRes = await mem.recall("实时话题 蓝莓派", { chatId: chatB, maxResults: 5 });
            assert.equal(recallRes.persons.length, 1);
            assert.equal(recallRes.persons[0].chatId, chatB);

            // 4. Blocked & released-blocked text excluded from browseHistory, quotes, and reflection
            mem.storeMessageBatch([
                {
                    messageId: "blk_1",
                    chatId: chatA,
                    userId: "onebot:u9",
                    displayName: "BlockedSender",
                    text: "绝密拦截文本_NEVER_LEAK",
                    timestamp: "2026-03-02T10:00:00.000Z",
                    accessControlBlocked: true,
                },
                {
                    messageId: "ok_1",
                    chatId: chatA,
                    userId: "onebot:u8",
                    displayName: "AllowedSender",
                    text: "正常文本_OK_TO_READ",
                    timestamp: "2026-03-02T10:01:00.000Z",
                },
            ]);
            mem.markAccessControlMessagesReleased(chatA);
            mem.upsertTopic("live_a_blk", {
                chatId: chatA,
                label: "混合话题",
                summary: "包含阻塞与正常消息",
                participants: ["onebot:u8", "onebot:u9"],
                keywords: ["混合话题"],
                messageRange: { messageIds: ["blk_1", "ok_1"], count: 2 },
                startedAt: "2026-03-02T10:00:00.000Z",
            });

            const browsed = await mem.browseHistory({ intent: "混合话题", hints: { chatId: chatA }, skipIntentLlm: true });
            assert.equal(browsed.segments.length, 1);
            assert.deepEqual(browsed.segments[0].messages.map(m => m.messageId), ["ok_1"]);

            const chatQuoted = await resolveQuoteRefs(
                [{ kind: "chat", raw: `@${chatA}`, chatId: chatA, source: "test" }],
                { memory: mem, boundChatId: chatA },
            );
            assert.ok(chatQuoted.items[0].content.includes("正常文本_OK_TO_READ"));
            assert.ok(!chatQuoted.items[0].content.includes("绝密拦截文本_NEVER_LEAK"));

            const rangeQuoted = await resolveQuoteRefs(
                [{ kind: "chat_range", raw: `@${chatA}[blk_1-ok_1]`, chatId: chatA, startMessageId: "blk_1", endMessageId: "ok_1", source: "test" }],
                { memory: mem, boundChatId: chatA },
            );
            assert.ok(!rangeQuoted.items[0].content.includes("绝密拦截文本_NEVER_LEAK"));

            // 5. EXPLAIN QUERY PLAN verifies idx_message_log_history_time range seek + pre-epoch pagination
            const plan = (mem as any).db.prepare(`
                EXPLAIN QUERY PLAN
                SELECT message_id
                FROM message_log
                WHERE chat_id = ?
                  AND access_control_blocked = 0
                  AND CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000) AS INTEGER) >= ?
                  AND (
                    CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000) AS INTEGER) > ?
                    OR (
                        CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000) AS INTEGER) = ?
                        AND message_id COLLATE BINARY > ?
                    )
                  )
                ORDER BY
                    CAST(ROUND(unixepoch(timestamp, 'subsec') * 1000) AS INTEGER) ASC,
                    message_id COLLATE BINARY ASC
                LIMIT ?
            `).all(chatA, 1000, 1000, 1000, "m1", 500) as Array<{ detail: string }>;
            assert.ok(plan.some(row => row.detail.includes("idx_message_log_history_time") && row.detail.includes("<expr>>?")));

            const preEpochChat = "onebot:group:9199";
            mem.storeMessageBatch([
                { messageId: "pre_1", chatId: preEpochChat, userId: "onebot:u1", displayName: "Old", text: "pre-epoch 1", timestamp: "1969-12-31T23:59:58.000Z" },
                { messageId: "pre_2", chatId: preEpochChat, userId: "onebot:u1", displayName: "Old", text: "pre-epoch 2", timestamp: "1969-12-31T23:59:59.000Z" },
            ]);
            const page1 = mem.listEligibleHistoryMessagePage(preEpochChat, null, 1);
            assert.equal(page1.length, 1);
            assert.equal(page1[0].messageId, "pre_1");
            const page2 = mem.listEligibleHistoryMessagePage(preEpochChat, { timestampMs: page1[0].timestampMs, messageId: page1[0].messageId }, 10);
            assert.equal(page2.length, 1);
            assert.equal(page2[0].messageId, "pre_2");
        } finally {
            cleanupTestMemory(mem, "hist-remediation-a");
        }
    });

    it("10. dry-run leaves unmigrated pre-history DB untouched, previews --input --max-windows on fresh DB, and verifies Docker tsx shim launcher", async () => {
        const dir = makeTempDir("hist-dryrun-ro-");
        try {
            // Create an unmigrated pre-history SQLite DB (only minimal legacy message_log + topics without history_key)
            const Database = (await import("better-sqlite3")).default;
            const legacyDbPath = path.join(dir, "legacy-prehistory.db");
            const legacyDb = new Database(legacyDbPath);
            legacyDb.exec(`
                CREATE TABLE message_log (
                    message_id TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    PRIMARY KEY (chat_id, message_id)
                );
                CREATE TABLE topics (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    label TEXT NOT NULL
                );
                INSERT INTO message_log (message_id, chat_id, user_id, display_name, text, timestamp)
                VALUES ('lm1', 'onebot:group:30001', 'onebot:1', 'Alice', 'legacy msg', '2025-01-01T00:00:00.000Z');
            `);
            legacyDb.close();

            const beforeBytes = fs.readFileSync(legacyDbPath);
            const beforeMtime = fs.statSync(legacyDbPath).mtimeMs;

            const dryLegacy = await runHistoryInitialization({
                chatId: "onebot:group:30001",
                stage: "all",
                dryRun: true,
                qceOptions: { dbPath: legacyDbPath },
                config: makeTestConfig(),
            });
            assert.equal(dryLegacy.dryRun, true);
            assert.equal(dryLegacy.eligibleMessages, 1);
            assert.equal(dryLegacy.selectedWindows, 1);
            assert.equal(dryLegacy.estimatedClusterCalls, 2);

            const afterBytes = fs.readFileSync(legacyDbPath);
            const afterMtime = fs.statSync(legacyDbPath).mtimeMs;
            assert.equal(Buffer.compare(beforeBytes, afterBytes), 0, "Legacy DB bytes must remain untouched");
            assert.equal(afterMtime, beforeMtime);
            assert.equal(fs.existsSync(legacyDbPath + "-wal"), false);

            // Fresh DB --stage all --input --dry-run --max-windows 1 computes capped windows/calls without creating DB
            const freshDbPath = path.join(dir, "fresh-init-dry.db");
            const qceInput = path.join(dir, "qce-init-dry.json");
            fs.writeFileSync(qceInput, JSON.stringify({
                chatInfo: { name: "Preview Group", type: "group", peerUid: "30002" },
                messages: [
                    { id: "p1", type: "type_1", timestamp: 1714521600, sender: { uin: "101", nickname: "A" }, content: { text: "win1" } },
                    { id: "p2", type: "type_1", timestamp: 1714528800, sender: { uin: "102", nickname: "B" }, content: { text: "win2" } },
                ],
            }), "utf8");

            const freshDry = await runHistoryInitialization({
                inputPath: qceInput,
                stage: "all",
                maxWindows: 1,
                minWindowMessages: 0,
                dryRun: true,
                qceOptions: { dbPath: freshDbPath, timezone: "UTC" },
                config: makeTestConfig(),
            });
            assert.equal(fs.existsSync(freshDbPath), false);
            assert.equal(freshDry.totalWindows, 2);
            assert.equal(freshDry.selectedWindows, 2);
            assert.equal(freshDry.estimatedClusterCalls, 2, "Capped by maxWindows=1 (1 * 2 = 2)");
            assert.equal(freshDry.remainingClusterUnits, 1);

            // Exact Docker launcher command: /workspace/CyberGroupmate/node_modules/.bin/tsx src/cli.ts ...
            const tsxBin = path.resolve("node_modules/.bin/tsx");
            const cliEntry = path.resolve("src/cli.ts");
            const dockerLike = spawnSync(
                tsxBin,
                [cliEntry, "history", "import", qceInput, "--dry-run", "--db", path.join(dir, "never.db")],
                { encoding: "utf8" },
            );
            assert.equal(dockerLike.status, 0, dockerLike.stderr);
            const parsedDocker = JSON.parse(dockerLike.stdout.slice(dockerLike.stdout.indexOf("{")));
            assert.equal(parsedDocker.chatId, "onebot:group:30002");
        } finally {
            rmDirSafe(dir);
        }
    });

    it("11. enforces point-of-use private LLM guard on in-flight markChatSensitive and platform DM patterns", async () => {
        const mem = createTestMemory("hist-point-of-use-privacy");
        const chatId = "onebot:group:40001";
        try {
            seedMessages(mem, chatId, [
                { id: "m1", userId: "onebot:101", name: "Alice", text: "first msg", ts: "2025-05-01T10:00:00.000Z" },
                { id: "m2", userId: "onebot:102", name: "Bob", text: "second msg", ts: "2025-05-01T14:00:00.000Z" },
            ]);

            // Platform DM patterns blocked before LLM calls
            for (const dmChat of ["telegram:123456", "discord:user789", "discord:dm:user789", "feishu:p2p:ou_abc"]) {
                await assert.rejects(
                    runHistoryInitializationWithMemory(mem, {
                        chatId: dmChat,
                        stage: "cluster",
                        config: makeTestConfig(),
                        llmCall: async () => { throw new Error("should not call"); },
                    }),
                    /--allow-private-llm/,
                );
            }

            // In-flight markChatSensitive during first cluster call pauses BEFORE second outbound LLM call!
            let llmCount = 0;
            await assert.rejects(
                runHistoryInitializationWithMemory(mem, {
                    chatId,
                    stage: "cluster",
                    config: makeTestConfig(),
                    llmCall: async (opts) => {
                        llmCount++;
                        if (llmCount === 1) {
                            mem.markChatSensitive(chatId, "mid-run sensitive mark");
                            return { content: JSON.stringify({ topics: [{ tempId: "t1", label: "T1", messageIds: ["m1"] }] }) };
                        }
                        return { content: "{}" };
                    },
                }),
                /--allow-private-llm/,
            );
            assert.equal(llmCount, 1, "Summary/second call must be blocked immediately after markChatSensitive");
            assert.equal(mem.findLatestHistoryJob("initialize", chatId)?.status, "paused");

            // Even if markChatSensitive happens during an already-dispatched synthesis call (with --allow-private-llm),
            // commitHistoricalSynthesisUnit re-reads live group_models and forces visibility='private'!
            const lease = mem.acquireHistoryLease(chatId);
            const job = mem.findLatestHistoryJob("initialize", chatId)!;
            mem.upsertHistoryUnits(job.jobId, "cluster", [{ unitKey: "c1", ordinal: 0, inputJson: "{}" }], lease.ownerToken);
            const cRes = mem.commitHistoricalClusterUnit({
                jobId: job.jobId,
                ownerToken: lease.ownerToken,
                chatId,
                unitKey: "c1",
                expectedMessageIds: ["m1"],
                expectedDigest: computeMessagesDigest(toDigestFields(loadEligibleHistoryMessages(mem, chatId).slice(0, 1))),
                topics: [{
                    historyKey: "hist_topic:priv",
                    label: "PrivTopic",
                    summary: "sum",
                    keyPoints: [],
                    participants: ["onebot:101"],
                    keywords: ["k"],
                    messageIds: ["m1"],
                    startedAt: "2025-05-01T10:00:00.000Z",
                    endedAt: "2025-05-01T10:00:00.000Z",
                    sentiment: "neutral",
                }],
                coveredPairs: [{ messageId: "m1", topicHistoryKey: "hist_topic:priv" }],
                outputJson: "{}",
            });
            mem.upsertHistoryUnits(job.jobId, "synthesize", [{ unitKey: "s1", ordinal: 0, inputJson: "{}" }], lease.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: job.jobId,
                ownerToken: lease.ownerToken,
                chatId,
                unitKey: "s1",
                rankKey: "2025-W18#0000",
                groupPatch: {},
                memberPatches: [],
                factProposals: [{
                    historyKey: "hist_obs:priv",
                    subject: `group:${chatId}`,
                    content: "private observation",
                    category: "general",
                    sourceTopicId: cRes.topicIds[0],
                    sourceMessageIds: ["m1"],
                    observedAt: "2025-05-01T10:00:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false, // stale false passed by caller; live DB has marked_sensitive=1!
            });
            mem.releaseHistoryLease(chatId, lease.ownerToken);

            const fact = mem.listCoreFacts({ sourceChatId: chatId, includeAllHistory: true }).items[0];
            assert.equal(fact.visibility, "private");
        } finally {
            cleanupTestMemory(mem, "hist-point-of-use-privacy");
        }
    });

    it("12. rejects wrong-speaker citations, partial-bad ID arrays, uncited groupUpdates, stale commits, and enforces storage boundaries & live clears", async () => {
        const mem = createTestMemory("hist-grounding-strict");
        const chatId = "onebot:group:40002";
        try {
            seedMessages(mem, chatId, [
                { id: "m1", userId: "onebot:111", name: "Alice", text: "我喜欢写 Rust", ts: "2025-05-02T10:00:00.000Z" },
                { id: "m2", userId: "onebot:222", name: "Bob", text: "Alice 真是现充哈哈哈", ts: "2025-05-02T10:01:00.000Z" },
            ]);

            const lease = mem.acquireHistoryLease(chatId);
            const job = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "g1", optionsJson: "{}", status: "running" }, lease.ownerToken);
            const msgs = loadEligibleHistoryMessages(mem, chatId);
            const [win] = buildHistoryWindows(msgs);
            mem.upsertHistoryUnits(job.jobId, "cluster", [{ unitKey: win.unitKey, ordinal: 0, inputJson: "{}" }], lease.ownerToken);
            const cRes = mem.commitHistoricalClusterUnit({
                jobId: job.jobId,
                ownerToken: lease.ownerToken,
                chatId,
                unitKey: win.unitKey,
                expectedMessageIds: win.messageIds,
                expectedDigest: win.inputDigest,
                topics: [{
                    historyKey: "hist_topic:strict",
                    label: "Rust",
                    summary: "聊Rust",
                    keyPoints: ["Rust"],
                    participants: ["onebot:111", "onebot:222"],
                    keywords: ["Rust"],
                    messageIds: ["m1", "m2"],
                    startedAt: "2025-05-02T10:00:00.000Z",
                    endedAt: "2025-05-02T10:01:00.000Z",
                    sentiment: "positive",
                }],
                coveredPairs: [
                    { messageId: "m1", topicHistoryKey: "hist_topic:strict" },
                    { messageId: "m2", topicHistoryKey: "hist_topic:strict" },
                ],
                outputJson: "{}",
            });
            const topicId = cRes.topicIds[0];

            // Storage boundary rejects biographical, person-subject, and stale cited message
            mem.upsertHistoryUnits(job.jobId, "synthesize", [{ unitKey: "bad-sb", ordinal: 0, inputJson: "{}" }], lease.ownerToken);
            assert.throws(() => {
                mem.commitHistoricalSynthesisUnit({
                    jobId: job.jobId,
                    ownerToken: lease.ownerToken,
                    chatId,
                    unitKey: "bad-sb",
                    rankKey: "2025-W18#0000",
                    memberPatches: [],
                    factProposals: [{
                        historyKey: "k1",
                        subject: `group:${chatId}`,
                        content: "bio",
                        category: "biographical",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1"],
                        observedAt: "2025-05-02T10:00:00.000Z",
                    }],
                    outputJson: "{}",
                    isPrivateOrSensitive: false,
                });
            }, /disallowed at storage boundary/i);

            assert.throws(() => {
                mem.commitHistoricalSynthesisUnit({
                    jobId: job.jobId,
                    ownerToken: lease.ownerToken,
                    chatId,
                    unitKey: "bad-sb",
                    rankKey: "2025-W18#0000",
                    memberPatches: [],
                    factProposals: [{
                        historyKey: "k2",
                        subject: "onebot:111",
                        content: "person",
                        category: "general",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1"],
                        observedAt: "2025-05-02T10:00:00.000Z",
                    }],
                    outputJson: "{}",
                    isPrivateOrSensitive: false,
                });
            }, /disallowed at storage boundary/i);

            // Stale commit when cited message deleted/blocked at commit time throws HistoryUnitStaleError
            assert.throws(() => {
                mem.commitHistoricalSynthesisUnit({
                    jobId: job.jobId,
                    ownerToken: lease.ownerToken,
                    chatId,
                    unitKey: "bad-sb",
                    rankKey: "2025-W18#0000",
                    memberPatches: [],
                    factProposals: [{
                        historyKey: "k3",
                        subject: `group:${chatId}`,
                        content: "obs",
                        category: "general",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["deleted_msg"],
                        observedAt: "2025-05-02T10:00:00.000Z",
                    }],
                    outputJson: "{}",
                    isPrivateOrSensitive: false,
                });
            }, HistoryUnitStaleError);

            mem.releaseHistoryLease(chatId, lease.ownerToken);

            // Synthesis grounding checks:
            // - wrong-speaker trait (citing Bob's m2 for Alice) rejected
            // - partial invalid messageIds (["m1", "fake_id"]) rejects whole claim
            // - uncited groupUpdates rejected
            // - meme without usageBoundaries rejected
            // - banter/bot-relation under traits/groupObservations rejected
            let synthAttempt = 0;
            await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "synthesize",
                config: makeTestConfig(),
                llmCall: async () => {
                    synthAttempt++;
                    if (synthAttempt === 1) {
                        // Incomplete {} triggers schema repair!
                        return { content: "{}" };
                    }
                    return {
                        content: JSON.stringify({
                            groupUpdates: {
                                description: "Uncited description should be dropped",
                                agentRole: "Caller custom role ignored",
                            },
                            memberProfiles: [
                                {
                                    userId: "onebot:111",
                                    traits: [
                                        { value: "wrong speaker trait", topicId, messageIds: ["m2"] },
                                        { value: "partial bad id trait", topicId, messageIds: ["m1", "nonexistent_id"] },
                                        { value: "Alice是个现充", topicId, messageIds: ["m1"] },
                                        { value: "和Bot关系很好", topicId, messageIds: ["m1"] },
                                        { value: "热爱Rust", topicId, messageIds: ["m1"] },
                                    ],
                                    interests: [],
                                    episodes: [],
                                },
                            ],
                            memes: [
                                {
                                    canonicalKey: "missing-boundaries",
                                    term: "缺边界梗",
                                    meaning: "有含义但缺边界",
                                    topicId,
                                    messageIds: ["m2"],
                                },
                            ],
                            groupObservations: [
                                {
                                    canonicalKey: "bad-obs-bio",
                                    content: "Alice今年25岁在腾讯上班",
                                    topicId,
                                    messageIds: ["m1"],
                                },
                                {
                                    canonicalKey: "bad-obs-bot",
                                    content: "群友和AI助手很熟经常聊私事",
                                    topicId,
                                    messageIds: ["m1"],
                                },
                            ],
                        }),
                    };
                },
            });

            assert.equal(synthAttempt, 2, "Incomplete {} must trigger 1-shot schema repair");
            const gmAfter = mem.getGroupModel(chatId)!;
            assert.equal(gmAfter.description, "", "Uncited groupUpdates.description must be rejected");
            assert.equal(gmAfter.agentRole, NEWCOMER_AGENT_ROLE);

            const aliceAfter = mem.getProfilesForChat(chatId).find(p => p.userId === "onebot:111")!;
            assert.deepEqual(aliceAfter.traits, ["热爱Rust"]);
            assert.equal(mem.listCoreFacts({ sourceChatId: chatId, includeAllHistory: true }).items.length, 0);

            // Concurrent live clear (description="", traits=[]) survives subsequent offline commit!
            mem.upsertGroupModel(chatId, { description: "Seeded" });
            const l2 = mem.acquireHistoryLease(chatId);
            const j2 = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "clear-guard", optionsJson: "{}", status: "running" }, l2.ownerToken);
            mem.upsertHistoryUnits(j2.jobId, "synthesize", [{ unitKey: "cg1", ordinal: 0, inputJson: "{}" }, { unitKey: "cg2", ordinal: 1, inputJson: "{}" }], l2.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: j2.jobId,
                ownerToken: l2.ownerToken,
                chatId,
                unitKey: "cg1",
                rankKey: "2025-W18#0001",
                groupPatch: { description: "First offline desc" },
                memberPatches: [{ userId: "onebot:222", traits: ["Seeded trait"] }],
                factProposals: [],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            // Operator clears description and Bob's traits to empty!
            mem.upsertGroupModel(chatId, { description: "" });
            mem.upsertPersonGroupProfile("onebot:222", chatId, { traits: [] });

            // Resumed/later offline unit attempts to write over cleared fields: must NOT resurrect cleared values!
            mem.commitHistoricalSynthesisUnit({
                jobId: j2.jobId,
                ownerToken: l2.ownerToken,
                chatId,
                unitKey: "cg2",
                rankKey: "2025-W19#0000",
                groupPatch: { description: "Resurrected desc" },
                memberPatches: [{ userId: "onebot:222", traits: ["Resurrected trait"] }],
                factProposals: [],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(chatId, l2.ownerToken);

            // Seeded fields stay cleared (Wait: note description was "Seeded" before cg1 so cg1 didn't seed it,
            // wait: Bob's traits WAS seeded by cg1 then cleared, so cg2 must NOT resurrect Bob's traits!).
            const bobAfterClear = mem.getProfilesForChat(chatId).find(p => p.userId === "onebot:222")!;
            assert.deepEqual(bobAfterClear.traits, [], "Cleared seeded traits must not be resurrected");
        } finally {
            cleanupTestMemory(mem, "hist-grounding-strict");
        }
    });

    it("13. handles lease heartbeat expiry abort, atomic embeddings + stale invalidation, 429 Retry-After, single-topic chunking, and CLI exit codes", async () => {
        const mem = createTestMemory("hist-lease-embed-429");
        const chatId = "onebot:group:40003";
        const dir = makeTempDir("hist-cli-exit-");
        try {
            seedMessages(mem, chatId, [
                { id: "e1", userId: "onebot:1", name: "A", text: "alpha message", ts: "2025-06-01T10:00:00.000Z" },
                { id: "e2", userId: "onebot:2", name: "B", text: "beta message", ts: "2025-06-01T10:05:00.000Z" },
            ]);

            // 1. Lease expiry during long awaited LLM call aborts cleanly via heartbeat
            let seenAborted = false;
            await assert.rejects(
                runHistoryInitializationWithMemory(mem, {
                    chatId,
                    stage: "cluster",
                    leaseTtlMs: 120,
                    config: makeTestConfig(),
                    llmCall: async (opts) => {
                        // Force lease theft/expiry in DB while LLM call is pending
                        (mem as any).db.prepare("DELETE FROM history_leases WHERE chat_id = ?").run(chatId);
                        await new Promise<void>((resolve, reject) => {
                            opts.abortSignal?.addEventListener("abort", () => {
                                seenAborted = true;
                                reject(opts.abortSignal?.reason ?? new Error("aborted"));
                            }, { once: true });
                            setTimeout(resolve, 1000);
                        });
                        return { content: "{}" };
                    },
                }),
                HistoryLeaseError,
            );
            assert.equal(seenAborted, true, "Lease heartbeat failure must abort in-flight LLM request");

            // 2. 429 Retry-After backoff without splitting prompt + single oversized topic chunking
            const sleepDelays: number[] = [];
            let clusterCalls = 0;
            let summaryCalls = 0;
            const resOk = await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "all",
                config: makeTestConfig(),
                sleepFn: async (ms) => { sleepDelays.push(ms); },
                llmCall: async (opts) => {
                    if (opts.stage === "cluster") {
                        clusterCalls++;
                        if (clusterCalls === 1) {
                            const err = new Error("429 Too Many Requests") as Error & { status?: number; retryAfterMs?: number };
                            err.status = 429;
                            err.retryAfterMs = 1500;
                            throw err;
                        }
                        return {
                            content: JSON.stringify({
                                topics: [{ tempId: "t1", label: "BigTopic", messageIds: ["e1", "e2"] }],
                            }),
                        };
                    }
                    if (opts.stage === "summary") {
                        summaryCalls++;
                        if (summaryCalls === 1) {
                            // Oversized single topic triggers message chunking!
                            throw new Error("context_length_exceeded");
                        }
                        return {
                            content: JSON.stringify({
                                summaries: [{
                                    tempId: opts.messages[1].content.includes("t_1_a") ? "t_1_a" : "t_1_b",
                                    label: "BigTopic",
                                    summary: `chunk_${summaryCalls}`,
                                    keyPoints: [`kp_${summaryCalls}`],
                                    keywords: [`kw_${summaryCalls}`],
                                    sentiment: "neutral",
                                }],
                            }),
                        };
                    }
                    const topic = mem.getHistoricalTopicsForChat(chatId)[0];
                    return {
                        content: JSON.stringify({
                            groupUpdates: { evidence: [{ topicId: topic.id, messageIds: ["e1", "e2"] }] },
                            memberProfiles: [],
                            memes: [],
                            groupObservations: [{ canonicalKey: "obs-1", content: "群里爱聊 alpha", topicId: topic.id, messageIds: ["e1", "e2"] }],
                        }),
                    };
                },
            });
            assert.deepEqual(sleepDelays, [1500]);
            assert.equal(clusterCalls, 2, "RPM 429 must backoff without splitting");
            assert.equal(summaryCalls, 3, "Single oversized topic must split into 2 chunks");
            assert.equal(resOk.topicsCommitted, 1);
            assert.equal(resOk.factsCommitted, 1);

            // 3. Embedding failure pauses job (never falsely 'done'); retry commits atomically; fact content update invalidates stale embedding
            const embedCfg: AppConfig["embedding"] = {
                enabled: true,
                provider: "openai",
                baseUrl: "https://example.invalid/v1",
                apiKey: "k",
                model: "m",
                dimensions: 128,
                similarityMetric: "cosine",
            };
            await assert.rejects(
                runHistoryInitializationWithMemory(mem, {
                    chatId,
                    stage: "synthesize",
                    embed: true,
                    config: makeTestConfig({ embedding: embedCfg }),
                    llmCall: async () => { throw new Error("should not call llm"); },
                    embedFn: async () => { throw new Error("Embedding upstream 500"); },
                }),
                /Embedding upstream 500/,
            );
            assert.equal(mem.findLatestHistoryJob("initialize", chatId)?.status, "paused");

            const embedDone = await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "synthesize",
                embed: true,
                resume: true,
                config: makeTestConfig({ embedding: embedCfg }),
                llmCall: async () => { throw new Error("should not call llm"); },
                embedFn: async () => new Float32Array(128).fill(0.1),
            });
            assert.equal(embedDone.embeddedTopics, 1);
            assert.equal(embedDone.embeddedFacts, 1);
            assert.equal(mem.findLatestHistoryJob("initialize", chatId)?.status, "done");

            // Updating historical fact content invalidates stale embedding
            const factBefore = mem.listCoreFacts({ sourceChatId: chatId, includeAllHistory: true }).items[0];
            const topicBefore = mem.getHistoricalTopicsForChat(chatId)[0];
            assert.equal(mem.getUnembeddedHistoryTargets(chatId).facts.length, 0);
            const l3 = mem.acquireHistoryLease(chatId);
            const j3 = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "upd", optionsJson: "{}", status: "running" }, l3.ownerToken);
            mem.upsertHistoryUnits(j3.jobId, "synthesize", [{ unitKey: "u-upd", ordinal: 0, inputJson: "{}" }], l3.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: j3.jobId,
                ownerToken: l3.ownerToken,
                chatId,
                unitKey: "u-upd",
                rankKey: "2025-W23#0000",
                memberPatches: [],
                factProposals: [{
                    historyKey: factBefore.historyKey!,
                    subject: `group:${chatId}`,
                    content: "更新后的群观察内容",
                    category: "general",
                    sourceTopicId: topicBefore.id,
                    sourceMessageIds: ["e1"],
                    observedAt: "2025-06-01T10:00:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(chatId, l3.ownerToken);
            assert.equal(mem.getUnembeddedHistoryTargets(chatId).facts.length, 1, "Updated fact must have stale embedding cleared");

            // 4. CLI validation: --stage cluster --input ... without --chat-id exits 2; non-SIGINT error exits 1 (not 130)
            const tsxLoader = path.resolve("node_modules/tsx/dist/loader.mjs");
            const cliEntry = path.resolve("src/cli.ts");
            const dummyJson = path.join(dir, "d.json");
            fs.writeFileSync(dummyJson, "{}", "utf8");
            const badClusterCli = spawnSync(
                process.execPath,
                ["--import", tsxLoader, cliEntry, "history", "init", "--stage", "cluster", "--input", dummyJson],
                { cwd: dir, encoding: "utf8" },
            );
            assert.equal(badClusterCli.status, 2);

            const invalidTzCli = spawnSync(
                process.execPath,
                ["--import", tsxLoader, cliEntry, "history", "import", dummyJson, "--timezone", "+08:00"],
                { cwd: dir, encoding: "utf8" },
            );
            assert.equal(invalidTzCli.status, 2);
        } finally {
            cleanupTestMemory(mem, "hist-lease-embed-429");
            rmDirSafe(dir);
        }
    });

    it("15. Pass C regressions: recall chatId+authorizedChatId isolation, 0o555 WAL dry-run, beforeAttempt fallback/embed guard, and forward evidenceText across all 3 LLM stages", async () => {
        const dir = makeTempDir("hist-pass-c-");

        // ── 1. recall fact branches enforce BOTH chatId and authorizedChatId independently ──
        const recallDbPath = path.join(dir, "recall-isolation.db");
        const { MemoryStoreV2 } = await import("../src/memory-v2/memory-v2.js");
        const recallMem = new MemoryStoreV2(recallDbPath, {
            embeddingConfig: {
                enabled: true,
                provider: "local",
                baseUrl: "https://example.invalid/v1",
                apiKey: "",
                model: "local",
                dimensions: 128,
                similarityMetric: "cosine",
            },
        });
        const chatA = "onebot:group:51001";
        const chatB = "onebot:group:51002";
        try {
            seedMessages(recallMem, chatA, [
                { id: "ra1", userId: "onebot:101", name: "Alice", text: "量子星云 暗号讨论", ts: "2025-04-01T10:00:00.000Z" },
            ]);
            const lA = recallMem.acquireHistoryLease(chatA);
            const jA = recallMem.upsertHistoryJob({ kind: "initialize", chatId: chatA, inputKey: "ra", optionsJson: "{}", status: "running" }, lA.ownerToken);
            recallMem.upsertHistoryUnits(jA.jobId, "cluster", [{ unitKey: "ra-c1", ordinal: 0, inputJson: "{}" }], lA.ownerToken);
            const cRes = recallMem.commitHistoricalClusterUnit({
                jobId: jA.jobId,
                ownerToken: lA.ownerToken,
                chatId: chatA,
                unitKey: "ra-c1",
                expectedMessageIds: ["ra1"],
                expectedDigest: computeMessagesDigest([{
                    messageId: "ra1",
                    userId: "onebot:101",
                    timestamp: "2025-04-01T10:00:00.000Z",
                    text: "量子星云 暗号讨论",
                    replyToMessageId: null,
                    mentions: null,
                }]),
                topics: [{
                    historyKey: "hist_topic:ra1",
                    label: "量子星云",
                    summary: "量子星云讨论",
                    keyPoints: [],
                    participants: ["onebot:101"],
                    keywords: ["量子星云"],
                    messageIds: ["ra1"],
                    startedAt: "2025-04-01T10:00:00.000Z",
                    endedAt: "2025-04-01T10:00:00.000Z",
                    sentiment: "neutral",
                }],
                coveredPairs: [{ messageId: "ra1", topicHistoryKey: "hist_topic:ra1" }],
                outputJson: "{}",
            });
            recallMem.upsertHistoryUnits(jA.jobId, "synthesize", [{ unitKey: "ra-s1", ordinal: 0, inputJson: "{}" }], lA.ownerToken);
            recallMem.commitHistoricalSynthesisUnit({
                jobId: jA.jobId,
                ownerToken: lA.ownerToken,
                chatId: chatA,
                unitKey: "ra-s1",
                rankKey: "2025-W14#0000",
                memberPatches: [],
                factProposals: [{
                    historyKey: "hist_fact:ra1",
                    subject: `group:${chatA}`,
                    content: "量子星云 是 ChatA 的历史群梗",
                    category: "anecdote",
                    sourceTopicId: cRes.topicIds[0],
                    sourceMessageIds: ["ra1"],
                    observedAt: "2025-04-01T10:00:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            recallMem.releaseHistoryLease(chatA, lA.ownerToken);

            // Attach embedding to the historical fact so vector branch also has a candidate
            const histFact = recallMem.listCoreFacts({ sourceChatId: chatA, includeAllHistory: true }).items[0];
            recallMem.setFactEmbedding(histFact.id, localEmbed("量子星云 是 ChatA 的历史群梗"));

            // Also store a live ChatA fact with embedding
            recallMem.storeFact("onebot:101", "量子星云 也是 ChatA 实时事实", "general", "live", undefined, localEmbed("量子星云 也是 ChatA 实时事实"), 1, {
                sourceChatId: chatA,
            });

            // Vector + FTS5 recall requesting chatId: chatB with authorizedChatId: chatA -> MUST return 0 ChatA facts!
            const crossVecFts = await recallMem.recall("量子星云", {
                chatId: chatB,
                authorizedChatId: chatA,
                maxResults: 10,
            });
            assert.equal(crossVecFts.facts.length, 0, "Authorized ChatA facts must NOT leak when recall explicitly filters chatId: chatB");

            // Also test LIKE fallback branch (with FTS5-breaking syntax + no embedding config)
            const recallMemNoVec = new MemoryStoreV2(recallDbPath);
            try {
                const crossLike = await recallMemNoVec.recall("量子星云 (", {
                    chatId: chatB,
                    authorizedChatId: chatA,
                    maxResults: 10,
                });
                assert.equal(crossLike.facts.length, 0, "LIKE fallback must NOT return ChatA facts when chatId: chatB is requested");

                const ownFts = await recallMemNoVec.recall("量子星云", {
                    chatId: chatA,
                    authorizedChatId: chatA,
                    maxResults: 10,
                });
                assert.equal(ownFts.facts.length, 2, "Matching chatId=chatA & authorizedChatId=chatA returns both ChatA facts");
            } finally {
                recallMemNoVec.close();
            }
        } finally {
            recallMem.close();
        }

        // ── 2. Strict zero-write read-only open on closed WAL DB in 0o555 dir ──
        const roDir = path.join(dir, "ro-wal-dir");
        fs.mkdirSync(roDir, { recursive: true });
        const walDbPath = path.join(roDir, "closed-wal.db");
        {
            const seedMem = new MemoryStoreV2(walDbPath);
            seedMessages(seedMem, "onebot:group:52001", [
                { id: "w1", userId: "onebot:1", name: "U1", text: "wal ro test msg", ts: "2025-05-01T10:00:00.000Z" },
            ]);
            seedMem.close();
        }
        // Verify closed DB has no -wal or -shm files before chmod
        assert.deepEqual(fs.readdirSync(roDir).sort(), ["closed-wal.db"]);
        const qceIn = path.join(dir, "ro-qce.json");
        fs.writeFileSync(qceIn, JSON.stringify({
            chatInfo: { name: "RO Group", type: "group", uin: "52001" },
            messages: [
                { id: "w1", timestamp: 1746093600000, sender: { uin: "1", nickname: "U1" }, content: { text: "wal ro test msg" } },
                { id: "w2", timestamp: 1746097200000, sender: { uin: "2", nickname: "U2" }, content: { text: "new msg" } },
            ],
        }), "utf8");

        fs.chmodSync(roDir, 0o555);
        try {
            const dryQce = await dryRunQceImport(qceIn, walDbPath, { timezone: "UTC" });
            assert.equal(dryQce.dryRun, true);
            assert.equal(dryQce.duplicates, 1);
            assert.equal(dryQce.inserted, 1);

            const dryInit = await runHistoryInitialization({
                chatId: "onebot:group:52001",
                inputPath: qceIn,
                dryRun: true,
                config: makeTestConfig(),
                qceOptions: { dbPath: walDbPath, timezone: "UTC" },
            });
            assert.equal(dryInit.dryRun, true);
            assert.equal(dryInit.eligibleMessages, 2);

            const tsxLoader = path.resolve("node_modules/tsx/dist/loader.mjs");
            const cliEntry = path.resolve("src/cli.ts");
            const cliDry = spawnSync(
                process.execPath,
                ["--import", tsxLoader, cliEntry, "history", "init", "--input", qceIn, "--db", walDbPath, "--dry-run"],
                { cwd: dir, encoding: "utf8" },
            );
            assert.equal(cliDry.status, 0, cliDry.stderr);
            const cliParsed = JSON.parse(cliDry.stdout.slice(cliDry.stdout.indexOf("{")));
            assert.equal(cliParsed.dryRun, true);
            assert.deepEqual(fs.readdirSync(roDir).sort(), ["closed-wal.db"], "No -wal or -shm sidecar files may be created");

            // If an active non-empty -wal DOES exist in a 0o555 dir, fail loudly with actionable error
            fs.chmodSync(roDir, 0o755);
            const activeWalPath = `${walDbPath}-wal`;
            fs.writeFileSync(activeWalPath, Buffer.alloc(64, 1));
            fs.chmodSync(roDir, 0o555);
            assert.throws(
                () => openSqliteReadOnlyStrict(walDbPath),
                /active non-empty WAL/i,
            );
        } finally {
            fs.chmodSync(roDir, 0o755);
        }

        // ── 3. Point-of-use beforeAttempt guard on callLLMWithFallback & embed retry loop ──
        const memGuard = createTestMemory("hist-pass-c-guard");
        const chatGuardLlm = "onebot:group:53001";
        const chatGuardEmbed = "onebot:group:53002";
        const origFetch = globalThis.fetch;
        try {
            seedMessages(memGuard, chatGuardLlm, [
                { id: "g1", userId: "onebot:1", name: "Alice", text: "guard llm test", ts: "2025-05-01T10:00:00.000Z" },
            ]);

            let llmFetchCalls = 0;
            globalThis.fetch = (async () => {
                llmFetchCalls++;
                memGuard.markChatSensitive(chatGuardLlm, "marked during profile-1 attempt");
                return new Response(JSON.stringify({ error: { message: "429 rate limited" } }), {
                    status: 429,
                    headers: { "Content-Type": "application/json" },
                });
            }) as typeof fetch;

            const fallbackCfg = makeTestConfig({
                llmProfiles: {
                    p1: {
                        provider: "openai",
                        baseUrl: "https://p1.invalid/v1",
                        apiKey: "k1",
                        model: "m1",
                        temperature: 0.2,
                        maxTokens: 1024,
                    },
                    p2: {
                        provider: "openai",
                        baseUrl: "https://p2.invalid/v1",
                        apiKey: "k2",
                        model: "m2",
                        temperature: 0.2,
                        maxTokens: 1024,
                    },
                },
                llmRouting: {
                    recording_cluster: ["p1", "p2"],
                    recording_triage: ["p1", "p2"],
                    reflection: ["p1", "p2"],
                },
            });

            await assert.rejects(
                runHistoryInitializationWithMemory(memGuard, {
                    chatId: chatGuardLlm,
                    stage: "cluster",
                    config: fallbackCfg,
                    sleepFn: async () => undefined,
                }),
                /--allow-private-llm/,
            );
            assert.equal(llmFetchCalls, 1, "Fallback profile p2 MUST NOT fire after markChatSensitive");

            // Now test embed HTTP retry guard
            seedMessages(memGuard, chatGuardEmbed, [
                { id: "ge1", userId: "onebot:1", name: "Alice", text: "guard embed test", ts: "2025-05-01T10:00:00.000Z" },
            ]);
            const lE = memGuard.acquireHistoryLease(chatGuardEmbed);
            const jE = memGuard.upsertHistoryJob({ kind: "initialize", chatId: chatGuardEmbed, inputKey: "ge", optionsJson: "{}", status: "running" }, lE.ownerToken);
            memGuard.upsertHistoryUnits(jE.jobId, "cluster", [{ unitKey: "ge-c1", ordinal: 0, inputJson: "{}" }], lE.ownerToken);
            memGuard.commitHistoricalClusterUnit({
                jobId: jE.jobId,
                ownerToken: lE.ownerToken,
                chatId: chatGuardEmbed,
                unitKey: "ge-c1",
                expectedMessageIds: ["ge1"],
                expectedDigest: computeMessagesDigest([{
                    messageId: "ge1",
                    userId: "onebot:1",
                    timestamp: "2025-05-01T10:00:00.000Z",
                    text: "guard embed test",
                    replyToMessageId: null,
                    mentions: null,
                }]),
                topics: [{
                    historyKey: "hist_topic:ge1",
                    label: "Embed Guard Topic",
                    summary: "summary",
                    keyPoints: [],
                    participants: ["onebot:1"],
                    keywords: [],
                    messageIds: ["ge1"],
                    startedAt: "2025-05-01T10:00:00.000Z",
                    endedAt: "2025-05-01T10:00:00.000Z",
                    sentiment: "neutral",
                }],
                coveredPairs: [{ messageId: "ge1", topicHistoryKey: "hist_topic:ge1" }],
                outputJson: "{}",
            });
            memGuard.releaseHistoryLease(chatGuardEmbed, lE.ownerToken);

            let embedFetchCalls = 0;
            globalThis.fetch = (async () => {
                embedFetchCalls++;
                memGuard.markChatSensitive(chatGuardEmbed, "marked during embed attempt 1");
                return new Response("upstream unavailable", { status: 503 });
            }) as typeof fetch;

            const embedGuardCfg = makeTestConfig({
                embedding: {
                    enabled: true,
                    provider: "openai",
                    baseUrl: "https://embed.invalid/v1",
                    apiKey: "ek",
                    model: "text-embedding-3-small",
                    dimensions: 128,
                    similarityMetric: "cosine",
                },
            });

            await assert.rejects(
                runHistoryInitializationWithMemory(memGuard, {
                    chatId: chatGuardEmbed,
                    stage: "synthesize",
                    embed: true,
                    config: embedGuardCfg,
                    llmCall: async () => ({
                        content: JSON.stringify({
                            groupUpdates: { evidence: [] },
                            memberProfiles: [],
                            memes: [],
                            groupObservations: [],
                        }),
                    }),
                    sleepFn: async () => undefined,
                }),
                /--allow-private-llm/,
            );
            assert.equal(embedFetchCalls, 1, "Embedding HTTP retry #2 MUST NOT fire after markChatSensitive");
        } finally {
            globalThis.fetch = origFetch;
            cleanupTestMemory(memGuard, "hist-pass-c-guard");
        }

        // ── 4. Bulletproof forward exclusion across clustering, topic summary, and synthesis prompts ──
        const memFwd = createTestMemory("hist-pass-c-fwd");
        try {
            const fwdJsonPath = path.join(dir, "forward-4level.json");
            fs.writeFileSync(fwdJsonPath, JSON.stringify({
                chatInfo: { name: "Fwd Group", type: "group", uin: "54001" },
                messages: [
                    {
                        id: "f1",
                        timestamp: 1746093600000,
                        sender: { uin: "1001", nickname: "Alice" },
                        content: {
                            elements: [
                                { type: "text", text: "TopLevelDirectEvidence " },
                                {
                                    type: "forward",
                                    messages: [
                                        {
                                            sender: { nickname: "L1Sender" },
                                            content: {
                                                elements: [
                                                    { type: "text", text: "R1_RAW_PAREN_SECRET ) ] still_secret\n第二行绝密转发正文" },
                                                    {
                                                        type: "forward",
                                                        messages: [{
                                                            sender: { nickname: "L2Sender" },
                                                            content: {
                                                                elements: [{
                                                                    type: "forward",
                                                                    messages: [{
                                                                        sender: { nickname: "L3Sender" },
                                                                        content: {
                                                                            elements: [{
                                                                                type: "forward",
                                                                                messages: [{
                                                                                    sender: { nickname: "L4SecretSender" },
                                                                                    content: { text: "L4_SECRET_BODY_NEVER_LEAK\n第二行绝密转发正文" },
                                                                                }],
                                                                            }],
                                                                        },
                                                                    }],
                                                                }],
                                                            },
                                                        }],
                                                    },
                                                ],
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                    {
                        id: "f2",
                        timestamp: 1746093660000,
                        sender: { uin: "1002", nickname: "Bob" },
                        content: { text: "LegacyPrefix [转发聊天记录: 2条] (LegacyF1: :) ] LEGACY_UNBALANCED_SECRET)\n第二行绝密转发正文" },
                    },
                    {
                        id: "f3",
                        timestamp: 1746093720000,
                        sender: { uin: "1003", nickname: "Carol" },
                        content: { text: "FlatQcePrefix [转发消息: 1条] (CarolF: line1)\n第二行绝密转发正文" },
                    },
                ],
            }), "utf8");

            const chatFwd = "onebot:group:54001";
            await importQce(memFwd, fwdJsonPath, { timezone: "UTC" });

            // Verify qceMeta.evidenceText on imported f1 and f3 never contains multi-line forwarded body
            const f1MetaRow = (memFwd as any).db.prepare("SELECT qce_meta FROM message_log WHERE chat_id = ? AND message_id = 'f1'").get(chatFwd) as { qce_meta: string | null };
            const f3MetaRow = (memFwd as any).db.prepare("SELECT qce_meta FROM message_log WHERE chat_id = ? AND message_id = 'f3'").get(chatFwd) as { qce_meta: string | null };
            const f1Evidence = JSON.parse(f1MetaRow.qce_meta ?? "{}").evidenceText as string;
            const f3Evidence = JSON.parse(f3MetaRow.qce_meta ?? "{}").evidenceText as string;
            assert.equal(f1Evidence, "TopLevelDirectEvidence [转发聊天记录]");
            assert.equal(f1Evidence.includes("第二行绝密转发正文"), false);
            assert.equal(f3Evidence, "FlatQcePrefix [转发聊天记录]");

            // Simulate a legacy row without evidenceText for f2 (clear qce_meta)
            (memFwd as any).db.prepare("UPDATE message_log SET qce_meta = NULL WHERE chat_id = ? AND message_id = 'f2'").run(chatFwd);

            const promptsByStage: Record<string, string[]> = { cluster: [], summary: [], synthesis: [] };
            const captureLlm: HistoryLlmCallFn = async (opts) => {
                const promptBlob = opts.messages.map(m => m.content).join("\n");
                if (promptsByStage[opts.stage]) {
                    promptsByStage[opts.stage].push(promptBlob);
                }
                if (opts.stage === "cluster") {
                    return {
                        content: JSON.stringify({
                            topics: [{ tempId: "t1", label: "转发安全测试", messageIds: ["f1", "f2", "f3"] }],
                        }),
                    };
                }
                if (opts.stage === "summary") {
                    return {
                        content: JSON.stringify({
                            summaries: [{
                                tempId: "t_1",
                                label: "转发安全测试",
                                summary: "讨论 [转发聊天记录]",
                                keyPoints: ["测试"],
                                keywords: ["转发"],
                                sentiment: "neutral",
                            }],
                        }),
                    };
                }
                return {
                    content: JSON.stringify({
                        groupUpdates: { evidence: [] },
                        memberProfiles: [],
                        memes: [],
                        groupObservations: [],
                    }),
                };
            };

            await runHistoryInitializationWithMemory(memFwd, {
                chatId: chatFwd,
                stage: "all",
                config: makeTestConfig(),
                llmCall: captureLlm,
            });

            for (const stageName of ["cluster", "summary", "synthesis"] as const) {
                assert.ok(promptsByStage[stageName].length >= 1, `Expected prompt captured for ${stageName}`);
                const combined = promptsByStage[stageName].join("\n");
                assert.ok(combined.includes("TopLevelDirectEvidence"), `${stageName} must retain non-forward top-level text`);
                assert.ok(combined.includes("LegacyPrefix [转发聊天记录]"), `${stageName} must strip legacy unbalanced forward cleanly`);
                assert.ok(combined.includes("FlatQcePrefix [转发聊天记录]"), `${stageName} must strip flattened QCE forward cleanly`);
                for (const forbidden of [
                    "R1_RAW_PAREN_SECRET",
                    "still_secret",
                    "L1Sender",
                    "L4SecretSender",
                    "L4_SECRET_BODY_NEVER_LEAK",
                    "LEGACY_UNBALANCED_SECRET",
                    "第二行绝密转发正文",
                ]) {
                    assert.equal(combined.includes(forbidden), false, `${stageName} leaked forwarded text "${forbidden}"`);
                }
            }
        } finally {
            cleanupTestMemory(memFwd, "hist-pass-c-fwd");
        }

        rmDirSafe(dir);
    });

    it("16. enforces meme term attestation, rejects placeholder fields, injects already-recorded context sequentially & on split-retry, and dedupes paraphrases with caps", async () => {
        // Bigram attestation check on paraphrased-but-attested 4+ char meme term
        assert.equal(
            attestMemeTerm("仙人掌扎老板的手", ["把这盆仙人掌搬进办公室，每天浇水零次，只为扎老板的手"]),
            "仙人掌扎老板的手",
        );
        assert.equal(
            attestMemeTerm("现充/闲虫", ["@Dave 早上好"]),
            null,
        );

        const mem = createTestMemory("hist-synth-quality-guards");
        const chatId = "onebot:group:60001";
        const foreignChatId = "onebot:group:60002";
        try {
            // Seed a foreign chat historical fact to verify same-chat scoping in already-recorded prompt
            seedMessages(mem, foreignChatId, [
                { id: "fm1", userId: "onebot:999", name: "Foreign", text: "跨群秘密暗号", ts: "2025-01-01T10:00:00.000Z" },
            ]);
            const fl = mem.acquireHistoryLease(foreignChatId);
            const fj = mem.upsertHistoryJob({ kind: "initialize", chatId: foreignChatId, inputKey: "f", optionsJson: "{}", status: "running" }, fl.ownerToken);
            mem.upsertHistoryUnits(fj.jobId, "cluster", [{ unitKey: "fc1", ordinal: 0, inputJson: "{}" }], fl.ownerToken);
            const fcRes = mem.commitHistoricalClusterUnit({
                jobId: fj.jobId,
                ownerToken: fl.ownerToken,
                chatId: foreignChatId,
                unitKey: "fc1",
                expectedMessageIds: ["fm1"],
                expectedDigest: computeMessagesDigest(toDigestFields(loadEligibleHistoryMessages(mem, foreignChatId))),
                topics: [{
                    historyKey: "hist_topic:foreign",
                    label: "跨群",
                    summary: "跨群",
                    keyPoints: [],
                    participants: ["onebot:999"],
                    keywords: [],
                    messageIds: ["fm1"],
                    startedAt: "2025-01-01T10:00:00.000Z",
                    endedAt: "2025-01-01T10:00:00.000Z",
                    sentiment: "neutral",
                }],
                coveredPairs: [{ messageId: "fm1", topicHistoryKey: "hist_topic:foreign" }],
                outputJson: "{}",
            });
            mem.upsertHistoryUnits(fj.jobId, "synthesize", [{ unitKey: "fs1", ordinal: 0, inputJson: "{}" }], fl.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: fj.jobId,
                ownerToken: fl.ownerToken,
                chatId: foreignChatId,
                unitKey: "fs1",
                rankKey: "2025-W01#0000",
                memberPatches: [],
                factProposals: [{
                    historyKey: "hist_meme:foreign",
                    subject: `group:${foreignChatId}`,
                    content: "[群梗: 跨群秘密暗号]；真实含义: 跨群；使用边界: 仅限外群",
                    category: "anecdote",
                    sourceTopicId: fcRes.topicIds[0],
                    sourceMessageIds: ["fm1"],
                    observedAt: "2025-01-01T10:00:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(foreignChatId, fl.ownerToken);

            // Seed Week 1 (unit 1) and Week 2 (unit 2, with 2 topics so split-retry exercises mergeSynthesisOutputs)
            seedMessages(mem, chatId, [
                { id: "w1_m1", userId: "onebot:101", name: "Dave", text: "今天好累啊，把这盆仙人掌搬进办公室，每天浇水零次，只为扎老板的手", ts: "2025-01-06T10:00:00.000Z" },
                { id: "w1_m2", userId: "onebot:102", name: "Bob", text: "哈哈哈哈接龙刷起来，我也来扎老板的手", ts: "2025-01-06T10:02:00.000Z" },
                { id: "w2_m1", userId: "onebot:101", name: "Dave", text: "继续发图斗图", ts: "2025-01-13T10:00:00.000Z" },
                { id: "w2_m1b", userId: "onebot:104", name: "Dave", text: "斗图刷屏了", ts: "2025-01-13T10:01:00.000Z" },
                { id: "w2_m2", userId: "onebot:103", name: "Carol", text: "Bob真是闲虫啊", ts: "2025-01-13T14:00:00.000Z" },
                { id: "w2_m3", userId: "onebot:102", name: "Bob", text: "别叫我闲虫了，晚上开黑", ts: "2025-01-13T14:01:00.000Z" },
            ]);

            const lease = mem.acquireHistoryLease(chatId);
            const job = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "synth-q", optionsJson: "{}", status: "running" }, lease.ownerToken);
            mem.upsertHistoryUnits(job.jobId, "cluster", [
                { unitKey: "c_w1", ordinal: 0, inputJson: "{}" },
                { unitKey: "c_w2_a", ordinal: 1, inputJson: "{}" },
                { unitKey: "c_w2_b", ordinal: 2, inputJson: "{}" },
            ], lease.ownerToken);

            const eligibleAll = loadEligibleHistoryMessages(mem, chatId);
            const commitTopic = (unitKey: string, hKey: string, label: string, msgs: typeof eligibleAll) =>
                mem.commitHistoricalClusterUnit({
                    jobId: job.jobId,
                    ownerToken: lease.ownerToken,
                    chatId,
                    unitKey,
                    expectedMessageIds: msgs.map(m => m.messageId),
                    expectedDigest: computeMessagesDigest(toDigestFields(msgs)),
                    topics: [{
                        historyKey: hKey,
                        label,
                        summary: label,
                        keyPoints: [label],
                        participants: [...new Set(msgs.map(m => m.userId))],
                        keywords: [label],
                        messageIds: msgs.map(m => m.messageId),
                        startedAt: msgs[0].timestamp,
                        endedAt: msgs[msgs.length - 1].timestamp,
                        sentiment: "neutral",
                    }],
                    coveredPairs: msgs.map(m => ({ messageId: m.messageId, topicHistoryKey: hKey })),
                    outputJson: "{}",
                }).topicIds[0];

            const tW1 = commitTopic("c_w1", "ht:w1", "W1话题", eligibleAll.slice(0, 2));
            const tW2a = commitTopic("c_w2_a", "ht:w2a", "W2话题A", eligibleAll.slice(2, 4));
            const tW2b = commitTopic("c_w2_b", "ht:w2b", "W2话题B", eligibleAll.slice(4, 6));
            mem.releaseHistoryLease(chatId, lease.ownerToken);

            const capturedUserPrompts: string[] = [];
            let synthCallIdx = 0;
            const longObs = "群友在日常交流中经常以连续发图片和表情包的方式互相接龙斗图刷屏，互动节奏轻松随性并且持续时间较长，经常一刷就是几十条消息甚至刷满整个屏幕";
            assert.ok(longObs.length > 60);

            const llmCall: HistoryLlmCallFn = async (opts) => {
                const userPrompt = opts.messages[1].content;
                capturedUserPrompts.push(userPrompt);
                synthCallIdx++;

                // Call 1: Week 1 synthesis unit
                if (synthCallIdx === 1) {
                    return {
                        content: JSON.stringify({
                            groupUpdates: {
                                description: "轻松互损的日常水群",
                                communicationNorms: ["常用图片和表情包参与互动，发言简短", "暂无"],
                                hotTopics: ["日常吐槽"],
                                tabooTopics: ["暂无明确证据显示存在固定忌讳话题"],
                                evidence: [{ topicId: tW1, messageIds: ["w1_m1", "w1_m2"] }],
                            },
                            memberProfiles: [
                                {
                                    userId: "onebot:101",
                                    traits: [
                                        { value: "常以表情包回应，发言简短", topicId: tW1, messageIds: ["w1_m1"] },
                                        { value: "未知", topicId: tW1, messageIds: ["w1_m1"] },
                                    ],
                                    interests: [
                                        { value: "喜欢接龙整活", topicId: tW1, messageIds: ["w1_m1"] },
                                    ],
                                    communicationStyle: { value: "简短直接", topicId: tW1, messageIds: ["w1_m1"] },
                                    episodes: [
                                        { summary: "暂无明显互动", sentiment: "neutral", significance: 2, topicId: tW1, messageIds: ["w1_m1"] },
                                    ],
                                },
                                {
                                    userId: "onebot:102",
                                    traits: [{ value: "爱跟风复读接龙", topicId: tW1, messageIds: ["w1_m2"] }],
                                    interests: [],
                                },
                            ],
                            memes: [
                                {
                                    canonicalKey: "leaked-example",
                                    term: "现充/闲虫",
                                    meaning: "代指社交生活丰富的人",
                                    originContext: "本批采样中仅出现昵称“Dave”，未见明确“现充/闲虫”玩梗发言，故仅作待观察项。",
                                    usageBoundaries: "证据不足，不建议随意使用",
                                    topicId: tW1,
                                    messageIds: ["w1_m1"],
                                },
                                {
                                    canonicalKey: "hedgehog-meme",
                                    term: "扎老板的手",
                                    meaning: "群内刷屏接龙的搞笑整活段子",
                                    originContext: "群友复制整活文案互相调侃",
                                    usageBoundaries: "不确定时不要用",
                                    topicId: tW1,
                                    messageIds: ["w1_m1", "w1_m2"],
                                },
                            ],
                            groupObservations: [
                                {
                                    canonicalKey: "obs-w1-stickers",
                                    content: longObs,
                                    topicId: tW1,
                                    messageIds: ["w1_m1", "w1_m2"],
                                },
                                {
                                    canonicalKey: "obs-w1-placeholder",
                                    content: "未发现明确的线下聚会计划",
                                    topicId: tW1,
                                    messageIds: ["w1_m1"],
                                },
                            ],
                        }),
                    };
                }

                // Call 2: Week 2 unit hits context_length_exceeded to test split-retry path!
                if (synthCallIdx === 2) {
                    throw new Error("context_length_exceeded");
                }

                // Call 3: Week 2 left split (tW2a, message w2_m1)
                if (synthCallIdx === 3) {
                    return {
                        content: JSON.stringify({
                            groupUpdates: {
                                description: "尚无明确全群描述",
                                communicationNorms: [
                                    "常以图片和表情包参与互动，发言较简短", // paraphrase of W1 norm -> must be skipped!
                                    "喜欢深夜复读接龙",
                                ],
                                tabooTopics: ["N/A"],
                                evidence: [{ topicId: tW2a, messageIds: ["w2_m1"] }],
                            },
                            memberProfiles: [
                                {
                                    userId: "onebot:101",
                                    traits: [
                                        { value: "常用表情包回应，发言非常简短", topicId: tW2a, messageIds: ["w2_m1"] }, // paraphrase -> skip!
                                        { value: "喜欢深夜斗图", topicId: tW2a, messageIds: ["w2_m1"] },
                                    ],
                                    interests: [
                                        { value: "爱接龙整活", topicId: tW2a, messageIds: ["w2_m1"] }, // paraphrase -> skip!
                                    ],
                                    communicationStyle: { value: "暂无", topicId: tW2a, messageIds: ["w2_m1"] },
                                },
                            ],
                            memes: [],
                            groupObservations: [
                                {
                                    canonicalKey: "obs-w2-paraphrase-different-key",
                                    content: "群友日常互动常以连续发图片和表情包互相接龙斗图刷屏，节奏轻松随性", // paraphrase of W1 obs -> skip at store!
                                    topicId: tW2a,
                                    messageIds: ["w2_m1", "w2_m1b"],
                                },
                            ],
                        }),
                    };
                }

                // Call 4: Week 2 right split (tW2b, messages w2_m2, w2_m3)
                return {
                    content: JSON.stringify({
                        groupUpdates: {
                            communicationNorms: [
                                "喜欢在深夜里复读接龙", // paraphrase of left split norm -> skipped by mergeSynthesisOutputs!
                                ...Array.from({ length: 15 }, (_, i) => `新规范_${i}_编号_${i * 10}`),
                            ],
                            evidence: [{ topicId: tW2b, messageIds: ["w2_m2", "w2_m3"] }],
                        },
                        memberProfiles: [],
                        memes: [
                            {
                                canonicalKey: "partial-variant-meme",
                                term: "现充 ｜ 闲虫", // "现充" unattested in w2_m2, "闲虫" attested -> trimmed to "闲虫"!
                                meaning: "调侃群友社交丰富",
                                usageBoundaries: "熟人开玩笑使用",
                                topicId: tW2b,
                                messageIds: ["w2_m2", "w2_m3"],
                            },
                            {
                                canonicalKey: "placeholder-meaning-meme",
                                term: "闲虫",
                                meaning: "待观察，证据不足",
                                usageBoundaries: "暂不使用",
                                topicId: tW2b,
                                messageIds: ["w2_m2"],
                            },
                        ],
                        groupObservations: [
                            {
                                canonicalKey: "obs-w2-new",
                                content: "Carol 习惯在午后主动发起游戏开黑邀约",
                                topicId: tW2b,
                                messageIds: ["w2_m2", "w2_m3"],
                            },
                        ],
                    }),
                };
            };

            await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "synthesize",
                config: makeTestConfig(),
                llmCall,
            });

            // 1. Unit 1 prompt must omit "已有记录" when nothing is recorded yet; Unit 2 (both split calls) must include Unit 1 records!
            assert.equal(capturedUserPrompts.length, 4);
            assert.equal(capturedUserPrompts[0].includes("## 已有记录"), false);

            for (const splitPrompt of [capturedUserPrompts[2], capturedUserPrompts[3]]) {
                assert.ok(splitPrompt.includes("## 已有记录"));
                assert.ok(splitPrompt.includes("轻松互损的日常水群"));
                assert.ok(splitPrompt.includes("常用图片和表情包参与互动，发言简短"));
                assert.ok(splitPrompt.includes("扎老板的手"));
                assert.ok(splitPrompt.includes(longObs.slice(0, 59) + "…"));
                assert.equal(splitPrompt.includes("跨群秘密暗号"), false, "Foreign chat facts must never appear in prompt");
            }
            // Left split (w2a) has onebot:101 but NOT onebot:102; right split (w2b) has onebot:103 only
            assert.ok(capturedUserPrompts[2].includes("onebot:101"));
            assert.equal(capturedUserPrompts[2].includes("onebot:102"), false);
            assert.equal(capturedUserPrompts[3].includes("onebot:101"), false);

            // 2. GroupModel checks: placeholder taboo/description dropped, existing norm kept, paraphrases skipped, cap <= 12 enforced
            const gm = mem.getGroupModel(chatId)!;
            assert.equal(gm.description, "轻松互损的日常水群");
            assert.deepEqual(gm.tabooTopics, []);
            assert.equal(gm.communicationNorms[0], "常用图片和表情包参与互动，发言简短");
            assert.equal(gm.communicationNorms.some(n => n.includes("常以图片和表情包")), false, "Paraphrased norm must be skipped");
            assert.equal(gm.communicationNorms.filter(n => n.includes("复读接龙")).length, 1, "Left/right split paraphrase must be deduped");
            assert.ok(gm.communicationNorms.length <= 12, `communicationNorms cap <= 12, got ${gm.communicationNorms.length}`);

            // 3. Member profile checks: placeholder values dropped, existing trait/interest kept, paraphrases skipped
            const alice = mem.getProfilesForChat(chatId).find(p => p.userId === "onebot:101")!;
            assert.deepEqual(alice.traits, ["常以表情包回应，发言简短", "喜欢深夜斗图"]);
            assert.deepEqual(alice.interests, ["喜欢接龙整活"]);
            assert.equal(alice.communicationStyle, "简短直接");
            assert.equal(alice.recentEpisodes.length, 0, "Placeholder episode must be dropped");

            // 4. Facts checks: evidence-less 现充/闲虫 dropped, 仙人掌扎老板的手 (usageBoundaries="不确定时不要用") kept,
            //    trimmed "闲虫" kept, placeholder observations & paraphrased W2 observation skipped!
            const facts = mem.listCoreFacts({ sourceChatId: chatId, includeAllHistory: true }).items;
            const memes = facts.filter(f => f.category === "anecdote");
            const observations = facts.filter(f => f.category === "general");

            assert.equal(memes.length, 2);
            assert.ok(memes.some(m => m.content.startsWith("[群梗: 扎老板的手]") && m.content.includes("使用边界: 不确定时不要用") && m.content.includes("使用情况: 导入的历史中 2 条消息、2 人用过")));
            assert.ok(memes.some(m => m.content.startsWith("[群梗: 闲虫]") && m.content.includes("使用情况: 导入的历史中 2 条消息、2 人用过")));
            assert.equal(memes.some(m => m.content.includes("现充")), false, "Unattested variant 现充 must be trimmed/dropped");

            assert.equal(observations.length, 2, "Only W1 observation and genuinely new W2 observation should be stored");
            assert.ok(observations.some(o => o.content === longObs));
            assert.ok(observations.some(o => o.content.includes("Carol")));
        } finally {
            cleanupTestMemory(mem, "hist-synth-quality-guards");
        }
    });

    it("17. splits the synthesis batch when the model output is cut off instead of asking for a repair", async () => {
        assert.equal(looksTruncatedJson('{"a":[1,2]}'), false);
        assert.equal(looksTruncatedJson('```json\n{"a":{"b":"}"}}\n```'), false);
        assert.equal(looksTruncatedJson('{"a":[{"b":1},'), true);
        assert.equal(looksTruncatedJson('{"a":"ends inside a string }'), true);
        assert.equal(looksTruncatedJson('{"a":"escaped \\" quote, still open'), true);
        assert.equal(looksTruncatedJson("no object here"), false);

        const mem = createTestMemory("hist-output-truncated");
        const chatId = "onebot:group:10017";
        try {
            const baseMs = Date.parse("2025-06-01T00:00:00.000Z");
            seedMessages(mem, chatId, Array.from({ length: 24 }, (_, i) => ({
                id: `tm_${String(i).padStart(2, "0")}`,
                userId: i % 2 === 0 ? "onebot:111" : "onebot:222",
                name: i % 2 === 0 ? "Alice" : "Bob",
                text: `line ${i}`,
                ts: new Date(baseMs + i * 10_000).toISOString(),
            })));

            const stages: string[] = [];
            const llmCall: HistoryLlmCallFn = async (opts) => {
                stages.push(opts.stage);
                const user = String(opts.messages[1].content);
                if (opts.stage === "cluster") {
                    const ids = [...new Set([...user.matchAll(/\[(tm_\d+)\]/g)].map(m => m[1]))];
                    return {
                        content: JSON.stringify({
                            topics: [
                                { tempId: "t1", label: "Breakfast", messageIds: ids.slice(0, 12) },
                                { tempId: "t2", label: "Late games", messageIds: ids.slice(12) },
                            ],
                        }),
                    };
                }
                if (opts.stage === "summary") {
                    const tempIds = [...user.matchAll(/### 话题 (\S+):/g)].map(m => m[1]);
                    return {
                        content: JSON.stringify({
                            summaries: tempIds.map(tempId => ({ tempId, label: tempId, summary: "s", keyPoints: ["k"], keywords: ["w"], sentiment: "neutral" })),
                        }),
                    };
                }
                const topicIds = [...user.matchAll(/- topicId: (\S+)/g)].map(m => m[1]);
                if (topicIds.length > 1) {
                    // Two topics do not fit the output limit: the object never closes.
                    return { content: '{"groupUpdates":{"evidence":[]},"memberProfiles":[],"memes":[{"term":"cut o' };
                }
                const msgIds = [...user.matchAll(/\[(tm_\d+)\] \(/g)].map(m => m[1]).slice(0, 2);
                return {
                    content: JSON.stringify({
                        groupUpdates: { evidence: [] },
                        memberProfiles: [],
                        memes: [],
                        groupObservations: [{
                            canonicalKey: `obs-${topicIds[0]}`,
                            content: msgIds[0] < "tm_12" ? "大家早上喜欢聊早餐吃什么" : "深夜经常约着组队打游戏",
                            topicId: topicIds[0],
                            messageIds: msgIds,
                        }],
                    }),
                };
            };

            const res = await runHistoryInitializationWithMemory(mem, {
                chatId,
                mode: "full",
                stage: "all",
                config: makeTestConfig(),
                llmCall,
            });
            assert.equal(res.processedSynthesisUnits, 1);
            assert.equal(res.factsCommitted, 2);
            assert.equal(stages.filter(st => st === "synthesis").length, 3, "one cut-off attempt, then one call per half");
            assert.equal(stages.includes("repair"), false, "repeating a cut-off answer would only be cut off again");
            assert.equal(mem.findLatestHistoryJob("initialize", chatId)?.status, "done");
        } finally {
            cleanupTestMemory(mem, "hist-output-truncated");
        }
    });

    it("18. enforces meme recurrence, cross-variant meme dedup across units/splits/store, multi-sender observations, per-unit caps, and batch size 8", async () => {
        assert.equal(DEFAULT_MAX_TOPICS_PER_BATCH, 8);
        const mem = createTestMemory("hist-synth-recurrence-caps");
        const chatId = "onebot:group:60018";
        try {
            // Seed messages covering:
            // - one-off remark by one sender ("一次性吐槽")
            // - meme used by 2 senders ("猫都不吃这罐头", "你是猫？", "只是在念稿")
            // - meme used in 3 distinct messages by 1 sender ("三连复读梗")
            // - blocked / recalled / system rows that must NOT count toward recurrence
            // - wildcard-safe literal instr check ("%_" should not match normal text)
            // - enough repeated memes + multi-sender observations across 2 ISO weeks to test caps & split merge
            const rows: Array<{
                id: string;
                userId: string;
                name: string;
                text: string;
                ts: string;
                qceMeta?: Record<string, unknown>;
                blocked?: boolean;
            }> = [
                // Week 1 (2025-W02)
                { id: "r_oneoff", userId: "onebot:101", name: "Alice", text: "今天遇到一个一次性吐槽而已", ts: "2025-01-06T10:00:00.000Z" },
                { id: "r_oneoff_blk", userId: "onebot:102", name: "Bob", text: "一次性吐槽", ts: "2025-01-06T10:00:10.000Z", blocked: true },
                { id: "r_oneoff_rec", userId: "onebot:103", name: "Carol", text: "一次性吐槽", ts: "2025-01-06T10:00:20.000Z", qceMeta: { recalled: true } },
                { id: "r_oneoff_sys", userId: "system", name: "System", text: "一次性吐槽", ts: "2025-01-06T10:00:30.000Z" },
                { id: "r_dog1", userId: "onebot:101", name: "Alice", text: "猫都不吃这罐头", ts: "2025-01-06T10:01:00.000Z" },
                { id: "r_dog2", userId: "onebot:102", name: "Bob", text: "你是猫？只是在念稿", ts: "2025-01-06T10:02:00.000Z" },
                { id: "r_tri1", userId: "onebot:103", name: "Carol", text: "三连复读梗 启动", ts: "2025-01-06T10:03:00.000Z" },
                { id: "r_tri2", userId: "onebot:103", name: "Carol", text: "三连复读梗 继续", ts: "2025-01-06T10:04:00.000Z" },
                { id: "r_tri3", userId: "onebot:103", name: "Carol", text: "三连复读梗 结束", ts: "2025-01-06T10:05:00.000Z" },
                // Week 2 (2025-W03): two topics for split-merge testing (shared-variant memes + cap >6 memes / >3 obs)
                { id: "w2_a1", userId: "onebot:101", name: "Alice", text: "猫都不吃这罐头 确实; 共享半边梗 左半变体 梗A1 梗A2 梗A3 梗A4", ts: "2025-01-13T10:00:00.000Z" },
                { id: "w2_a2", userId: "onebot:102", name: "Bob", text: "共享半边梗 左半变体 梗A1 梗A2 梗A3 梗A4", ts: "2025-01-13T10:01:00.000Z" },
                { id: "w2_b1", userId: "onebot:101", name: "Alice", text: "你是猫？哈哈; 共享半边梗 右半变体 梗B1 梗B2 梗B3 梗B4", ts: "2025-01-13T12:00:00.000Z" },
                { id: "w2_b2", userId: "onebot:102", name: "Bob", text: "共享半边梗 右半变体 梗B1 梗B2 梗B3 梗B4", ts: "2025-01-13T12:01:00.000Z" },
            ];
            seedMessages(mem, chatId, rows);

            // Verify countChatMemeVariantUsage SQL eligibility, <2 char skip, and literal instr (no LIKE wildcard expansion)
            assert.deepEqual(mem.countChatMemeVariantUsage(chatId, ["一次性吐槽"]), { messageCount: 1, senderCount: 1 });
            assert.deepEqual(mem.countChatMemeVariantUsage(chatId, ["一", "三"]), { messageCount: 0, senderCount: 0 });
            assert.deepEqual(mem.countChatMemeVariantUsage(chatId, ["%_", "___"]), { messageCount: 0, senderCount: 0 });
            assert.deepEqual(mem.countChatMemeVariantUsage(chatId, ["三连复读梗"]), { messageCount: 3, senderCount: 1 });

            // Commit 1 topic in W1 and 2 topics in W2 (plus verify 9 topics in W3 batch into 8 + 1)
            const lease = mem.acquireHistoryLease(chatId);
            const job = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "rec-test", optionsJson: "{}", status: "running" }, lease.ownerToken);
            const eligible = loadEligibleHistoryMessages(mem, chatId);
            const byId = new Map(eligible.map(m => [m.messageId, m]));

            const commitCluster = (unitKey: string, hKey: string, label: string, ids: string[]) => {
                const msgs = ids.map(id => byId.get(id)!);
                mem.upsertHistoryUnits(job.jobId, "cluster", [{ unitKey, ordinal: 0, inputJson: "{}" }], lease.ownerToken);
                return mem.commitHistoricalClusterUnit({
                    jobId: job.jobId,
                    ownerToken: lease.ownerToken,
                    chatId,
                    unitKey,
                    expectedMessageIds: ids,
                    expectedDigest: computeMessagesDigest(toDigestFields(msgs)),
                    topics: [{
                        historyKey: hKey,
                        label,
                        summary: label,
                        keyPoints: [label],
                        participants: [...new Set(msgs.map(m => m.userId))],
                        keywords: [label],
                        messageIds: ids,
                        startedAt: msgs[0].timestamp,
                        endedAt: msgs[msgs.length - 1].timestamp,
                        sentiment: "neutral",
                    }],
                    coveredPairs: ids.map(id => ({ messageId: id, topicHistoryKey: hKey })),
                    outputJson: "{}",
                }).topicIds[0];
            };

            const tW1 = commitCluster("cu1", "ht:r1", "W1", ["r_oneoff", "r_dog1", "r_dog2", "r_tri1", "r_tri2", "r_tri3"]);
            const tW2a = commitCluster("cu2a", "ht:r2a", "W2A", ["w2_a1", "w2_a2"]);
            const tW2b = commitCluster("cu2b", "ht:r2b", "W2B", ["w2_b1", "w2_b2"]);
            mem.releaseHistoryLease(chatId, lease.ownerToken);

            // Check batching splits 9 topics into 8 + 1
            const syntheticNineTopics = Array.from({ length: 9 }, (_, i) => ({
                ...mem.getHistoricalTopicsForChat(chatId)[0],
                id: `batch_t_${i}`,
                historyKey: `ht:b:${i}`,
                startedAt: `2025-02-03T10:0${i}:00.000Z`,
                endedAt: `2025-02-03T10:0${i}:30.000Z`,
            }));
            const nineBatches = buildSynthesisMacroBatches(syntheticNineTopics, mem, { chatId });
            assert.deepEqual(nineBatches.batches.map(b => b.topics.length), [8, 1]);

            let callCount = 0;
            const llmCall: HistoryLlmCallFn = async (opts) => {
                callCount++;
                const user = opts.messages[1].content;
                // Unit 1 (W1): proposes one-off (dropped), 2-sender meme (kept), 3-msg single-sender meme (kept),
                // 1-sender observation (dropped), 2-sender observation (kept)
                if (callCount === 1) {
                    return {
                        content: JSON.stringify({
                            groupUpdates: { evidence: [] },
                            memberProfiles: [],
                            memes: [
                                {
                                    canonicalKey: "oneoff",
                                    term: "一次性吐槽",
                                    meaning: "只出现一次的随口吐槽",
                                    usageBoundaries: "不应收录",
                                    topicId: tW1,
                                    messageIds: ["r_oneoff"],
                                },
                                {
                                    canonicalKey: "dog-w1",
                                    term: "猫都不吃这罐头 / 你是猫？",
                                    meaning: "群友对特定游戏模式的调侃接梗",
                                    usageBoundaries: "熟人调侃时使用",
                                    topicId: tW1,
                                    messageIds: ["r_dog1", "r_dog2"],
                                },
                                {
                                    canonicalKey: "triple-w1",
                                    term: "三连复读梗",
                                    meaning: "单人连续刷屏三次的复读梗",
                                    usageBoundaries: "玩梗刷屏时谨慎跟随",
                                    topicId: tW1,
                                    messageIds: ["r_tri1", "r_tri2", "r_tri3"],
                                },
                            ],
                            groupObservations: [
                                {
                                    canonicalKey: "single-sender-obs",
                                    content: "Carol 喜欢自己连续发三次消息",
                                    topicId: tW1,
                                    messageIds: ["r_tri1", "r_tri2", "r_tri3"], // single sender! -> dropped
                                },
                                {
                                    canonicalKey: "two-sender-obs",
                                    content: "群友之间常互相接茬玩游戏梗",
                                    topicId: tW1,
                                    messageIds: ["r_dog1", "r_dog2"], // 2 distinct senders -> kept
                                },
                            ],
                        }),
                    };
                }

                // Unit 2 (W2): trigger split via truncation / context error
                if (callCount === 2) {
                    throw new Error("context_length_exceeded");
                }

                // Unit 2 left split (tW2a): tries overlapping meme with W1 ("猫都不吃这罐头") + 4 new memes + 2 obs
                if (user.includes(tW2a)) {
                    return {
                        content: JSON.stringify({
                            groupUpdates: { evidence: [] },
                            memberProfiles: [],
                            memes: [
                                {
                                    canonicalKey: "dog-w2a-dup",
                                    term: "猫都不吃这罐头 / 梗A1", // shares "猫都不吃这罐头" with W1 -> skipped!
                                    meaning: "重复梗",
                                    usageBoundaries: "测试",
                                    topicId: tW2a,
                                    messageIds: ["w2_a1", "w2_a2"],
                                },
                                {
                                    canonicalKey: "split-shared-left",
                                    term: "共享半边梗 / 左半变体",
                                    meaning: "左半边先提出的共享梗",
                                    usageBoundaries: "测试",
                                    topicId: tW2a,
                                    messageIds: ["w2_a1", "w2_a2"],
                                },
                                ...["梗A1", "梗A2", "梗A3"].map(term => ({
                                    canonicalKey: `k_${term}`,
                                    term,
                                    meaning: `${term} 含义`,
                                    usageBoundaries: "测试边界",
                                    topicId: tW2a,
                                    messageIds: ["w2_a1", "w2_a2"],
                                })),
                            ],
                            groupObservations: [
                                { canonicalKey: "obs_l1", content: "群友早上经常同步上线打招呼", topicId: tW2a, messageIds: ["w2_a1", "w2_a2"] },
                                { canonicalKey: "obs_l2", content: "群里回复速度普遍较快且偏简短", topicId: tW2a, messageIds: ["w2_a1", "w2_a2"] },
                            ],
                        }),
                    };
                }

                // Unit 2 right split (tW2b): tries overlapping meme with W1 ("你是猫？") + 4 new memes + 2 obs
                // Merged W2 result has 4 (left) + 4 (right) = 8 memes -> capped at 6; 2 + 2 = 4 obs -> capped at 3!
                return {
                    content: JSON.stringify({
                        groupUpdates: { evidence: [] },
                        memberProfiles: [],
                        memes: [
                            {
                                canonicalKey: "dog-w2b-dup",
                                term: "你是猫？", // shares variant with W1 -> skipped!
                                meaning: "重复梗",
                                usageBoundaries: "测试",
                                topicId: tW2b,
                                messageIds: ["w2_b1", "w2_b2"],
                            },
                            {
                                canonicalKey: "split-shared-right",
                                term: "共享半边梗 / 右半变体", // shares "共享半边梗" with left split half -> skipped in mergeSynthesisOutputs!
                                meaning: "右半边重复的共享梗",
                                usageBoundaries: "测试",
                                topicId: tW2b,
                                messageIds: ["w2_b1", "w2_b2"],
                            },
                            ...["梗B1", "梗B2", "梗B3", "梗B4"].map(term => ({
                                canonicalKey: `k_${term}`,
                                term,
                                meaning: `${term} 含义`,
                                usageBoundaries: "测试边界",
                                topicId: tW2b,
                                messageIds: ["w2_b1", "w2_b2"],
                            })),
                        ],
                        groupObservations: [
                            { canonicalKey: "obs_r1", content: "午间讨论游戏配队时气氛比较活跃", topicId: tW2b, messageIds: ["w2_b1", "w2_b2"] },
                            { canonicalKey: "obs_r2", content: "群友喜欢在午休时段连续刷图互动", topicId: tW2b, messageIds: ["w2_b1", "w2_b2"] },
                        ],
                    }),
                };
            };

            await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "synthesize",
                config: makeTestConfig(),
                llmCall,
            });

            const facts = mem.listCoreFacts({ sourceChatId: chatId, includeAllHistory: true }).items;
            const memes = facts.filter(f => f.category === "anecdote");
            const observations = facts.filter(f => f.category === "general");

            // W1: 2 memes ("猫都不吃这罐头 / 你是猫？" & "三连复读梗"), one-off dropped;
            // W2: 4 (left: 共享半边梗+A1..A3) + 4 (right: B1..B4, with 共享半边梗/右半变体 deduped) capped at 6 -> total 8 memes!
            assert.equal(memes.length, 8);
            assert.equal(memes.some(m => m.content.includes("一次性吐槽")), false, "One-off meme must be dropped");
            assert.equal(memes.filter(m => m.content.includes("共享半边梗")).length, 1, "Shared meme variant across split halves must dedupe");
            assert.equal(memes.some(m => m.content.includes("右半变体")), false);

            const dogMeme = memes.find(m => m.content.startsWith("[群梗: 猫都不吃这罐头 / 你是猫？]"))!;
            assert.ok(dogMeme);
            assert.ok(dogMeme.content.includes("使用情况: 导入的历史中 4 条消息、2 人用过"));

            const tripleMeme = memes.find(m => m.content.startsWith("[群梗: 三连复读梗]"))!;
            assert.ok(tripleMeme);
            assert.ok(tripleMeme.content.includes("使用情况: 导入的历史中 3 条消息、1 人用过"));

            // Observations: W1 had 1 valid (single-sender dropped), W2 split merged 4 -> capped at 3 -> total 4!
            assert.equal(observations.length, 4);
            assert.equal(observations.some(o => o.content.includes("Carol")), false, "Single-sender observation must be dropped");
            assert.equal(observations.some(o => o.content.includes("午休时段")), false, "Merged W2 observations must be capped at 3");

            // Store-level commit dedup: direct commitHistoricalSynthesisUnit with overlapping normalized meme variant is skipped
            const lStore = mem.acquireHistoryLease(chatId);
            const jStore = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "store-dedup", optionsJson: "{}", status: "running" }, lStore.ownerToken);
            mem.upsertHistoryUnits(jStore.jobId, "synthesize", [{ unitKey: "sd1", ordinal: 0, inputJson: "{}" }], lStore.ownerToken);
            const storeRes = mem.commitHistoricalSynthesisUnit({
                jobId: jStore.jobId,
                ownerToken: lStore.ownerToken,
                chatId,
                unitKey: "sd1",
                rankKey: "2025-W04#0000",
                memberPatches: [],
                factProposals: [{
                    historyKey: "hist_meme:brand-new-key-overlap",
                    subject: `group:${chatId}`,
                    content: "[群梗: 猫都不吃这罐头 / 全新变体]；真实含义: 重复；使用边界: 测；使用情况: 导入的历史中 2 条消息、2 人用过",
                    category: "anecdote",
                    sourceTopicId: tW1,
                    sourceMessageIds: ["r_dog1", "r_dog2"],
                    observedAt: "2025-01-06T10:02:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(chatId, lStore.ownerToken);
            assert.equal(storeRes.factsCommitted, 0, "Store commit must also reject overlapping meme variant");
        } finally {
            cleanupTestMemory(mem, "hist-synth-recurrence-caps");
        }
    });

    it("19. Lease stays alive across slow synchronous planning and tolerates transient SQLITE_BUSY on heartbeat", async () => {
        const mem = createTestMemory("hist-lease-sync-busy");
        const chatId = "onebot:group:52099";
        try {
            seedMessages(mem, chatId, [
                { id: "lb1", userId: "onebot:1", name: "Alice", text: "alpha", ts: "2025-07-01T10:00:00.000Z" },
                { id: "lb2", userId: "onebot:2", name: "Bob", text: "beta", ts: "2025-07-01T10:01:00.000Z" },
            ]);

            // Inject a single transient SQLITE_BUSY on heartbeat renewal, followed by normal renewals
            const origRenew = mem.renewHistoryLease.bind(mem);
            let renewCalls = 0;
            let injectedBusy = false;
            mem.renewHistoryLease = ((cid: string, token: string, ttl?: number) => {
                renewCalls++;
                if (!injectedBusy && renewCalls >= 2) {
                    injectedBusy = true;
                    const err = new Error("database is locked") as Error & { code?: string };
                    err.code = "SQLITE_BUSY";
                    throw err;
                }
                return origRenew(cid, token, ttl);
            }) as typeof mem.renewHistoryLease;

            const res = await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "all",
                leaseTtlMs: 300,
                config: makeTestConfig(),
                llmCall: async (opts) => {
                    await new Promise(r => setTimeout(r, 150));
                    if (opts.stage === "cluster") {
                        return { content: JSON.stringify({ topics: [{ tempId: "t1", label: "Test", messageIds: ["lb1", "lb2"] }] }) };
                    }
                    if (opts.stage === "summary") {
                        return { content: JSON.stringify({ summaries: [{ tempId: "t_1", label: "Test", summary: "alpha beta summary", keyPoints: ["kp1"], keywords: ["kw1"], sentiment: "neutral" }] }) };
                    }
                    if (opts.stage !== "synthesis") {
                        return { content: JSON.stringify({ summaries: [{ tempId: "t_1", label: "Test", summary: "alpha beta summary", keyPoints: ["kp1"], keywords: ["kw1"], sentiment: "neutral" }] }) };
                    }
                    const topic = mem.getHistoricalTopicsForChat(chatId)[0];
                    return {
                        content: JSON.stringify({
                            groupUpdates: { evidence: [{ topicId: topic.id, messageIds: ["lb1", "lb2"] }] },
                            memberProfiles: [],
                            memes: [],
                            groupObservations: [],
                        }),
                    };
                },
            });

            assert.equal(injectedBusy, true, "Test must exercise the transient SQLITE_BUSY branch");
            assert.ok(renewCalls >= 4, "Lease must be renewed across planning and heartbeat ticks");
            assert.equal(res.topicsCommitted, 1);
            assert.equal(mem.findLatestHistoryJob("initialize", chatId)?.status, "done");
        } finally {
            cleanupTestMemory(mem, "hist-lease-sync-busy");
        }
    });
});
