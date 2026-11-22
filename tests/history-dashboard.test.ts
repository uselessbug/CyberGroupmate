import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import express from "express";
import {
    HistoryInitRunner,
    type HistoryRunnerRunningInfo,
} from "../src/history/runner.js";
import {
    ESTIMATED_MESSAGES_PER_TOPIC,
    MAX_MEMES_PER_SYNTHESIS_UNIT,
    MAX_OBSERVATIONS_PER_SYNTHESIS_UNIT,
    runHistoryInitialization,
    runHistoryInitializationWithMemory,
    type HistoryLlmCallFn,
} from "../src/history/initialize.js";
import {
    buildHistoryWindows,
    loadEligibleHistoryMessages,
    toDigestFields,
} from "../src/history/windows.js";
import { createApiRouter } from "../src/dashboard/api-routes.js";
import type { DashboardDeps } from "../src/dashboard/types.js";
import type { EventBridge } from "../src/dashboard/event-bridge.js";
import {
    buildMemeFactContent,
    computeMessagesDigest,
    parseMemeFactContent,
} from "../src/memory-v2/index.js";
import type { AppConfig, LLMConfig } from "../src/core/config.js";
import { cleanupTestMemory, createTestMemory } from "./helpers/test-db.js";

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
    })));
}

function seedClusterTopic(
    mem: ReturnType<typeof createTestMemory>,
    chatId: string,
    topicHistoryKey: string,
    label: string,
    messageIds: string[],
): string {
    const lease = mem.acquireHistoryLease(chatId);
    const job = mem.upsertHistoryJob({
        kind: "initialize",
        chatId,
        inputKey: `seed-${topicHistoryKey}`,
        optionsJson: JSON.stringify({ mode: "quick", stage: "all" }),
        status: "running",
    }, lease.ownerToken);

    const eligible = loadEligibleHistoryMessages(mem, chatId).filter(m => messageIds.includes(m.messageId));
    const [win] = buildHistoryWindows(eligible, { minWindowMessages: 0 });
    mem.upsertHistoryUnits(job.jobId, "cluster", [{
        unitKey: win.unitKey,
        ordinal: 0,
        inputJson: "{}",
    }], lease.ownerToken);

    const res = mem.commitHistoricalClusterUnit({
        jobId: job.jobId,
        ownerToken: lease.ownerToken,
        chatId,
        unitKey: win.unitKey,
        expectedMessageIds: win.messageIds,
        expectedDigest: computeMessagesDigest(toDigestFields(eligible)),
        topics: [{
            historyKey: topicHistoryKey,
            label,
            summary: `${label} summary`,
            keyPoints: [],
            participants: [...new Set(eligible.map(m => m.userId))],
            keywords: [label],
            messageIds: win.messageIds,
            startedAt: eligible[0].timestamp,
            endedAt: eligible[eligible.length - 1].timestamp,
            sentiment: "neutral",
        }],
        coveredPairs: win.messageIds.map(mid => ({ messageId: mid, topicHistoryKey })),
        outputJson: "{}",
    });

    mem.updateHistoryJobStatus(job.jobId, lease.ownerToken, "done");
    mem.releaseHistoryLease(chatId, lease.ownerToken);
    return res.topicIds[0];
}

describe("History dashboard backend edge cases", () => {
    it("1. meme format round-trips and tolerates hand-edited unrecognised shapes without throwing", () => {
        const built = buildMemeFactContent({
            term: "猫罐头 / 你是猫？",
            meaning: "调侃群友挑食",
            originContext: "午饭讨论引发",
            participants: ["onebot:1", "onebot:2", "onebot:1"],
            usageBoundaries: "熟人开玩笑时使用",
            usage: { messages: 7, senders: 5 },
        });
        const parsed = parseMemeFactContent(built);
        assert.equal(parsed.term, "猫罐头 / 你是猫？");
        assert.deepEqual(parsed.variants, ["猫罐头", "你是猫？"]);
        assert.equal(parsed.meaning, "调侃群友挑食");
        assert.equal(parsed.originContext, "午饭讨论引发");
        assert.deepEqual(parsed.participants, ["onebot:1", "onebot:2"]);
        assert.equal(parsed.usageBoundaries, "熟人开玩笑时使用");
        assert.deepEqual(parsed.usage, { messages: 7, senders: 5 });

        // Hand-edited with ASCII semicolons, embedded Chinese semicolon inside meaning, missing fields, bad usage
        const handEdited = "[群梗: 怪梗]; 真实含义: 第一句；第二句\n使用边界: 别乱用; 使用情况: 好多人用过";
        const partial = parseMemeFactContent(handEdited);
        assert.equal(partial.term, "怪梗");
        assert.deepEqual(partial.variants, ["怪梗"]);
        assert.equal(partial.meaning, "第一句；第二句");
        assert.equal(partial.usageBoundaries, "别乱用");
        assert.equal(partial.originContext, "");
        assert.deepEqual(partial.participants, []);
        assert.equal(partial.usage, null);

        // Completely unrecognised text
        const freeform = parseMemeFactContent("纯手写的一段话没有任何结构标记");
        assert.equal(freeform.term, "");
        assert.deepEqual(freeform.variants, []);
        assert.equal(freeform.meaning, "");
        assert.equal(freeform.usage, null);
    });

    it("2. enforces protection rules across commit, pre-commit dedupe, prompt, edit, reject, and restore", async () => {
        const mem = createTestMemory("hist-dash-protect");
        const chatId = "onebot:group:20001";
        try {
            seedMessages(mem, chatId, [
                { id: "m1", userId: "onebot:1", name: "Alice", text: "老梗一 和 变体甲 真好玩", ts: "2025-02-01T10:00:00.000Z" },
                { id: "m2", userId: "onebot:2", name: "Bob", text: "老梗一 确实，还有 变体乙", ts: "2025-02-01T10:01:00.000Z" },
                { id: "m3", userId: "onebot:3", name: "Carol", text: "新梗A 新梗B 新梗C 新梗D 新梗E 新梗F", ts: "2025-02-01T10:02:00.000Z" },
                { id: "m4", userId: "onebot:4", name: "Dave", text: "新梗A 新梗B 新梗C 新梗D 新梗E 新梗F", ts: "2025-02-01T10:03:00.000Z" },
            ]);
            const topicId = seedClusterTopic(mem, chatId, "hist_topic:t1", "日常梗", ["m1", "m2", "m3", "m4"]);

            // Commit 3 initial historical facts: 1 meme + 2 observations
            const lease = mem.acquireHistoryLease(chatId);
            const job = mem.upsertHistoryJob({
                kind: "initialize",
                chatId,
                inputKey: "seed-synth",
                optionsJson: "{}",
                status: "running",
            }, lease.ownerToken);
            mem.upsertHistoryUnits(job.jobId, "synthesize", [{ unitKey: "u1", ordinal: 0, inputJson: "{}" }], lease.ownerToken);

            const memeKey = "hist_meme:old1";
            const approvedObsKey = "hist_obs:app1";
            const rejectedObsKey = "hist_obs:rej1";
            const editObsKey = "hist_obs:edit1";

            mem.commitHistoricalSynthesisUnit({
                jobId: job.jobId,
                ownerToken: lease.ownerToken,
                chatId,
                unitKey: "u1",
                rankKey: "2025-W05#0000",
                memberPatches: [],
                factProposals: [
                    {
                        historyKey: memeKey,
                        subject: `group:${chatId}`,
                        content: buildMemeFactContent({
                            term: "老梗一 / 变体甲",
                            meaning: "原始含义",
                            originContext: "群里聊天",
                            participants: ["onebot:1", "onebot:2"],
                            usageBoundaries: "随意",
                            usage: { messages: 2, senders: 2 },
                        }),
                        category: "anecdote",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                    {
                        historyKey: approvedObsKey,
                        subject: `group:${chatId}`,
                        content: "群友喜欢早上互相打招呼开启话题",
                        category: "general",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                    {
                        historyKey: rejectedObsKey,
                        subject: `group:${chatId}`,
                        content: "群友经常在深夜吐槽工作太累了",
                        category: "general",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                    {
                        historyKey: editObsKey,
                        subject: `group:${chatId}`,
                        content: "可编辑的观察条目初始内容",
                        category: "general",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                ],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.updateHistoryJobStatus(job.jobId, lease.ownerToken, "done");
            mem.releaseHistoryLease(chatId, lease.ownerToken);

            // Set embeddings on the facts so we can verify reject cleans facts_vec and edit clears embedding
            const allFactsBefore = mem.listCoreFacts({ sourceChatId: chatId, includeAllHistory: true }).items;
            const memeFactRow = allFactsBefore.find(f => f.historyKey === memeKey)!;
            const rejObsRow = allFactsBefore.find(f => f.historyKey === rejectedObsKey)!;
            const editObsRow = allFactsBefore.find(f => f.historyKey === editObsKey)!;
            mem.setFactEmbedding(memeFactRow.id, new Float32Array(128).fill(0.25));
            mem.setFactEmbedding(editObsRow.id, new Float32Array(128).fill(0.25));

            // Approve approvedObsKey, reject memeKey + rejectedObsKey, edit editObsKey
            assert.equal(mem.reviewHistoryFacts(chatId, "approve", [approvedObsKey]), 1);
            assert.equal(mem.reviewHistoryFacts(chatId, "reject", [memeKey, rejectedObsKey]), 2);
            const editRes = mem.editHistoryFact({
                chatId,
                historyKey: editObsKey,
                content: "人工校对后的群观察内容",
            });
            assert.equal(editRes.status, "ok");
            assert.equal(editRes.item.status, "approved");

            // Reject must remove from FTS and facts_vec
            assert.equal(mem.searchFacts("原始含义", { includeAllHistory: true }).length, 0);
            assert.equal(mem.searchFacts("深夜吐槽工作", { includeAllHistory: true }).length, 0);
            if (mem.sqliteVecAvailable) {
                const vecRow = (mem as any).db.prepare("SELECT 1 FROM facts_vec WHERE fact_id = ?").get(memeFactRow.id);
                assert.equal(vecRow, undefined, "reject must delete facts_vec row");
                const editVecRow = (mem as any).db.prepare("SELECT 1 FROM facts_vec WHERE fact_id = ?").get(editObsRow.id);
                assert.equal(editVecRow, undefined, "edit must delete stale facts_vec row");
            }
            assert.equal(mem.getFactById(rejObsRow.id), null);
            assert.ok(
                mem.getUnembeddedHistoryTargets(chatId).facts.some(f => f.id === editObsRow.id),
                "edit must invalidate stale embedding",
            );

            // Direct commitHistoricalSynthesisUnit must obey all protection rules
            const l2 = mem.acquireHistoryLease(chatId);
            const j2 = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "recommit", optionsJson: "{}", status: "running" }, l2.ownerToken);
            mem.upsertHistoryUnits(j2.jobId, "synthesize", [{ unitKey: "u2", ordinal: 0, inputJson: "{}" }], l2.ownerToken);
            const commitBlocked = mem.commitHistoricalSynthesisUnit({
                jobId: j2.jobId,
                ownerToken: l2.ownerToken,
                chatId,
                unitKey: "u2",
                rankKey: "2025-W06#0000",
                memberPatches: [],
                factProposals: [
                    // Rejected same key
                    {
                        historyKey: memeKey,
                        subject: `group:${chatId}`,
                        content: "[群梗: 老梗一]；真实含义: 试图复活；使用边界: 测",
                        category: "anecdote",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                    // Different key sharing rejected variant "变体甲"
                    {
                        historyKey: "hist_meme:new-key-overlap",
                        subject: `group:${chatId}`,
                        content: "[群梗: 变体甲 / 全新词]；真实含义: 换壳复活；使用边界: 测",
                        category: "anecdote",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                    // Near-duplicate of rejected observation
                    {
                        historyKey: "hist_obs:near-dup-rejected",
                        subject: `group:${chatId}`,
                        content: "群友常常在深夜吐槽工作太累",
                        category: "general",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                    // Attempt overwrite of approved fact
                    {
                        historyKey: approvedObsKey,
                        subject: `group:${chatId}`,
                        content: "试图覆盖已通过的观察",
                        category: "general",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                    // Attempt overwrite of edited (auto-approved) fact
                    {
                        historyKey: editObsKey,
                        subject: `group:${chatId}`,
                        content: "试图覆盖人工校对后的观察",
                        category: "general",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                ],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(chatId, l2.ownerToken);
            assert.equal(commitBlocked.factsCommitted, 0);
            assert.equal(mem.getFactById(editObsRow.id)?.content, "人工校对后的群观察内容");

            // Pre-commit dedupe in initialize.ts:
            // 1) Rejected items must NOT appear in synthesis prompt's 已有记录
            // 2) Rejected items proposed by LLM must NOT eat into per-unit caps (6 memes, 3 observations)
            let capturedPrompt = "";
            const llmCall: HistoryLlmCallFn = async (opts) => {
                capturedPrompt = opts.messages[1].content;
                return {
                    content: JSON.stringify({
                        groupUpdates: { evidence: [] },
                        memberProfiles: [],
                        memes: [
                            // First item overlaps rejected variant "老梗一" -> must be skipped BEFORE cap!
                            { term: "老梗一 / 变体乙", meaning: "已拒换壳", usageBoundaries: "测", topicId, messageIds: ["m1", "m2"] },
                            // Next 6 valid memes should ALL fit within MAX_MEMES_PER_SYNTHESIS_UNIT (6)
                            ...["新梗A", "新梗B", "新梗C", "新梗D", "新梗E", "新梗F"].map(term => ({
                                term,
                                meaning: `${term}含义`,
                                usageBoundaries: "群内",
                                topicId,
                                messageIds: ["m3", "m4"],
                            })),
                        ],
                        groupObservations: [
                            // First item near-duplicates rejected observation -> must be skipped BEFORE cap!
                            { content: "群友常常在深夜吐槽工作太累", topicId, messageIds: ["m1", "m2"] },
                            // Next 3 distinct observations should ALL fit within MAX_OBSERVATIONS_PER_SYNTHESIS_UNIT (3)
                            { content: "周六下午群内常一起联机打副本", topicId, messageIds: ["m3", "m4"] },
                            { content: "成员喜欢分享每日咖啡打卡照片", topicId, messageIds: ["m3", "m4"] },
                            { content: "大家对开源项目部署教程讨论热烈", topicId, messageIds: ["m3", "m4"] },
                        ],
                    }),
                };
            };

            const initRes = await runHistoryInitializationWithMemory(mem, {
                chatId,
                stage: "synthesize",
                config: makeTestConfig(),
                llmCall,
            });
            const alreadyRecordedBlock = capturedPrompt.split("## 历史话题与采样消息")[0] ?? "";
            assert.ok(alreadyRecordedBlock.includes("## 已有记录"));
            assert.equal(alreadyRecordedBlock.includes("老梗一"), false, "Rejected meme must not appear in 已有记录");
            assert.equal(alreadyRecordedBlock.includes("深夜吐槽工作"), false, "Rejected observation must not appear in 已有记录");
            assert.equal(alreadyRecordedBlock.includes("早上互相打招呼"), true, "Approved observation should still appear in 已有记录");
            assert.equal(initRes.factsCommitted, MAX_MEMES_PER_SYNTHESIS_UNIT + MAX_OBSERVATIONS_PER_SYNTHESIS_UNIT);

            // Restore rejected meme -> returns with approved status, FTS-searchable, and stays protected
            assert.equal(mem.reviewHistoryFacts(chatId, "restore", [memeKey]), 1);
            const restoredSearch = mem.searchFacts("原始含义", { includeAllHistory: true });
            assert.equal(restoredSearch.length, 1);
            const approvedList = mem.listHistoryFacts({ chatId, kind: "meme", status: "approved" });
            assert.ok(approvedList.items.some(i => i.historyKey === memeKey && i.status === "approved"));

            // Restore is idempotent if called again after tombstone dropped (returns 0),
            // and if a fact with that key already exists, drops tombstone without failing.
            assert.equal(mem.reviewHistoryFacts(chatId, "restore", [memeKey]), 0);

            // Restored meme stays protected on subsequent commit (same key AND overlapping variant)
            const l3 = mem.acquireHistoryLease(chatId);
            const j3 = mem.upsertHistoryJob({ kind: "initialize", chatId, inputKey: "after-restore", optionsJson: "{}", status: "running" }, l3.ownerToken);
            mem.upsertHistoryUnits(j3.jobId, "synthesize", [{ unitKey: "u3", ordinal: 0, inputJson: "{}" }], l3.ownerToken);
            const afterRestoreCommit = mem.commitHistoricalSynthesisUnit({
                jobId: j3.jobId,
                ownerToken: l3.ownerToken,
                chatId,
                unitKey: "u3",
                rankKey: "2025-W07#0000",
                memberPatches: [],
                factProposals: [
                    {
                        historyKey: memeKey,
                        subject: `group:${chatId}`,
                        content: "[群梗: 老梗一]；真实含义: 被覆盖的新含义；使用边界: 测",
                        category: "anecdote",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                    {
                        historyKey: "hist_meme:overlap-restored",
                        subject: `group:${chatId}`,
                        content: "[群梗: 变体甲 / 另一个词]；真实含义: 重复；使用边界: 测",
                        category: "anecdote",
                        sourceTopicId: topicId,
                        sourceMessageIds: ["m1", "m2"],
                        observedAt: "2025-02-01T10:01:00.000Z",
                    },
                ],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(chatId, l3.ownerToken);
            assert.equal(afterRestoreCommit.factsCommitted, 0);
        } finally {
            cleanupTestMemory(mem, "hist-dash-protect");
        }
    });

    it("3. isolates review/edit from live facts and other chats, and updateFact marks history_review=approved", () => {
        const mem = createTestMemory("hist-dash-isolation");
        const chatA = "onebot:group:30001";
        const chatB = "onebot:group:30002";
        try {
            seedMessages(mem, chatA, [
                { id: "a1", userId: "onebot:1", name: "Alice", text: "你好", ts: "2025-03-01T10:00:00.000Z" },
            ]);
            seedMessages(mem, chatB, [
                { id: "b1", userId: "onebot:2", name: "Bob", text: "世界", ts: "2025-03-01T10:00:00.000Z" },
            ]);
            const topicA = seedClusterTopic(mem, chatA, "hist_topic:a1", "TopicA", ["a1"]);
            const topicB = seedClusterTopic(mem, chatB, "hist_topic:b1", "TopicB", ["b1"]);

            const liveFactId = mem.storeFact(`group:${chatA}`, "实时产生的事实", "general", "live_reflection", undefined, undefined, 0.9, {
                sourceChatId: chatA,
            });

            const lB = mem.acquireHistoryLease(chatB);
            const jB = mem.upsertHistoryJob({ kind: "initialize", chatId: chatB, inputKey: "jb", optionsJson: "{}", status: "running" }, lB.ownerToken);
            mem.upsertHistoryUnits(jB.jobId, "synthesize", [{ unitKey: "ub", ordinal: 0, inputJson: "{}" }], lB.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: jB.jobId,
                ownerToken: lB.ownerToken,
                chatId: chatB,
                unitKey: "ub",
                rankKey: "2025-W09#0000",
                memberPatches: [],
                factProposals: [{
                    historyKey: "hist_obs:chatB_only",
                    subject: `group:${chatB}`,
                    content: "Chat B 的历史观察",
                    category: "general",
                    sourceTopicId: topicB,
                    sourceMessageIds: ["b1"],
                    observedAt: "2025-03-01T10:00:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(chatB, lB.ownerToken);

            const lA = mem.acquireHistoryLease(chatA);
            const jA = mem.upsertHistoryJob({ kind: "initialize", chatId: chatA, inputKey: "ja", optionsJson: "{}", status: "running" }, lA.ownerToken);
            mem.upsertHistoryUnits(jA.jobId, "synthesize", [{ unitKey: "ua", ordinal: 0, inputJson: "{}" }], lA.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: jA.jobId,
                ownerToken: lA.ownerToken,
                chatId: chatA,
                unitKey: "ua",
                rankKey: "2025-W09#0000",
                memberPatches: [],
                factProposals: [{
                    historyKey: "hist_meme:chatA_meme",
                    subject: `group:${chatA}`,
                    content: buildMemeFactContent({
                        term: "原词",
                        meaning: "原含义",
                        originContext: "原背景",
                        participants: ["onebot:1"],
                        usageBoundaries: "原边界",
                        usage: { messages: 4, senders: 2 },
                    }),
                    category: "anecdote",
                    sourceTopicId: topicA,
                    sourceMessageIds: ["a1"],
                    observedAt: "2025-03-01T10:00:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            mem.releaseHistoryLease(chatA, lA.ownerToken);

            // Attempt to review chatB's key or liveFactId under chatA -> 0 affected, both untouched
            assert.equal(mem.reviewHistoryFacts(chatA, "reject", ["hist_obs:chatB_only", liveFactId]), 0);
            assert.equal(mem.reviewHistoryFacts(chatA, "approve", ["hist_obs:chatB_only", liveFactId]), 0);
            assert.equal(mem.editHistoryFact({ chatId: chatA, historyKey: "hist_obs:chatB_only", content: "hack" }).status, "not_found");
            assert.equal(mem.editHistoryFact({ chatId: chatA, historyKey: liveFactId, content: "hack" }).status, "not_found");
            assert.equal(mem.getFactById(liveFactId)?.content, "实时产生的事实");
            assert.equal(mem.listHistoryFacts({ chatId: chatB, kind: "observation", status: "pending" }).total, 1);

            // Structured edit of meme preserves participants and usage counts
            const editedMeme = mem.editHistoryFact({
                chatId: chatA,
                historyKey: "hist_meme:chatA_meme",
                meme: {
                    term: "新词",
                    meaning: "新含义",
                    originContext: "新背景",
                    usageBoundaries: "新边界",
                },
            });
            assert.equal(editedMeme.status, "ok");
            assert.equal(editedMeme.item.status, "approved");
            assert.deepEqual(editedMeme.item.meme?.participants.map(p => p.userId), ["onebot:1"]);
            assert.deepEqual(editedMeme.item.meme?.usage, { messages: 4, senders: 2 });

            // Old updateFact on live fact keeps historyReview null; on historical fact marks approved
            mem.updateFact(liveFactId, { content: "实时产生的事实2" });
            assert.equal(mem.getFactById(liveFactId)?.historyReview, null);

            const chatBFact = mem.listCoreFacts({ sourceChatId: chatB, includeAllHistory: true }).items[0];
            mem.updateFact(chatBFact.id, { content: "通过旧接口修改" });
            assert.equal(mem.getFactById(chatBFact.id)?.historyReview, "approved");
        } finally {
            cleanupTestMemory(mem, "hist-dash-isolation");
        }
    });

    it("4. runner enforces single concurrency, private consent, stop-resume, and cross-job reuse without options error", async () => {
        const mem = createTestMemory("hist-dash-runner");
        const pubChat = "onebot:group:40001";
        const privChat = "telegram:999888";
        try {
            seedMessages(mem, pubChat, [
                { id: "p1", userId: "onebot:1", name: "Alice", text: "第一段讨论", ts: "2025-04-01T10:00:00.000Z" },
                { id: "p2", userId: "onebot:2", name: "Bob", text: "第一段回复", ts: "2025-04-01T10:02:00.000Z" },
            ]);
            seedMessages(mem, privChat, [
                { id: "dm1", userId: "telegram:999888", name: "User", text: "私聊内容", ts: "2025-04-01T10:00:00.000Z" },
            ]);

            let releaseBlock: (() => void) | null = null;
            let llmCallCount = 0;
            const blockingLlm: HistoryLlmCallFn = async (opts) => {
                llmCallCount++;
                if (opts.stage === "cluster") {
                    if (releaseBlock) {
                        await new Promise<void>((resolve, reject) => {
                            const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                            if (opts.abortSignal?.aborted) { onAbort(); return; }
                            opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
                            releaseBlock = () => {
                                opts.abortSignal?.removeEventListener("abort", onAbort);
                                resolve();
                            };
                        });
                    }
                    const ids = [...opts.messages[1].content.matchAll(/\[(p\d+)\]/g)].map(m => m[1]);
                    return {
                        content: JSON.stringify({ topics: [{ tempId: "t1", label: "Topic", messageIds: ids }] }),
                    };
                }
                if (opts.stage === "summary") {
                    return {
                        content: JSON.stringify({
                            summaries: [{ tempId: "t_1", label: "Topic", summary: "sum", keyPoints: [], keywords: [], sentiment: "neutral" }],
                        }),
                    };
                }
                return { content: JSON.stringify({ groupUpdates: { evidence: [] }, memberProfiles: [], memes: [], groupObservations: [] }) };
            };

            const runner = new HistoryInitRunner({
                memory: mem,
                getConfig: () => makeTestConfig(),
                llmCall: blockingLlm,
            });

            // Private chat without consent rejected before starting
            const privDenied = runner.start({ chatId: privChat, mode: "quick" });
            assert.deepEqual(privDenied, { ok: false, error: "private_consent_required" });
            assert.equal(runner.current(), null);

            // Start public chat in background and block on first cluster call
            releaseBlock = () => {}; // non-null sentinel so blocking branch triggers
            const started = runner.start({ chatId: pubChat, mode: "quick" });
            assert.equal(started.ok, true);
            assert.equal(runner.current()?.chatId, pubChat);

            // Second concurrent start refused
            const busy = runner.start({ chatId: privChat, mode: "quick", allowPrivateLlm: true });
            assert.equal(busy.ok, false);
            if (!busy.ok && busy.error === "busy") {
                assert.equal(busy.running.chatId, pubChat);
            }

            // Wait one tick so cluster call registers abort listener, then stop(pubChat)
            await new Promise(r => setTimeout(r, 30));
            assert.equal(runner.stop(pubChat), true);
            await runner.waitForIdle();
            assert.equal(runner.current(), null);
            assert.equal(mem.findLatestHistoryJob("initialize", pubChat)?.status, "paused");

            // Resume with same mode -> uses resume: true and completes
            releaseBlock = null;
            const resumed = runner.start({ chatId: pubChat, mode: "quick" });
            assert.equal(resumed.ok, true);
            if (resumed.ok) {
                assert.equal(resumed.resume, true);
            }
            await runner.waitForIdle();
            assert.equal(mem.findLatestHistoryJob("initialize", pubChat)?.status, "done");

            // Now simulate a paused job from CLI with custom options (windowMessages=60) and start runner with mode="quick":
            // runner must NOT throw "options changed, cannot --resume" and must NOT redo already-completed synthesis!
            const leaseCustom = mem.acquireHistoryLease(pubChat);
            const customJob = mem.upsertHistoryJob({
                kind: "initialize",
                chatId: pubChat,
                inputKey: "init:quick:::60:4:30:10",
                optionsJson: JSON.stringify({ mode: "quick", stage: "all", windowMessages: 60 }),
                status: "paused",
                progressJson: JSON.stringify({ error: "interrupted" }),
            }, leaseCustom.ownerToken);
            mem.releaseHistoryLease(pubChat, leaseCustom.ownerToken);
            assert.ok(customJob.jobId);

            const callsBeforeFull = llmCallCount;
            const fullStart = runner.start({ chatId: pubChat, mode: "full" });
            assert.equal(fullStart.ok, true);
            if (fullStart.ok) {
                assert.equal(fullStart.resume, false);
            }
            await runner.waitForIdle();
            assert.equal(mem.findLatestHistoryJob("initialize", pubChat)?.status, "done");
            // All messages were already covered AND synthesis unit was already completed -> 0 new LLM calls!
            assert.equal(llmCallCount, callsBeforeFull);
        } finally {
            cleanupTestMemory(mem, "hist-dash-runner");
        }
    });

    it("5. API routes validate inputs, report stale status, estimate in-process WAL, and resolve evidence missing count", async () => {
        const mem = createTestMemory("hist-dash-routes");
        const chatId = "onebot:group:50001";
        let server: http.Server | null = null;
        try {
            seedMessages(mem, chatId, [
                { id: "e1", userId: "onebot:10", name: "RawAlice", text: "原文一", ts: "2025-05-01T10:00:00.000Z" },
                { id: "e2", userId: "onebot:20", name: "RawBob", text: "原文二", ts: "2025-05-01T10:01:00.000Z", blocked: true },
            ]);
            // Chat-local name override for onebot:10
            mem.insertChatNameObservations([{
                chatId,
                messageId: "e1",
                userId: "onebot:10",
                kind: "sender_card",
                displayName: "群名片Alice",
                observedAt: "2025-05-01T10:05:00.000Z",
            }]);

            const topicId = seedClusterTopic(mem, chatId, "hist_topic:e1", "证据话题", ["e1"]);

            // Seed a stale 'running' job (expired lease, runner not running it)
            const lease = mem.acquireHistoryLease(chatId, 100);
            const staleJob = mem.upsertHistoryJob({
                kind: "initialize",
                chatId,
                inputKey: "init:quick:::::120:4:30:10",
                optionsJson: JSON.stringify({ mode: "quick", stage: "all" }),
                status: "running",
            }, lease.ownerToken);
            mem.upsertHistoryUnits(staleJob.jobId, "synthesize", [{ unitKey: "s1", ordinal: 0, inputJson: "{}" }], lease.ownerToken);
            mem.commitHistoricalSynthesisUnit({
                jobId: staleJob.jobId,
                ownerToken: lease.ownerToken,
                chatId,
                unitKey: "s1",
                rankKey: "2025-W18#0000",
                memberPatches: [],
                factProposals: [{
                    historyKey: "hist_meme:ev1",
                    subject: `group:${chatId}`,
                    content: buildMemeFactContent({
                        term: "好梗",
                        meaning: "测试含义",
                        participants: ["onebot:10"],
                        usageBoundaries: "群内",
                        usage: { messages: 2, senders: 2 },
                    }),
                    category: "anecdote",
                    sourceTopicId: topicId,
                    sourceMessageIds: ["e1"],
                    observedAt: "2025-05-01T10:00:00.000Z",
                }],
                outputJson: "{}",
                isPrivateOrSensitive: false,
            });
            // Expire lease in DB while leaving job status='running'
            (mem as any).db.prepare("UPDATE history_leases SET expires_at_ms = 1 WHERE chat_id = ?").run(chatId);
            // Also inject a missing + blocked messageId into source_message_ids to test missing count
            (mem as any).db.prepare("UPDATE core_facts SET source_message_ids = ? WHERE history_key = ?")
                .run(JSON.stringify(["e1", "e2", "deleted_msg"]), "hist_meme:ev1");

            const runner = new HistoryInitRunner({
                memory: mem,
                getConfig: () => makeTestConfig(),
            });

            const deps = {
                memory: mem,
                historyRunner: runner,
            } as unknown as DashboardDeps;
            const fakeBridge = {
                buildSnapshot: () => ({}),
                broadcast: () => {},
                llmLogBuffer: {},
            } as unknown as EventBridge;

            const app = express();
            app.use(express.json());
            app.use("/api", createApiRouter(deps, fakeBridge));
            server = http.createServer(app);
            await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
            const addr = server.address() as { port: number };
            const baseUrl = `http://127.0.0.1:${addr.port}/api`;

            const overviewRes = await fetch(`${baseUrl}/history/overview`);
            assert.equal(overviewRes.status, 200);
            const overview = await overviewRes.json() as {
                runner: { running: HistoryRunnerRunningInfo | null };
                chats: Array<{ chatId: string; initJob: { status: string; resumable: boolean } | null }>;
            };
            assert.equal(overview.runner.running, null);
            const chatOverview = overview.chats.find(c => c.chatId === chatId)!;
            assert.equal(chatOverview.initJob?.status, "stale");
            assert.equal(chatOverview.initJob?.resumable, true);

            // In-process WAL estimate (must not call LLM or write DB)
            const estRes = await fetch(`${baseUrl}/history/init/estimate`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chatId, mode: "quick" }),
            });
            assert.equal(estRes.status, 200);
            const est = await estRes.json() as Record<string, unknown>;
            assert.equal(est.eligibleMessages, 1);
            assert.equal(est.estimatedClusterCalls, 0);
            assert.equal(est.estimatedSynthesisCalls, 1);

            // Evidence lookup resolves chat-local displayName and counts missing + blocked messages
            const evRes = await fetch(`${baseUrl}/history/evidence?chatId=${encodeURIComponent(chatId)}&historyKey=hist_meme:ev1`);
            assert.equal(evRes.status, 200);
            const ev = await evRes.json() as {
                topic: { id: string; label: string; summary: string } | null;
                messages: Array<{ messageId: string; displayName: string }>;
                missing: number;
            };
            assert.equal(ev.topic?.label, "证据话题");
            assert.equal(ev.messages.length, 1);
            assert.equal(ev.messages[0].displayName, "群名片Alice");
            assert.equal(ev.missing, 2);

            // Validation checks: unknown kind/status/action/mode -> 400; historyKeys > 500 -> 400
            const badKind = await fetch(`${baseUrl}/history/facts?chatId=${encodeURIComponent(chatId)}&kind=bogus`);
            assert.equal(badKind.status, 400);
            const badStatus = await fetch(`${baseUrl}/history/facts?chatId=${encodeURIComponent(chatId)}&status=bogus`);
            assert.equal(badStatus.status, 400);
            const badMode = await fetch(`${baseUrl}/history/init/start`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chatId, mode: "bogus" }),
            });
            assert.equal(badMode.status, 400);
            const badAction = await fetch(`${baseUrl}/history/facts/review`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chatId, action: "bogus", historyKeys: ["k1"] }),
            });
            assert.equal(badAction.status, 400);
            const tooManyKeys = await fetch(`${baseUrl}/history/facts/review`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    chatId,
                    action: "approve",
                    historyKeys: Array.from({ length: 501 }, (_, i) => `k_${i}`),
                }),
            });
            assert.equal(tooManyKeys.status, 400);
        } finally {
            if (server) {
                await new Promise<void>(resolve => server!.close(() => resolve()));
            }
            cleanupTestMemory(mem, "hist-dash-routes");
        }
    });

    it("6. resuming a paused quick job finishes its exact planned units without re-planning new quick windows", async () => {
        const mem = createTestMemory("hist-dash-resume-plan");
        const chatId = "onebot:group:60001";
        try {
            // Create 14 distinct windows (separated by 2h > 30m gap), with varying message counts
            // so quick mode selects <= 12 (here 10-12) windows, leaving >= 2 uncovered windows.
            const baseMs = Date.parse("2025-01-06T00:00:00.000Z");
            const entries: Array<{ id: string; userId: string; name: string; text: string; ts: string }> = [];
            for (let w = 0; w < 14; w++) {
                // w=0..7 have descending counts 20..13; w=8..13 have 10..11 msgs (most recent) -> quick selects 8..12 windows < 14
                const count = w < 8 ? 20 - w : 10;
                const wStart = baseMs + w * 2 * 3_600_000;
                for (let j = 0; j < count; j++) {
                    entries.push({
                        id: `rw_${w}_${j}`,
                        userId: j % 2 === 0 ? "onebot:1" : "onebot:2",
                        name: j % 2 === 0 ? "Alice" : "Bob",
                        text: `win ${w} msg ${j}`,
                        ts: new Date(wStart + j * 1000).toISOString(),
                    });
                }
            }
            seedMessages(mem, chatId, entries);

            let clusterCallCount = 0;
            let stopAfterClusters = 7;
            const runnerHolder: { runner?: HistoryInitRunner } = {};

            const llmCall: HistoryLlmCallFn = async (opts) => {
                if (opts.stage === "cluster") {
                    clusterCallCount++;
                    const ids = [...opts.messages[1].content.matchAll(/\[(rw_[^\]]+)\]/g)].map(m => m[1]);
                    return {
                        content: JSON.stringify({
                            topics: [{ tempId: "t1", label: `Topic_${clusterCallCount}`, messageIds: ids }],
                        }),
                    };
                }
                if (opts.stage === "summary") {
                    if (stopAfterClusters > 0 && clusterCallCount >= stopAfterClusters) {
                        // Trigger stop right after finishing the k-th cluster unit's LLM work -> abort on next window
                        runnerHolder.runner?.stop(chatId);
                    }
                    return {
                        content: JSON.stringify({
                            summaries: [{ tempId: "t_1", label: `Topic_${clusterCallCount}`, summary: "sum", keyPoints: [], keywords: [], sentiment: "neutral" }],
                        }),
                    };
                }
                return { content: JSON.stringify({ groupUpdates: { evidence: [] }, memberProfiles: [], memes: [], groupObservations: [] }) };
            };

            const runner = new HistoryInitRunner({
                memory: mem,
                getConfig: () => makeTestConfig(),
                llmCall,
            });
            runnerHolder.runner = runner;

            const start1 = runner.start({ chatId, mode: "quick" });
            assert.equal(start1.ok, true);
            await runner.waitForIdle();

            const pausedJob = mem.findLatestHistoryJob("initialize", chatId)!;
            assert.equal(pausedJob.status, "paused");
            const unitsAfterStop = mem.listHistoryUnits(pausedJob.jobId, "cluster");
            const plannedCount = unitsAfterStop.length;
            assert.ok(plannedCount >= 8 && plannedCount <= 12, `expected 8..12 quick planned units, got ${plannedCount}`);
            assert.equal(unitsAfterStop.filter(u => u.completedAt !== null).length, 7);

            // Check manual stop message is Chinese, not raw English abort
            const overviewWhilePaused = mem.getHistoryOverviewChats(null).find(c => c.chatId === chatId)!;
            assert.equal(overviewWhilePaused.initJob?.status, "paused");
            assert.equal(overviewWhilePaused.initJob?.resumable, true);
            assert.equal(overviewWhilePaused.initJob?.error, "已在面板中手动停止");

            // Resume via runner -> finishes ONLY the remaining (plannedCount - 7) units, NO extra windows added!
            stopAfterClusters = 0;
            const start2 = runner.start({ chatId, mode: "quick" });
            assert.equal(start2.ok, true);
            if (start2.ok) assert.equal(start2.resume, true);
            await runner.waitForIdle();

            const finishedJob = mem.findLatestHistoryJob("initialize", chatId)!;
            assert.equal(finishedJob.status, "done");
            assert.equal(finishedJob.jobId, pausedJob.jobId);
            const unitsAfterResume = mem.listHistoryUnits(finishedJob.jobId, "cluster");
            assert.equal(unitsAfterResume.length, plannedCount, "Resume must NOT add new cluster units beyond original plan");
            assert.equal(unitsAfterResume.filter(u => u.completedAt !== null).length, plannedCount);

            // Coverage must equal ONLY the messages in those original plannedCount windows
            const expectedCoveredCount = unitsAfterResume.reduce((acc, u) => {
                const parsed = JSON.parse(u.inputJson) as { messageIds: string[] };
                return acc + parsed.messageIds.length;
            }, 0);
            assert.equal(mem.getCoveredMessageIds(chatId).size, expectedCoveredCount);
            assert.ok(expectedCoveredCount < entries.length, "Uncovered windows outside initial quick plan must remain uncovered");

            // A plain non-resume second quick run (after done) still processes the remaining uncovered windows!
            const start3 = runner.start({ chatId, mode: "quick" });
            assert.equal(start3.ok, true);
            if (start3.ok) assert.equal(start3.resume, false);
            await runner.waitForIdle();
            assert.equal(mem.getCoveredMessageIds(chatId).size, entries.length);
        } finally {
            cleanupTestMemory(mem, "hist-dash-resume-plan");
        }
    });

    it("7. initJob.updatedAt tracks latest completed unit timestamp while running", () => {
        const mem = createTestMemory("hist-dash-updated-at");
        const chatId = "onebot:group:70001";
        try {
            const lease = mem.acquireHistoryLease(chatId);
            const job = mem.upsertHistoryJob({
                kind: "initialize",
                chatId,
                inputKey: "init:quick:::::120:4:30:10",
                optionsJson: JSON.stringify({ mode: "quick", stage: "all" }),
                status: "running",
            }, lease.ownerToken);
            mem.upsertHistoryUnits(job.jobId, "cluster", [
                { unitKey: "c1", ordinal: 0, inputJson: "{}" },
                { unitKey: "c2", ordinal: 1, inputJson: "{}" },
            ], lease.ownerToken);

            // Backdate job row updated_at and set a newer completed_at on unit c1
            const olderJobTs = "2025-01-01T00:00:00.000Z";
            const newerUnitTs = "2025-01-01T00:05:30.000Z";
            (mem as any).db.prepare("UPDATE history_jobs SET updated_at = ? WHERE job_id = ?").run(olderJobTs, job.jobId);
            (mem as any).db.prepare("UPDATE history_units SET completed_at = ?, output_json = '{}' WHERE job_id = ? AND unit_key = ?")
                .run(newerUnitTs, job.jobId, "c1");

            const overview = mem.getHistoryOverviewChats(chatId).find(c => c.chatId === chatId)!;
            assert.equal(overview.initJob?.status, "running");
            assert.equal(overview.initJob?.updatedAt, newerUnitTs);
        } finally {
            cleanupTestMemory(mem, "hist-dash-updated-at");
        }
    });

    it("8. estimate scales synthesis calls by estimated topics per ISO week for both in-process dry-run and CLI dry-run", async () => {
        const mem = createTestMemory("hist-dash-estimate");
        const chatId = "onebot:group:80001";
        try {
            // Simulate ~2600 messages across 50 windows over 10 ISO weeks (~52 msgs/window, separated by 3h gaps)
            assert.ok(ESTIMATED_MESSAGES_PER_TOPIC >= 10 && ESTIMATED_MESSAGES_PER_TOPIC <= 11);
            const baseMs = Date.parse("2025-01-06T00:00:00.000Z");
            const entries: Array<{ id: string; userId: string; name: string; text: string; ts: string }> = [];
            let seq = 0;
            for (let week = 0; week < 10; week++) {
                const weekStart = baseMs + week * 7 * 86_400_000;
                for (let w = 0; w < 5; w++) {
                    const winStart = weekStart + w * 6 * 3_600_000;
                    // Spread large (~100-110 msg) windows across weeks and smaller (~35 msg) recent windows
                    // so quick mode selects 6 largest + 6 most recent (~850-1000 msgs) across multiple weeks.
                    const count = (w === 0 && week < 6) ? 110 - week : (week >= 8 ? 50 : 45);
                    for (let j = 0; j < count; j++) {
                        entries.push({
                            id: `est_${seq++}`,
                            userId: j % 2 === 0 ? "onebot:1" : "onebot:2",
                            name: j % 2 === 0 ? "Alice" : "Bob",
                            text: `msg ${seq}`,
                            ts: new Date(winStart + j * 1000).toISOString(),
                        });
                    }
                }
            }
            seedMessages(mem, chatId, entries);

            const quickEst = await runHistoryInitializationWithMemory(mem, {
                chatId,
                mode: "quick",
                stage: "all",
                dryRun: true,
                config: makeTestConfig(),
            });
            const fullEst = await runHistoryInitializationWithMemory(mem, {
                chatId,
                mode: "full",
                stage: "all",
                dryRun: true,
                config: makeTestConfig(),
            });

            // Quick selects 12 windows (~624 msgs -> ~60 topics across multiple weeks -> ~10-16 synth calls, NOT 2)
            assert.equal(quickEst.selectedWindows, 12);
            assert.ok(
                quickEst.estimatedSynthesisCalls >= 10 && quickEst.estimatedSynthesisCalls <= 18,
                `quick estimatedSynthesisCalls=${quickEst.estimatedSynthesisCalls} should be near ~12-16`,
            );

            // Full selects 50 windows (2600 msgs -> ~250 topics across 10 weeks -> ~35-40 synth calls, NOT 9)
            assert.equal(fullEst.selectedWindows, 50);
            assert.ok(
                fullEst.estimatedSynthesisCalls >= 30 && fullEst.estimatedSynthesisCalls <= 45,
                `full estimatedSynthesisCalls=${fullEst.estimatedSynthesisCalls} should be near ~31-40`,
            );

            // CLI read-only dry-run uses the exact same formula
            const dbPath = (mem as any).db.name as string;
            mem.close();
            const cliFullEst = await runHistoryInitialization({
                chatId,
                mode: "full",
                stage: "all",
                dryRun: true,
                qceOptions: { dbPath },
                config: makeTestConfig(),
            });
            assert.equal(cliFullEst.estimatedSynthesisCalls, fullEst.estimatedSynthesisCalls);
        } finally {
            cleanupTestMemory(mem, "hist-dash-estimate");
        }
    });
});
