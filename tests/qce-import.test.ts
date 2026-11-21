import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createMemoryApi } from "../src/meta-sandbox/meta-api/memory.js";
import { HistoryLeaseError } from "../src/memory-v2/index.js";
import { dryRunQceImport, importQce } from "../src/history/qce-import.js";
import { normalizeQceMessage, normalizeQceTimestamp, parsePositiveDecimalUin } from "../src/history/qce-normalize.js";
import { stageQceExport } from "../src/history/qce-reader.js";
import { stripForwardedBodyText } from "../src/history/windows.js";
import { cleanupTestMemory, createTestMemory, testDbPath } from "./helpers/test-db.js";

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDirSafe(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

describe("QCE historical importer", () => {
    it("streams single JSON when chatInfo and metadata appear after a large avatars payload", async () => {
        const dir = makeTempDir("qce-stream-order-");
        const mem = createTestMemory("qce-stream-order");
        try {
            const hugeAvatar = "A".repeat(512 * 1024);
            const hugeHtml = "<div>" + "B".repeat(256 * 1024) + "</div>";
            const jsonPath = path.join(dir, "export.json");
            const payload = {
                avatars: {
                    "u_100": hugeAvatar,
                    "u_200": hugeAvatar,
                },
                messages: [
                    {
                        id: "1001",
                        timestamp: 1714521600000,
                        sender: {
                            uid: "u_100",
                            uin: "10001",
                            nickname: "AliceNick",
                            groupCard: "AliceCard",
                            avatarBase64: hugeAvatar,
                        },
                        content: {
                            text: "hello streaming",
                            html: hugeHtml,
                        },
                        rawMessage: { massive: hugeAvatar },
                    },
                ],
                chatInfo: {
                    name: "Late Title Group",
                    type: "group",
                    peerUid: "900001",
                    avatar: hugeAvatar,
                },
                metadata: {
                    name: "QCE",
                    version: "5.0.0",
                },
            };
            fs.writeFileSync(jsonPath, JSON.stringify(payload), "utf8");

            const summary = await importQce(mem, jsonPath, { timezone: "Asia/Shanghai" });
            assert.equal(summary.format, "json");
            assert.equal(summary.chatId, "onebot:group:900001");
            assert.equal(summary.chatTitle, "Late Title Group");
            assert.equal(summary.inserted, 1);

            const gm = mem.getGroupModel("onebot:group:900001");
            assert.equal(gm?.chatTitle, "Late Title Group");
            const msgs = mem.getRecentMessages("onebot:group:900001", 10);
            assert.equal(msgs.length, 1);
            assert.equal(msgs[0].text, "hello streaming");
        } finally {
            cleanupTestMemory(mem, "qce-stream-order");
            rmDirSafe(dir);
        }
    });

    it("unifies UID->UIN across messages, fails on conflicting UINs unless --user-map resolves, and rejects map disagreement", async () => {
        const dir = makeTempDir("qce-uid-uin-");
        const mem = createTestMemory("qce-uid-uin");
        try {
            // Case 1: UID seen on message #1 before UIN appears on message #2 -> single identity onebot:22222
            const jsonUnified = path.join(dir, "unified.json");
            fs.writeFileSync(jsonUnified, JSON.stringify({
                chatInfo: { name: "UID Group", type: "group", uin: "88001" },
                messages: [
                    {
                        id: "m1",
                        timestamp: 1714521600,
                        sender: { uid: "u_bob", nickname: "BobFirst" },
                        content: { text: "before uin" },
                    },
                    {
                        id: "m2",
                        timestamp: 1714521660,
                        sender: { uid: "u_bob", uin: "22222", nickname: "BobSecond" },
                        content: { text: "with uin" },
                    },
                ],
            }), "utf8");

            const res1 = await importQce(mem, jsonUnified, { timezone: "UTC" });
            assert.equal(res1.inserted, 2);
            assert.equal(res1.uniqueSenders, 1);
            assert.equal(res1.uidResolution.resolvedUids, 1);
            assert.equal(res1.uidResolution.unresolvedUids, 0);

            const msgs = mem.getRecentMessages("onebot:group:88001", 10);
            assert.ok(msgs.every(m => m.userId === "onebot:22222"));
            assert.equal(mem.getPersonIdentity("onebot:22222")?.totalMessageCount, 2);
            assert.equal(mem.getPersonIdentity("onebot:uid:u_bob"), null);

            // Case 2: Conflicting UINs for same UID fails preflight
            const jsonConflict = path.join(dir, "conflict.json");
            fs.writeFileSync(jsonConflict, JSON.stringify({
                chatInfo: { name: "Conflict Group", type: "group", uin: "88002" },
                messages: [
                    { id: "c1", timestamp: 1714521600, sender: { uid: "u_x", uin: "11111", name: "A" }, content: { text: "1" } },
                    { id: "c2", timestamp: 1714521610, sender: { uid: "u_x", uin: "99999", name: "A" }, content: { text: "2" } },
                ],
            }), "utf8");

            await assert.rejects(
                () => importQce(mem, jsonConflict, { timezone: "UTC" }),
                /Conflicting QQ UIN observations/i,
            );

            // Resolving conflict with --user-map succeeds
            const goodMapPath = path.join(dir, "good-map.json");
            fs.writeFileSync(goodMapPath, JSON.stringify({ u_x: "11111" }), "utf8");
            const resolvedConflict = await importQce(mem, jsonConflict, { timezone: "UTC", userMapPath: goodMapPath });
            assert.equal(resolvedConflict.inserted, 2);

            // Disagreement between --user-map and unambiguous explicit UIN fails
            const badMapPath = path.join(dir, "bad-map.json");
            fs.writeFileSync(badMapPath, JSON.stringify({ u_bob: "77777" }), "utf8");
            await assert.rejects(
                () => importQce(mem, jsonUnified, { timezone: "UTC", userMapPath: badMapPath }),
                /disagrees with explicit observed UIN/i,
            );
        } finally {
            cleanupTestMemory(mem, "qce-uid-uin");
            rmDirSafe(dir);
        }
    });

    it("handles chunked JSONL ordering, traversal/symlink rejection, malformed lines, and unsupported formats", async () => {
        const dir = makeTempDir("qce-chunked-");
        const mem = createTestMemory("qce-chunked");
        try {
            const exportDir = path.join(dir, "export");
            const chunksDir = path.join(exportDir, "chunks");
            fs.mkdirSync(chunksDir, { recursive: true });

            // Notice filenames are reverse alphabetical order vs numeric index!
            const chunk1 = path.join(chunksDir, "z-first.jsonl");
            const chunk2 = path.join(chunksDir, "a-second.jsonl");

            const secretSecretText = "TOP_SECRET_LINE_CONTENT_DO_NOT_LEAK";
            fs.writeFileSync(
                chunk1,
                "\uFEFF"
                + JSON.stringify({ id: "m1", type: "type_1", timestamp: 1714521600000, sender: { uin: "30001", name: "C1" }, content: { text: "chunk1 ok" } })
                + "\r\n"
                + `{broken json ${secretSecretText}\n`,
                "utf8",
            );
            fs.writeFileSync(
                chunk2,
                JSON.stringify({ id: "m2", timestamp: 1714521700000, sender: { uin: "30002", name: "C2" }, content: { text: "chunk2 ok" } }), // no trailing newline
                "utf8",
            );

            fs.writeFileSync(path.join(exportDir, "manifest.json"), JSON.stringify({
                chatInfo: { name: "Chunked Group", type: "group", peerUid: "900002", peerUin: "900002" },
                chunked: {
                    format: "jsonl",
                    chunksDir: "chunks",
                    chunks: [
                        { index: 2, file: "a-second.jsonl" },
                        { index: 1, file: "z-first.jsonl" },
                    ],
                },
            }), "utf8");

            const res = await importQce(mem, exportDir, { timezone: "UTC" });
            assert.equal(res.format, "jsonl-chunked");
            assert.equal(res.inserted, 2);
            assert.equal(res.malformedLines.length, 1);
            assert.equal(res.malformedLines[0].chunkFile, "z-first.jsonl");
            assert.equal(res.malformedLines[0].lineNumber, 2);
            assert.equal(res.malformedLines[0].reason, "malformed_json");
            assert.ok(!JSON.stringify(res).includes(secretSecretText), "Malformed line warning must never leak raw message text");

            // Path traversal rejection
            const traversalDir = path.join(dir, "traversal");
            fs.mkdirSync(traversalDir, { recursive: true });
            fs.writeFileSync(path.join(dir, "outside.jsonl"), "{}\n", "utf8");
            fs.writeFileSync(path.join(traversalDir, "manifest.json"), JSON.stringify({
                chatInfo: { name: "Evil", type: "group", uin: "900003" },
                chunked: { format: "jsonl", chunks: [{ index: 1, file: "../outside.jsonl" }] },
            }), "utf8");
            await assert.rejects(() => importQce(mem, traversalDir, { timezone: "UTC" }), /traversal|escapes/i);

            // Symlink escaping export dir rejection
            const symlinkDir = path.join(dir, "symlink-export");
            fs.mkdirSync(symlinkDir, { recursive: true });
            fs.symlinkSync(path.join(dir, "outside.jsonl"), path.join(symlinkDir, "link.jsonl"));
            fs.writeFileSync(path.join(symlinkDir, "manifest.json"), JSON.stringify({
                chatInfo: { name: "Symlink", type: "group", uin: "900004" },
                chunked: { format: "jsonl", chunks: [{ index: 1, file: "link.jsonl" }] },
            }), "utf8");
            await assert.rejects(() => importQce(mem, symlinkDir, { timezone: "UTC" }), /escapes/i);

            // Unsupported formats: manifest.js, .html, .txt
            const htmlDir = path.join(dir, "modern-html");
            fs.mkdirSync(path.join(htmlDir, "data"), { recursive: true });
            fs.writeFileSync(path.join(htmlDir, "data", "manifest.js"), "window.__MANIFEST__={}", "utf8");
            await assert.rejects(() => importQce(mem, htmlDir, { timezone: "UTC" }), /JSON or chunked JSONL/i);

            const htmlFile = path.join(dir, "chat.html");
            fs.writeFileSync(htmlFile, "<html></html>", "utf8");
            await assert.rejects(() => importQce(mem, htmlFile, { timezone: "UTC" }), /JSON or chunked JSONL/i);

            const txtFile = path.join(dir, "chat.txt");
            fs.writeFileSync(txtFile, "hello", "utf8");
            await assert.rejects(() => importQce(mem, txtFile, { timezone: "UTC" }), /JSON or chunked JSONL/i);
        } finally {
            cleanupTestMemory(mem, "qce-chunked");
            rmDirSafe(dir);
        }
    });

    it("normalizes timestamps, IDs, forwards, replies, media, chatNames, and DM sensitivity correctly", async () => {
        // Direct unit checks on pure normalizer
        assert.equal(parsePositiveDecimalUin("123456789012345678901"), "123456789012345678901");
        assert.equal(parsePositiveDecimalUin("0"), undefined);

        const tsSec = normalizeQceTimestamp(1714521600, undefined, "Asia/Shanghai");
        assert.equal(tsSec.timeUnknown, false);
        assert.equal(tsSec.iso, "2024-05-01T00:00:00.000Z");

        const tsLocal = normalizeQceTimestamp(0, "2024-05-01 08:30:00", "Asia/Shanghai");
        assert.equal(tsLocal.timeUnknown, false);
        assert.equal(tsLocal.iso, "2024-05-01T00:30:00.000Z");

        const tsUnknown = normalizeQceTimestamp(0, "", "Asia/Shanghai");
        assert.equal(tsUnknown.timeUnknown, true);
        assert.equal(tsUnknown.iso, "1970-01-01T00:00:00.000Z");

        // Real QCE wire shape: everything lives under `data`, stickers are image
        // elements tagged subType, and content.text carries export-only markers.
        const wireOpts = { chatId: "onebot:group:700001", isDirectMessage: false, timezone: "UTC", uidToUin: new Map<string, string>() };
        const wire = (id: string, type: string, text: string, elements: unknown[], resources: unknown[] = []) => {
            const norm = normalizeQceMessage({
                id, timestamp: 1714521600000, type,
                sender: { uin: "1001", nickname: "Nick", groupCard: "Card", remark: "ExporterPrivateRemark" },
                content: { text, elements, resources, mentions: [] },
            } as never, wireOpts);
            assert.equal(norm.status, "ok");
            return norm.status === "ok" ? norm.message : undefined;
        };
        const stickerMsg = wire("w1", "text", "[图片:AB12.png]", [
            { type: "image", data: { filename: "AB12.png", size: 10, subType: "sticker" } },
        ], [{ type: "image", filename: "AB12.png", size: 10 }]);
        assert.equal(stickerMsg?.text, "[🎭 表情包]");
        assert.ok(!JSON.stringify(stickerMsg).includes("ExporterPrivateRemark"), "the exporter's remark is never persisted");
        assert.equal(stickerMsg?.mediaType, "sticker");
        assert.deepEqual(JSON.parse(stickerMsg?.mediaInfo ?? "{}").counts, { sticker: 1 });

        const replyMsg = wire("w2", "reply", "[回复消息]@Target 你说[图片:CD34.jpg][流泪]", [
            { type: "reply", data: { referencedMessageId: "w1", senderName: "Card", content: "x" } },
            { type: "at", data: { uin: "1002", name: "Target", atType: 2 } },
            { type: "text", data: { text: " 你说" } },
            { type: "image", data: { filename: "CD34.jpg", subType: "photo" } },
            { type: "face", data: { id: "5", name: "[流泪]" } },
        ]);
        assert.equal(replyMsg?.text, "@Target 你说[📷 图片][流泪]");
        assert.equal(replyMsg?.replyToMessageId, "w1");

        const fileMsg = wire("w3", "file", "[文件:report.pdf]", [{ type: "file", data: { filename: "report.pdf", size: 5 } }]);
        assert.equal(fileMsg?.text, "[📎 文件: report.pdf]");

        // An element type we do not understand keeps QCE's own text rather than dropping content.
        const unknownMsg = wire("w4", "reply", "[回复消息]保留原文", [
            { type: "reply", data: { referencedMessageId: "w1" } },
            { type: "poll", data: { question: "?" } },
        ]);
        assert.equal(unknownMsg?.text, "保留原文");

        // Forwarded speakers are named from the exporter's view (friend remarks included).
        const remarkFwd = wire("w5", "forward", "[转发消息: 3条]\n张三真名: hi\nOther: @张三真名 yo\n张三真名: again", [{
            type: "forward",
            data: {
                messages: [
                    { sender: { uin: "2001", name: "张三真名" }, content: { text: "hi", elements: [{ type: "text", data: { text: "hi" } }] } },
                    { sender: { uin: "2002", name: "Other" }, content: { text: "@张三真名 yo", elements: [{ type: "at", data: { name: "张三真名" } }, { type: "text", data: { text: " yo" } }] } },
                    { sender: { uin: "2001", name: "张三真名" }, content: { text: "again", elements: [{ type: "text", data: { text: "again" } }] } },
                    // QCE reuses one placeholder account for speakers it cannot resolve.
                    { sender: { uin: "2001", name: "Unresolved" }, content: { text: "same uin", elements: [{ type: "text", data: { text: "same uin" } }] } },
                ],
            },
        }]);
        assert.equal(remarkFwd?.text, "[转发聊天记录: 4条] (成员A: hi | 成员B: @成员 yo | 成员A: again | 成员C: same uin)");
        assert.ok(!JSON.stringify(remarkFwd).includes("张三真名"));

        // Forward depth 3 cap + no promotion of nested senders/mentions/replies
        const forwardNorm = normalizeQceMessage({
            id: "fwd1",
            timestamp: 1714521600000,
            sender: { uin: "1001", nickname: "OuterUser" },
            content: {
                elements: [
                    { type: "reply", data: { referencedMessageId: "fwd1" } }, // self-loop stripped
                    { type: "reply", data: { referencedMessageId: "missing-parent" } }, // dangling kept
                    {
                        type: "forward",
                        messages: [
                            {
                                sender: { uin: "9999", nickname: "NestedL1" },
                                content: {
                                    elements: [
                                        { type: "at", uin: "8888", name: "NestedMention" },
                                        {
                                            type: "forward",
                                            messages: [
                                                {
                                                    sender: { uin: "9998", nickname: "NestedL2" },
                                                    content: {
                                                        elements: [
                                                            {
                                                                type: "forward",
                                                                messages: [
                                                                    {
                                                                        sender: { uin: "9997", nickname: "NestedL3" },
                                                                        content: {
                                                                            elements: [
                                                                                {
                                                                                    type: "forward",
                                                                                    messages: [
                                                                                        { sender: { uin: "9996", nickname: "NestedL4TooDeep" }, content: { text: "deep" } },
                                                                                    ],
                                                                                },
                                                                            ],
                                                                        },
                                                                    },
                                                                ],
                                                            },
                                                        ],
                                                    },
                                                },
                                            ],
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                    {
                        type: "file",
                        resource: {
                            type: "file",
                            fileName: "C:\\Users\\alice\\secret\\report.pdf",
                            localPath: "/home/alice/secret/report.pdf",
                            fileId: "SECRET_FILE_ID",
                            fileSize: 4096,
                        },
                    },
                ],
            },
        }, {
            chatId: "onebot:group:555",
            isDirectMessage: false,
            timezone: "Asia/Shanghai",
            uidToUin: new Map(),
        });

        assert.equal(forwardNorm.status, "ok");
        if (forwardNorm.status === "ok") {
            assert.equal(forwardNorm.message.replyToMessageId, "missing-parent");
            assert.equal(forwardNorm.message.mentions?.length, 0, "Nested forward @mentions must not promote to outer message");
            assert.ok(!forwardNorm.message.chatNames?.some(n => n.userId === "onebot:9999" || n.userId === "onebot:8888"));
            assert.ok(!forwardNorm.message.text.includes("NestedL4TooDeep"), "Forward depth must cap at 3");
            assert.ok(forwardNorm.message.mediaInfo);
            assert.ok(!forwardNorm.message.mediaInfo!.includes("SECRET_FILE_ID"));
            assert.ok(!forwardNorm.message.mediaInfo!.includes("/home/alice"));
            assert.ok(!forwardNorm.message.mediaInfo!.includes("C:\\\\Users"));
            assert.ok(forwardNorm.message.mediaInfo!.includes("report.pdf"));
            assert.equal(forwardNorm.message.mediaType, "document");
        }

        // Integration check: invalid IDs, timeUnknown exclusion from date range, resolvePerson chat-scoped card/nick, no remark/title alias leak, DM sensitivity
        const dir = makeTempDir("qce-norm-int-");
        const mem = createTestMemory("qce-norm-int");
        try {
            const groupJson = path.join(dir, "group.json");
            fs.writeFileSync(groupJson, JSON.stringify({
                chatInfo: { name: "Norm Group", type: "group", uin: "700001" },
                messages: [
                    { id: "0", seq: "99", timestamp: 1714521600, sender: { uin: "101", nickname: "InvalidZero" }, content: { text: "skip" } },
                    { id: "   ", seq: "100", timestamp: 1714521600, sender: { uin: "101", nickname: "InvalidBlank" }, content: { text: "skip" } },
                    { id: "m-unknown", timestamp: 0, sender: { uin: "101", nickname: "UnknownTimeUser" }, content: { text: "epoch unknown" } },
                    { id: "m-tie-1", timestamp: 1714525200000, sender: { uin: "101", nickname: "NickOne", groupCard: "CardOne", remark: "SecretRemark", title: "AdminTitle" }, content: { text: "tie first" } },
                    { id: "m-tie-2", timestamp: 1714525200000, sender: { uin: "102", nickname: "NickTwo" }, content: { text: "tie second" } },
                    { id: "m-recalled", timestamp: 1714525300000, recalled: true, sender: { uin: "101", nickname: "NickOne" }, content: { text: "RECALLED_BODY_SECRET" } },
                    { id: "m-system", timestamp: 1714525400000, system: true, content: { text: "Alice joined" } },
                ],
            }), "utf8");

            // With --since, timeUnknown row is excluded
            const filteredRes = await importQce(mem, groupJson, {
                timezone: "UTC",
                since: "2024-05-01T00:00:00Z",
                includeRecalled: true,
                includeSystem: true,
            });
            assert.equal(filteredRes.skippedInvalid, 2);
            assert.equal(filteredRes.skippedDateRange, 1);
            assert.equal(filteredRes.inserted, 4);
            assert.equal(filteredRes.dateRange.unknownTimeCount, 0);

            const recallRow = mem.getMessageById("onebot:group:700001", "m-recalled");
            assert.equal(recallRow?.text, "[已撤回消息]");
            const sysRow = mem.getMessageById("onebot:group:700001", "m-system");
            assert.equal(sysRow?.userId, "system");
            assert.ok(sysRow?.text.startsWith("[系统]"));

            // resolvePerson finds both CardOne and NickOne in that chat without polluting global aliases or indexing remark/title
            const api = createMemoryApi(mem);
            const byCard = await api.resolvePerson("CardOne", { chatId: "onebot:group:700001" });
            assert.equal(byCard.matches[0]?.identity.userId, "onebot:101");
            const byNick = await api.resolvePerson("NickOne", { chatId: "onebot:group:700001" });
            assert.equal(byNick.matches[0]?.identity.userId, "onebot:101");
            const byRemark = await api.resolvePerson("SecretRemark", { chatId: "onebot:group:700001" });
            assert.equal(byRemark.matches.length, 0);
            const byTitle = await api.resolvePerson("AdminTitle", { chatId: "onebot:group:700001" });
            assert.equal(byTitle.matches.length, 0);
            assert.deepEqual(mem.getPersonIdentity("onebot:101")?.aliases, []);

            // DM import forces markedSensitive = true even when dmAutoPrivate is off in config
            const dmJson = path.join(dir, "dm.json");
            fs.writeFileSync(dmJson, JSON.stringify({
                chatInfo: { name: "DM Friend", type: "private", uin: "600001" },
                messages: [
                    { id: "dm1", timestamp: 1714521600000, sender: { uin: "600001", nickname: "DMFriend" }, content: { text: "private hi" } },
                ],
            }), "utf8");
            await importQce(mem, dmJson, { timezone: "UTC" });
            const dmModel = mem.getGroupModel("onebot:private:600001");
            assert.equal(dmModel?.isDirectMessage, true);
            assert.equal(dmModel?.markedSensitive, true);
        } finally {
            cleanupTestMemory(mem, "qce-norm-int");
            rmDirSafe(dir);
        }
    });

    it("supports interruption/resume, overlapping re-import idempotency, lease protection, and preserves live group_models fields", async () => {
        const dir = makeTempDir("qce-resume-");
        const mem = createTestMemory("qce-resume");
        try {
            const chatId = "onebot:group:910001";
            // Pre-populate live group_models metadata that must be preserved after stats recomputation
            mem.upsertGroupModel(chatId, {
                chatTitle: "Live Title",
                description: "Live group description",
                agentRole: "Moderator",
                lastReflectedAt: "2024-04-01T00:00:00.000Z",
                hotTopics: ["Rust", "TypeScript"],
                tabooTopics: ["Spoilers"],
                communicationNorms: ["Be kind"],
                recentFeedback: "Good pacing",
            });

            const jsonPath = path.join(dir, "resume.json");
            fs.writeFileSync(jsonPath, JSON.stringify({
                chatInfo: { name: "Exported Title", type: "group", uin: "910001" },
                messages: [
                    // 2024-05-01 08:00 UTC (hour 8)
                    { id: "r1", timestamp: Date.parse("2024-05-01T08:00:00.000Z"), sender: { uin: "501", nickname: "U1" }, content: { text: "1" } },
                    // 2024-05-01 08:10 UTC (hour 8)
                    { id: "r2", timestamp: Date.parse("2024-05-01T08:10:00.000Z"), sender: { uin: "502", nickname: "U2" }, content: { text: "2" } },
                    // 2024-05-02 14:00 UTC (hour 14)
                    { id: "r3", timestamp: Date.parse("2024-05-02T14:00:00.000Z"), sender: { uin: "501", nickname: "U1" }, content: { text: "3" } },
                    // 2024-05-03 20:00 UTC (hour 20)
                    { id: "r4", timestamp: Date.parse("2024-05-03T20:00:00.000Z"), sender: { uin: "503", nickname: "U3" }, content: { text: "4" } },
                    // Blocked by userGate
                    { id: "r5", timestamp: Date.parse("2024-05-03T21:00:00.000Z"), sender: { uin: "504", nickname: "Blocked" }, content: { text: "5" } },
                ],
            }), "utf8");

            // Lease contention check
            const activeLease = mem.acquireHistoryLease(chatId, 30_000);
            await assert.rejects(
                () => importQce(mem, jsonPath, { timezone: "UTC" }),
                HistoryLeaseError,
            );
            mem.releaseHistoryLease(chatId, activeLease.ownerToken);

            // Simulate abort right after batch 1 (batchSize = 2)
            const ac = new AbortController();
            const origStoreBatch = mem.storeIngestedBatch.bind(mem);
            let batchCalls = 0;
            mem.storeIngestedBatch = ((entries, checkpoint) => {
                const out = origStoreBatch(entries, checkpoint);
                batchCalls++;
                if (batchCalls === 1) {
                    ac.abort();
                }
                return out;
            }) as typeof mem.storeIngestedBatch;

            await assert.rejects(
                () => importQce(mem, jsonPath, {
                    timezone: "UTC",
                    batchSize: 2,
                    userGateBlocked: (uid) => uid === "onebot:504",
                }, ac.signal),
                (err: Error) => err.name === "AbortError",
            );
            mem.storeIngestedBatch = origStoreBatch;

            // Verify paused job exists and only batch 1 (2 messages) was committed
            const pausedJob = mem.findLatestHistoryJob("qce_import", chatId);
            assert.equal(pausedJob?.status, "paused");
            assert.equal(mem.getRecentMessages(chatId, 20).length, 2);

            // --resume with changed options must fail cleanly
            await assert.rejects(
                () => importQce(mem, jsonPath, { timezone: "Asia/Shanghai", resume: true }),
                /options changed/i,
            );

            // Resume with matching options
            const resumed = await importQce(mem, jsonPath, {
                timezone: "UTC",
                batchSize: 2,
                resume: true,
                userGateBlocked: (uid) => uid === "onebot:504",
            });
            assert.equal(resumed.resumedFromOrdinal, 2);
            assert.equal(resumed.inserted, 2);
            assert.equal(resumed.skippedByFilter, 1);

            // Re-run overlapping export (fresh idempotent pass)
            const overlap = await importQce(mem, jsonPath, {
                timezone: "UTC",
                userGateBlocked: (uid) => uid === "onebot:504",
            });
            assert.equal(overlap.inserted, 0);
            assert.equal(overlap.duplicates, 4);
            assert.equal(overlap.skippedByFilter, 1);

            // Verify exact counts, 24h activeHours, newcomer defaults, and group_models stats + preservation
            assert.equal(mem.getRecentMessages(chatId, 20).length, 4);
            assert.equal(mem.getPersonIdentity("onebot:501")?.totalMessageCount, 2);
            assert.equal(mem.getPersonIdentity("onebot:502")?.totalMessageCount, 1);
            assert.equal(mem.getPersonIdentity("onebot:503")?.totalMessageCount, 1);
            assert.equal(mem.getPersonIdentity("onebot:504"), null);

            const profiles = mem.getProfilesForChat(chatId);
            const p501 = profiles.find(p => p.userId === "onebot:501")!;
            assert.equal(p501.messageCount, 2);
            assert.equal(p501.dunbarTier, 4);
            assert.equal(p501.affinityScore, 0);
            assert.equal(p501.relationToAgent, "");
            assert.equal(p501.activeHours.length, 24);
            assert.equal(p501.activeHours[8], 1);
            assert.equal(p501.activeHours[14], 1);

            const gm = mem.getGroupModel(chatId)!;
            assert.equal(gm.chatTitle, "Live Title");
            assert.equal(gm.description, "Live group description");
            assert.equal(gm.agentRole, "Moderator");
            assert.equal(gm.lastReflectedAt, "2024-04-01T00:00:00.000Z");
            assert.deepEqual(gm.hotTopics, ["Rust", "TypeScript"]);
            assert.equal(gm.activeMembers, 3);
            assert.ok(Math.abs(gm.avgMessagesPerDay - (4 / 3)) < 1e-9);
            assert.deepEqual(gm.peakHours, [8, 14, 20]);
        } finally {
            cleanupTestMemory(mem, "qce-resume");
            rmDirSafe(dir);
        }
    });

    it("dryRunQceImport never creates non-existent DB and never mutates existing DB", async () => {
        const dir = makeTempDir("qce-dryrun-");
        const mem = createTestMemory("qce-dryrun-existing");
        try {
            const jsonPath = path.join(dir, "dry.json");
            fs.writeFileSync(jsonPath, JSON.stringify({
                chatInfo: { name: "Dry Group", type: "group", uin: "920001" },
                messages: [
                    { id: "d1", timestamp: 1714521600000, sender: { uin: "701", nickname: "A" }, content: { text: "one" } },
                    { id: "d2", timestamp: 1714521660000, sender: { uin: "702", nickname: "B" }, content: { text: "two" } },
                    { id: "d3", timestamp: 1714521720000, sender: { uin: "703", nickname: "C" }, content: { text: "three" } },
                ],
            }), "utf8");

            // 1. Non-existent DB path must NOT be created
            const nonExistentDb = path.join(dir, "does-not-exist.db");
            const dryNew = await dryRunQceImport(jsonPath, nonExistentDb, { timezone: "UTC" });
            assert.equal(fs.existsSync(nonExistentDb), false);
            assert.equal(dryNew.dryRun, true);
            assert.equal(dryNew.inserted, 3);
            assert.equal(dryNew.duplicates, 0);

            // 2. Existing DB with d1 matching and d2 conflicting
            mem.storeIngestedBatch([
                {
                    messageId: "d1",
                    chatId: "onebot:group:920001",
                    userId: "onebot:701",
                    displayName: "A",
                    text: "one",
                    timestamp: new Date(1714521600000).toISOString(),
                    origin: "live",
                    countAsHuman: true,
                    statsHour: 0,
                },
                {
                    messageId: "d2",
                    chatId: "onebot:group:920001",
                    userId: "onebot:999",
                    displayName: "Different",
                    text: "conflict",
                    timestamp: new Date(1714521660000).toISOString(),
                    origin: "live",
                    countAsHuman: true,
                    statsHour: 0,
                },
            ]);
            // Flush WAL so readonly DB sees committed rows
            mem.close();

            const dbFile = testDbPath("qce-dryrun-existing");
            const dryExisting = await dryRunQceImport(jsonPath, dbFile, { timezone: "UTC" });
            assert.equal(dryExisting.inserted, 1); // d3
            assert.equal(dryExisting.duplicates, 1); // d1
            assert.equal(dryExisting.conflicts, 1); // d2
        } finally {
            cleanupTestMemory(mem, "qce-dryrun-existing");
            rmDirSafe(dir);
        }
    });

    it("isolates QCE-only chats from startup backfill discovery and watermarks while keeping Dashboard visibility", async () => {
        const dir = makeTempDir("qce-backfill-iso-");
        const mem = createTestMemory("qce-backfill-iso");
        try {
            const qceChat = "onebot:group:930001";
            const liveChat = "onebot:group:930002";

            const jsonPath = path.join(dir, "qce.json");
            fs.writeFileSync(jsonPath, JSON.stringify({
                chatInfo: { name: "QCE Only", type: "group", uin: "930001" },
                messages: [
                    { id: "q1", timestamp: 1714521600000, sender: { uin: "801", nickname: "Q1" }, content: { text: "qce msg" } },
                ],
            }), "utf8");
            await importQce(mem, jsonPath, { timezone: "UTC" });

            mem.storeIngestedBatch([{
                messageId: "live1",
                chatId: liveChat,
                userId: "onebot:802",
                displayName: "L1",
                text: "live msg",
                timestamp: "2024-05-02T00:00:00.000Z",
                origin: "live",
                countAsHuman: true,
                statsHour: 0,
            }]);

            // Backfill discovery & watermarks MUST exclude QCE-only chat/rows
            assert.deepEqual(mem.listBackfillChatIds("onebot"), [liveChat]);
            assert.equal(mem.getBackfillWatermark(qceChat, "timestamp"), null);
            assert.equal(mem.getBackfillWatermark(liveChat, "timestamp")?.messageId, "live1");

            // Even if a mixed chat has newer QCE rows, watermark must come from non-QCE rows
            mem.storeIngestedBatch([{
                messageId: "qce-newer",
                chatId: liveChat,
                userId: "onebot:801",
                displayName: "Q1",
                text: "qce row in mixed chat",
                timestamp: "2025-01-01T00:00:00.000Z",
                origin: "qce",
                countAsHuman: true,
                statsHour: 0,
            }]);
            assert.equal(mem.getBackfillWatermark(liveChat, "timestamp")?.messageId, "live1");

            // Dashboard / admin visibility MUST still include QCE chats
            const allKnown = mem.listKnownChatIds("onebot");
            assert.ok(allKnown.includes(qceChat));
            assert.ok(allKnown.includes(liveChat));
            assert.ok(mem.listGroupModels().some(g => g.chatId === qceChat));
        } finally {
            cleanupTestMemory(mem, "qce-backfill-iso");
            rmDirSafe(dir);
        }
    });

    it("enforces spool 0700/0600 permissions, strips recalled bodies before spool, handles wide IDs & UTF-8 64KiB splits, and promotes QCE->live origin", async () => {
        const dir = makeTempDir("qce-remediation-b-");
        const mem = createTestMemory("qce-remediation-b");
        try {
            // 1. Spool permissions (0o700 dir / 0o600 db) + recalled body stripped BEFORE spooling
            const recalledSecret = "SUPER_SECRET_RECALLED_BODY_NEVER_SPOOL";
            const spoolJson = path.join(dir, "spool-privacy.json");
            fs.writeFileSync(
                spoolJson,
                '{"chatInfo":{"name":"Spool Group","type":"group","peerUid":"940001"},"messages":['
                + '{"id":9007199254740993123,"type":"type_1","timestamp":0,"time":"2024-05-01T00:00:00Z","sender":{"uid":"u_a","uin":9007199254740993456,"name":"PrivateRemark","remark":"PrivateRemark"},"content":{"text":"hello wide"}},'
                + `{"id":"rec-1","timestamp":1714521660000,"recalled":true,"sender":{"uin":"10002","nickname":"Recaller"},"content":{"text":"${recalledSecret}"}}`
                + "]}",
                "utf8",
            );

            const staged = await stageQceExport(spoolJson, { timezone: "UTC", includeRecalled: true });
            let spoolDirSeen = "";
            try {
                // Find the active spool dir under os.tmpdir()
                const entries = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("cgm-qce-"));
                for (const name of entries) {
                    const candidateDb = path.join(os.tmpdir(), name, "spool.db");
                    if (fs.existsSync(candidateDb)) {
                        const rawDbBytes = fs.readFileSync(candidateDb);
                        if (rawDbBytes.includes("9007199254740993123")) {
                            spoolDirSeen = path.join(os.tmpdir(), name);
                            const dirMode = fs.statSync(spoolDirSeen).mode & 0o777;
                            const dbMode = fs.statSync(candidateDb).mode & 0o777;
                            assert.equal(dirMode, 0o700);
                            assert.equal(dbMode, 0o600);
                            assert.equal(rawDbBytes.includes(recalledSecret), false, "Recalled body must be stripped before spooling");
                        }
                    }
                }
                assert.ok(spoolDirSeen, "Expected to inspect active spool directory");

                const spooledMsgs = [...staged.iterateMessages()];
                assert.equal(spooledMsgs[0].rawId, "9007199254740993123");
                assert.equal(String(spooledMsgs[0].raw.sender?.uin), "9007199254740993456");
                assert.equal(spooledMsgs[1].raw.content, undefined);
            } finally {
                staged.cleanup();
            }
            assert.equal(fs.existsSync(spoolDirSeen), false, "Spool directory must be removed on cleanup");

            // 2. Import verifies remark exclusion, time===0 fallback to time, and QCE->live promotion
            const importRes = await importQce(mem, spoolJson, { timezone: "UTC" });
            assert.equal(importRes.chatId, "onebot:group:940001");
            assert.equal(importRes.isOpaquePeerChat, false);
            assert.equal(importRes.inserted, 1);

            const msgWide = mem.getMessageById("onebot:group:940001", "9007199254740993123");
            assert.ok(msgWide);
            assert.equal(msgWide.userId, "onebot:9007199254740993456");
            assert.equal(msgWide.timestamp, "2024-05-01T00:00:00.000Z");
            // Remark-identical name must not be indexed into person_chat_names
            assert.equal(mem.searchChatNames("onebot:group:940001", "PrivateRemark").length, 0);

            // QCE-only chat is excluded from backfill before live delivery
            assert.deepEqual(mem.listBackfillChatIds("onebot"), []);

            // Same-ID live delivery promotes origin to 'live' without overwriting text or double-counting stats!
            const dupLiveRes = mem.storeIngestedBatch([{
                messageId: "9007199254740993123",
                chatId: "onebot:group:940001",
                userId: "onebot:9007199254740993456",
                displayName: "OverwrittenLiveName",
                text: "LIVE_OVERWRITE_SHOULD_NOT_APPLY",
                timestamp: "2024-05-01T00:00:00.000Z",
                origin: "live",
                countAsHuman: true,
                statsHour: 0,
            }]);
            assert.equal(dupLiveRes.duplicates, 1);
            assert.equal(dupLiveRes.inserted, 0);
            assert.equal(mem.getMessageById("onebot:group:940001", "9007199254740993123")?.text, "hello wide");
            assert.equal(mem.getPersonIdentity("onebot:9007199254740993456")?.totalMessageCount, 1);
            assert.deepEqual(mem.listBackfillChatIds("onebot"), ["onebot:group:940001"]);
            assert.equal(mem.getBackfillWatermark("onebot:group:940001", "timestamp")?.messageId, "9007199254740993123");

            // 3. UTF-8 multi-byte character split across 64 KiB chunk boundary + >200 malformed lines count + private peerUid/peerUin
            const utf8Dir = path.join(dir, "utf8-split");
            fs.mkdirSync(utf8Dir, { recursive: true });
            const padLen = 65_534;
            const lineA = JSON.stringify({
                id: "u1",
                type: "type_1",
                timestamp: 1714521600000,
                sender: { uid: "u_priv", nickname: "PrivNick" },
                content: { text: "A".repeat(padLen - 120) + "你好世界边界测试" },
            });
            // Ensure multi-byte char crosses 65536 byte offset
            const badLines = Array.from({ length: 205 }, () => "{bad").join("\n");
            fs.writeFileSync(path.join(utf8Dir, "chunk1.jsonl"), `${lineA}\n${badLines}\n`, "utf8");
            fs.writeFileSync(path.join(utf8Dir, "manifest.json"), JSON.stringify({
                chatInfo: { name: "Priv Chat", type: "private", peerUid: "u_priv", peerUin: "555123" },
                chunked: { format: "jsonl", chunks: [{ index: 1, file: "chunk1.jsonl" }] },
            }), "utf8");

            const utf8Res = await importQce(mem, utf8Dir, { timezone: "UTC" });
            assert.equal(utf8Res.chatId, "onebot:private:555123");
            assert.equal(utf8Res.inserted, 1);
            assert.equal(utf8Res.malformedLineCount, 205);
            assert.equal(utf8Res.malformedLines.length, 200);
            const loadedUtf8 = mem.getMessageById("onebot:private:555123", "u1");
            assert.ok(loadedUtf8?.text.endsWith("你好世界边界测试"));

            // 4. Upstream [转发消息: ...] stripping, unbalanced parens, URL credential stripping, resource-only counts
            const fwdNorm = normalizeQceMessage({
                id: "fwd-upstream",
                timestamp: 1714521600000,
                sender: { uin: "1001", nickname: "Sender" },
                content: {
                    text: "[转发消息: 泄露正文] (未闭合括号内容",
                    elements: [
                        {
                            type: "forward",
                            messages: [
                                { sender: { nickname: "F1" }, content: { text: "forwarded secret body" } },
                            ],
                        },
                        {
                            type: "json",
                            title: "Card",
                            url: "https://user:secret@example.com/path/item?token=SECRET_TOKEN#frag",
                        },
                    ],
                    resources: [
                        { type: "image", fileName: "a.png" },
                        { type: "image", fileName: "b.png" },
                    ],
                },
            }, {
                chatId: "onebot:group:940001",
                isDirectMessage: false,
                timezone: "UTC",
                uidToUin: new Map(),
            });
            assert.equal(fwdNorm.status, "ok");
            if (fwdNorm.status === "ok") {
                assert.equal(fwdNorm.message.qceMeta.hasForward, true);
                assert.ok(fwdNorm.message.text.includes("forwarded secret body"));
                assert.equal(fwdNorm.message.qceMeta.evidenceText, "[转发聊天记录][🔗 卡片: Card] [📷 图片]");
                const stripped = stripForwardedBodyText(fwdNorm.message.text);
                assert.equal(stripped.includes("forwarded secret body"), false);
                assert.equal(stripForwardedBodyText("[转发消息: 泄露正文] (未闭合"), "[转发聊天记录]");
                assert.equal(stripForwardedBodyText("[转发聊天记录: 2条] (A: hi :) 秘密 ] 泄露)\n第二行绝密转发正文"), "[转发聊天记录]");
                assert.equal(stripForwardedBodyText("前缀 [转发消息: 1条] (A: hi)\r\n第二行绝密转发正文"), "前缀 [转发聊天记录]");
                const media = JSON.parse(fwdNorm.message.mediaInfo!);
                assert.equal(media.counts.photo, 2, "All resource-only images must be counted");
                assert.equal(media.cards[0].url, "https://example.com/path/item");
                assert.equal(JSON.stringify(media).includes("SECRET_TOKEN"), false);
            }

            // 4b. Multi-line forwarded body exclusion in both structured forward element and flattened content.text-only row
            const multiLineStruct = normalizeQceMessage({
                id: "fwd-multiline-struct",
                timestamp: 1714521600000,
                sender: { uin: "1001", nickname: "Sender" },
                content: {
                    elements: [
                        { type: "text", text: "外层安全评论 " },
                        {
                            type: "forward",
                            messages: [
                                { sender: { nickname: "F1" }, content: { text: "第一行\n第二行绝密转发正文" } },
                            ],
                        },
                        { type: "text", text: " [转发消息: 内嵌\n第二行绝密转发正文" },
                    ],
                },
            }, {
                chatId: "onebot:group:940001",
                isDirectMessage: false,
                timezone: "UTC",
                uidToUin: new Map(),
            });
            assert.equal(multiLineStruct.status, "ok");
            if (multiLineStruct.status === "ok") {
                assert.equal(multiLineStruct.message.qceMeta.hasForward, true);
                assert.equal(multiLineStruct.message.qceMeta.evidenceText, "外层安全评论 [转发聊天记录] [转发聊天记录]");
                assert.equal(multiLineStruct.message.qceMeta.evidenceText?.includes("第二行绝密转发正文"), false);
            }

            const multiLineFlat = normalizeQceMessage({
                id: "fwd-multiline-flat",
                timestamp: 1714521600000,
                sender: { uin: "1001", nickname: "Sender" },
                content: {
                    text: "外层前缀 [转发聊天记录: 2条] (Alice: line1)\n第二行绝密转发正文",
                },
            }, {
                chatId: "onebot:group:940001",
                isDirectMessage: false,
                timezone: "UTC",
                uidToUin: new Map(),
            });
            assert.equal(multiLineFlat.status, "ok");
            if (multiLineFlat.status === "ok") {
                assert.equal(multiLineFlat.message.qceMeta.hasForward, true);
                assert.equal(multiLineFlat.message.qceMeta.evidenceText, "外层前缀 [转发聊天记录]");
                assert.equal(multiLineFlat.message.qceMeta.evidenceText?.includes("第二行绝密转发正文"), false);
            }

            // 5. Conflict adjudication via --user-map unifies all messages under one userId
            const conflictPath = path.join(dir, "uid-conflict-map.json");
            fs.writeFileSync(conflictPath, JSON.stringify({
                chatInfo: { name: "Map Group", type: "group", peerUid: "940002" },
                messages: [
                    { id: "cm1", timestamp: 1714521600000, sender: { uid: "u_c", uin: "11111", nickname: "C" }, content: { text: "first" } },
                    { id: "cm2", timestamp: 1714521660000, sender: { uid: "u_c", uin: "22222", nickname: "C" }, content: { text: "second" } },
                ],
            }), "utf8");
            const mapFile = path.join(dir, "u-map.json");
            fs.writeFileSync(mapFile, JSON.stringify({ u_c: "11111" }), "utf8");
            await importQce(mem, conflictPath, { timezone: "UTC", userMapPath: mapFile });
            const conflictMsgs = mem.getRecentMessages("onebot:group:940002", 10);
            assert.ok(conflictMsgs.every(m => m.userId === "onebot:11111"));
        } finally {
            cleanupTestMemory(mem, "qce-remediation-b");
            rmDirSafe(dir);
        }
    });

    it("rejects symlinked ancestor directory under chunksDir and resolves UID->UIN via SQLite spool with UTF-8 byte accounting", async () => {
        const dir = makeTempDir("qce-remediation-c-");
        const mem = createTestMemory("qce-remediation-c");
        try {
            // 1. Symlinked ancestor directory under chunksDir must be rejected
            const outsideDir = path.join(dir, "outside");
            fs.mkdirSync(outsideDir, { recursive: true });
            fs.writeFileSync(path.join(outsideDir, "c1.jsonl"), JSON.stringify({
                id: "1",
                timestamp: 1714521600000,
                sender: { uin: "1001", nickname: "Out" },
                content: { text: "escaped" },
            }) + "\n", "utf8");

            const exportDir = path.join(dir, "export-ancestor-sym");
            fs.mkdirSync(path.join(exportDir, "chunks"), { recursive: true });
            fs.symlinkSync(outsideDir, path.join(exportDir, "chunks", "sub"));
            fs.writeFileSync(path.join(exportDir, "manifest.json"), JSON.stringify({
                chatInfo: { name: "Sym Group", type: "group", peerUid: "950001" },
                chunked: {
                    format: "jsonl",
                    chunksDir: "chunks",
                    chunks: [{ index: 1, file: "sub/c1.jsonl" }],
                },
            }), "utf8");

            await assert.rejects(
                () => importQce(mem, exportDir, { timezone: "UTC" }),
                /escapes/i,
            );

            // 2. Multi-byte UTF-8 messages (> 500 batch) with SQLite spool UID->UIN unification
            const bigUtf8Path = path.join(dir, "utf8-spool.json");
            const messages = Array.from({ length: 550 }, (_, idx) => ({
                id: `u_${idx}`,
                timestamp: 1714521600000 + idx * 1000,
                sender: idx === 549
                    ? { uid: "u_late_uin", uin: "888999", nickname: "汉字昵称😀" }
                    : { uid: "u_late_uin", nickname: "汉字昵称😀" },
                content: { text: `第${idx}条中文消息🚀` },
            }));
            fs.writeFileSync(bigUtf8Path, JSON.stringify({
                chatInfo: { name: "Spool Group", type: "group", peerUid: "950002" },
                messages,
            }), "utf8");

            const summary = await importQce(mem, bigUtf8Path, { timezone: "UTC" });
            assert.equal(summary.inserted, 550);
            assert.equal(summary.uniqueSenders, 1);
            assert.equal(summary.uidResolution.resolvedUids, 1);
            const recent = mem.getRecentMessages("onebot:group:950002", 10);
            assert.ok(recent.every(m => m.userId === "onebot:888999"));
        } finally {
            cleanupTestMemory(mem, "qce-remediation-c");
            rmDirSafe(dir);
        }
    });
});
