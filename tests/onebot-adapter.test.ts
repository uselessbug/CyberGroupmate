import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { NotificationCenter } from "../src/event/notification-center.js";
import type { NotificationEvent } from "../src/event/notification-center.js";
import { OneBotAdapter } from "../src/adapter/onebot-adapter.js";
import type { OneBotConfig } from "../src/core/config.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `onebot-adapter-${randomUUID()}.jsonl`), false);
}

function makeConfig(overrides: Partial<OneBotConfig> = {}): OneBotConfig {
    return {
        wsUrl: "ws://127.0.0.1:6700/onebot",
        selfId: "123456789",
        ...overrides,
    };
}

function captureEvents(nc: NotificationCenter): NotificationEvent[] {
    const events: NotificationEvent[] = [];
    nc.onPush(event => events.push(event));
    return events;
}

async function waitForAsyncHandlers(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}

describe("OneBotAdapter", () => {
    it("should normalize array at segments into readable mentions and direct attention", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method for focused ingress test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_member_info") {
                assert.deepEqual(params, { group_id: 42, user_id: 123456789, no_cache: false });
                return { user_id: 123456789, card: "BotName", nickname: "BotNick" };
            }
            if (action === "get_group_info") {
                return { group_id: 42, group_name: "Test QQ Group" };
            }
            throw new Error(`unexpected action: ${action}`);
        };

        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 777,
            message_id: 9001,
            time: 1770000000,
            sender: { user_id: 777, nickname: "Alice", card: "" },
            message: [
                { type: "text", data: { text: "hi " } },
                { type: "at", data: { qq: "123456789" } },
                { type: "text", data: { text: " ping" } },
            ],
        }));
        await waitForAsyncHandlers();

        assert.equal(events.length, 1);
        assert.equal(events[0].type, "nc.message");
        assert.equal(events[0].scene, "onebot");
        assert.equal(events[0].chatId, "onebot:group:42");
        assert.equal(events[0].userId, "onebot:777");
        assert.equal(events[0].displayName, "Alice");
        assert.equal(events[0].text, "hi @BotName ping");
        assert.equal(events[0].mentionsAgent, true);
        assert.equal(events[0].chatTitle, "Test QQ Group");
        assert.deepEqual(events[0].mentions, [{
            userId: "onebot:123456789",
            rawUserId: "123456789",
            displayName: "BotName",
            isAll: false,
            isSelf: true,
            nameSource: "chat",
        }]);
        assert.deepEqual(events[0].messageSegments, [
            { type: "text", data: { text: "hi " } },
            { type: "at", data: { qq: "123456789" } },
            { type: "text", data: { text: " ping" } },
        ]);
        assert.deepEqual(events[0].source, {
            scene: "onebot",
            platform: "onebot",
            chatId: "onebot:group:42",
            userId: "onebot:777",
            chatType: "group",
            messageId: "9001",
            replyToMessageId: undefined,
        });

        nc.dispose();
    });

    it("should parse CQ at-all strings and unescape text", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method for focused ingress test
        adapter.callAction = async (action: string) => {
            if (action === "get_group_info") return { group_id: 42, group_name: "Test QQ Group" };
            throw new Error(`unexpected action: ${action}`);
        };

        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 777,
            message_id: 9002,
            sender: { user_id: 777, nickname: "Alice" },
            raw_message: "look &#91;x&#93;[CQ:at,qq=all] done",
        }));
        await waitForAsyncHandlers();

        assert.equal(events.length, 1);
        assert.equal(events[0].text, "look [x]@全体成员 done");
        assert.equal(events[0].mentionsAgent, true);
        assert.deepEqual(events[0].mentions, [{
            userId: "onebot:all",
            rawUserId: "all",
            displayName: "全体成员",
            isAll: true,
            isSelf: false,
        }]);

        nc.dispose();
    });

    it("should send at messages as OneBot segment arrays", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 3 };
        };

        await adapter.handleCall("onebot.sendAt", [
            "onebot:group:42",
            "onebot:private:778899,223344",
            "看一下",
            { replyTo: 9001 },
        ]);

        assert.deepEqual(calls, [{
            action: "send_group_msg",
            params: {
                group_id: 42,
                message: [
                    { type: "reply", data: { id: "9001" } },
                    { type: "at", data: { qq: "778899" } },
                    { type: "text", data: { text: " " } },
                    { type: "at", data: { qq: "223344" } },
                    { type: "text", data: { text: " 看一下" } },
                ],
            },
        }]);

        nc.dispose();
    });

    it("should send structured OneBot messages and normalize mention targets", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 4 };
        };

        await adapter.handleCall("onebot.sendMessage", [
            "onebot:group:42",
            [
                { type: "text", data: { text: "cc " } },
                { type: "at", data: { qq: "onebot:778899" } },
                { type: "text", data: { text: " 已处理" } },
            ],
        ]);

        assert.deepEqual(calls, [{
            action: "send_group_msg",
            params: {
                group_id: 42,
                message: [
                    { type: "text", data: { text: "cc " } },
                    { type: "at", data: { qq: "778899" } },
                    { type: "text", data: { text: " 已处理" } },
                ],
            },
        }]);

        nc.dispose();
    });

    it("should resolve numeric download refs through get_msg image URLs", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const originalFetch = globalThis.fetch;

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            if (action === "get_msg") {
                return {
                    message_id: 794582600,
                    message: [
                        {
                            type: "image",
                            data: {
                                file: "cached-image.jpg",
                                file_unique: "unique-image",
                                url: "https://cdn.example.test/image.png",
                            },
                        },
                    ],
                };
            }
            throw new Error(`unexpected action: ${action}`);
        };
        globalThis.fetch = async (url) => {
            assert.equal(String(url), "https://cdn.example.test/image.png");
            return new Response(bytes, { status: 200 });
        };

        try {
            const result = await adapter.handleCall("onebot.downloadMedia", ["794582600"]) as { buffer: string; size: number };
            assert.deepEqual(calls, [{ action: "get_msg", params: { message_id: 794582600 } }]);
            assert.equal(result.buffer, bytes.toString("base64"));
            assert.equal(result.size, bytes.length);
        } finally {
            globalThis.fetch = originalFetch;
            nc.dispose();
        }
    });

    it("should use get_image base64 instead of remote local paths", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const bytes = Buffer.from("image-bytes");

        // @ts-expect-error - override private method for focused download test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            assert.equal(action, "get_image");
            assert.deepEqual(params, { file: "cached-image.jpg" });
            return {
                file: "/remote/napcat/cache/cached-image.jpg",
                base64: bytes.toString("base64"),
            };
        };

        try {
            // @ts-expect-error - invoke private-ish adapter API directly for focused transport test
            const result = await adapter.downloadMedia(null, "cached-image.jpg");
            assert.deepEqual(result, bytes);
        } finally {
            nc.dispose();
        }
    });

    it("should drop replyTo for group voice payloads", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 1 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:group:979200391",
            { type: "audio", file: "media/mimo_tts_1777522996493.ogg" },
            { replyTo: 1805758077 },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_group_msg");
        assert.equal(calls[0].params.group_id, 979200391);
        assert.deepEqual(calls[0].params.message, [
            { type: "record", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/mimo_tts_1777522996493.ogg")}` } },
        ]);

        nc.dispose();
    });

    it("should drop replyTo for private voice payloads", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 2 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:private:12345678",
            { type: "audio", file: "media/private_voice.ogg" },
            { replyTo: 99887766 },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_private_msg");
        assert.deepEqual(calls[0].params.message, [
            { type: "record", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/private_voice.ogg")}` } },
        ]);

        nc.dispose();
    });

    it("should preserve fileName as OneBot file segment name", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 3 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:group:979200391",
            { type: "document", file: "media/report.pdf", fileName: "report.pdf" },
            {},
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_group_msg");
        assert.equal(calls[0].params.group_id, 979200391);
        assert.deepEqual(calls[0].params.message, [
            { type: "file", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/report.pdf")}`, name: "report.pdf" } },
        ]);

        nc.dispose();
    });

    it("should fall back to file basename when fileName is omitted", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 4 };
        };

        // Mirrors how the agent actually sends files: sendMedia with a bare
        // { type: "file", file } and no fileName. Without the basename fallback,
        // NapCat drops the name and shows a UUID.
        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:private:1751431516",
            { type: "file", file: "media/Hello World.txt" },
            {},
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_private_msg");
        assert.deepEqual(calls[0].params.message, [
            { type: "file", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/Hello World.txt")}`, name: "Hello World.txt" } },
        ]);

        nc.dispose();
    });

    it("should synthesize urgent nc.message when the bot is poked in a group", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method for focused ingress test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_member_info") {
                return { user_id: params.user_id, card: "", nickname: `User${params.user_id}` };
            }
            if (action === "get_group_info") return { group_id: 42, group_name: "Test QQ Group" };
            throw new Error(`unexpected action: ${action}`);
        };

        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "notify",
            sub_type: "poke",
            self_id: "123456789",
            group_id: 42,
            user_id: 777,
            target_id: 123456789,
            time: 1770000000,
        }));
        await waitForAsyncHandlers();

        assert.equal(events.length, 1);
        assert.equal(events[0].type, "nc.message");
        assert.equal(events[0].scene, "onebot");
        assert.equal(events[0].chatId, "onebot:group:42");
        assert.equal(events[0].userId, "onebot:777");
        assert.equal(events[0].displayName, "User777");
        assert.equal(events[0].text, "[👉 戳一戳] User777 戳了你");
        assert.equal(events[0].chatTitle, "Test QQ Group");
        assert.equal(events[0].chatType, "group");
        assert.equal(events[0].isDirectMessage, false);
        assert.equal(events[0].mentionsAgent, true);
        assert.equal(events[0]._urgent, true);
        assert.equal(
            String(events[0].messageId).startsWith("poke_1770000000_777_123456789_"),
            true,
            `messageId should be synthetic poke id, got ${String(events[0].messageId)}`,
        );
        assert.equal(events[0].payload.platformData.originalType, "notice.notify.poke");
        assert.equal(events[0].payload.platformData.pokedSelf, true);

        nc.dispose();
    });

    it("should synthesize non-urgent context when a group member pokes another member", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method for focused ingress test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_member_info") {
                return { user_id: params.user_id, card: "", nickname: `User${params.user_id}` };
            }
            if (action === "get_group_info") return { group_id: 42, group_name: "Test QQ Group" };
            throw new Error(`unexpected action: ${action}`);
        };

        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "notify",
            sub_type: "poke",
            self_id: "123456789",
            group_id: 42,
            user_id: 777,
            target_id: 888,
            time: 1770000100,
        }));
        await waitForAsyncHandlers();

        assert.equal(events.length, 1);
        assert.equal(events[0].chatId, "onebot:group:42");
        assert.equal(events[0].text, "[👉 戳一戳] User777 戳了 User888");
        assert.equal(events[0].mentionsAgent, false);
        assert.equal(events[0]._urgent, false);
        assert.equal(events[0].payload.platformData.pokedSelf, false);

        nc.dispose();
    });

    it("should synthesize direct-message event for private poke", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method for focused ingress test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_stranger_info") {
                return { user_id: params.user_id, nickname: "PrivateFriend" };
            }
            throw new Error(`unexpected action: ${action}`);
        };

        // 好友戳一戳没有 group_id；部分实现不带 target_id
        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "notify",
            sub_type: "poke",
            self_id: "123456789",
            user_id: 777,
            time: 1770000200,
        }));
        await waitForAsyncHandlers();

        assert.equal(events.length, 1);
        assert.equal(events[0].chatId, "onebot:private:777");
        assert.equal(events[0].chatType, "private");
        assert.equal(events[0].isDirectMessage, true);
        assert.equal(events[0].text, "[👉 戳一戳] PrivateFriend 发起戳一戳");
        assert.equal(events[0]._urgent, true);

        nc.dispose();
    });

    it("should ignore pokes initiated by the bot or for another account", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method; should not be called
        adapter.callAction = async (action: string) => {
            throw new Error(`unexpected action: ${action}`);
        };

        // bot 自己发起的戳一戳（NapCat 回显）
        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "notify",
            sub_type: "poke",
            self_id: "123456789",
            group_id: 42,
            user_id: 123456789,
            target_id: 777,
            time: 1770000300,
        }));
        // 另一个账号的戳一戳（多账号场景）
        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "notify",
            sub_type: "poke",
            self_id: "999999999",
            group_id: 42,
            user_id: 777,
            target_id: 123456789,
            time: 1770000301,
        }));
        await waitForAsyncHandlers();

        assert.equal(events.length, 0);

        nc.dispose();
    });

    it("isolates group member card cache across groups and private fallback", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method for test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_info") return { group_id: params.group_id, group_name: `Group-${params.group_id}` };
            if (action === "get_stranger_info") return { user_id: params.user_id, nickname: "AccountNick" };
            throw new Error(`unexpected action: ${action}`);
        };

        // User 777 speaks in Group 100 with card "Group100Card"
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 100,
            user_id: 777,
            message_id: 1,
            sender: { user_id: 777, nickname: "AccountNick", card: "Group100Card" },
            message: [{ type: "text", data: { text: "hello 100" } }],
        }));
        // User 777 speaks in Group 200 with card "Group200Card"
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 200,
            user_id: 777,
            message_id: 2,
            sender: { user_id: 777, nickname: "AccountNick", card: "Group200Card" },
            message: [{ type: "text", data: { text: "hello 200" } }],
        }));
        await waitForAsyncHandlers();

        // Another user mentions 777 in Group 100 and Group 200 (should use each group's cached card, never cross-group!)
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 100,
            user_id: 888,
            message_id: 3,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 200,
            user_id: 888,
            message_id: 4,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        // Private message mentioning/from 777 should use account nickname, not group card!
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "private",
            user_id: 888,
            message_id: 5,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        await waitForAsyncHandlers();

        assert.equal((events[2].mentions as any)[0].displayName, "Group100Card");
        assert.equal((events[2].mentions as any)[0].nameSource, "chat");
        assert.equal((events[3].mentions as any)[0].displayName, "Group200Card");
        assert.equal((events[3].mentions as any)[0].nameSource, "chat");
        assert.equal((events[4].mentions as any)[0].displayName, "AccountNick");
        assert.equal(adapter.getCachedNames().userNicks.get("777"), "AccountNick");

        nc.dispose();
    });

    it("handles group_card notice card_new, explicit clear, and omitted card non-downgrade", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);
        let memberLookups = 0;

        // @ts-expect-error - override private method for test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_info") return { group_id: params.group_id, group_name: "G42" };
            if (action === "get_group_member_info") {
                memberLookups++;
                return { user_id: params.user_id, card: "", nickname: "LookupNick" };
            }
            throw new Error(`unexpected action: ${action}`);
        };

        // 1. group_card notice with card_new updates group cache without polluting userNickCache
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "group_card",
            group_id: 42,
            user_id: 777,
            card_new: "FreshCard",
        }));
        assert.equal(adapter.getCachedNames().userNicks.has("777"), false);

        // 2. Message from 777 with omitted card field does NOT downgrade known card "FreshCard"
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 777,
            message_id: 10,
            sender: { user_id: 777, nickname: "RawNick" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        await waitForAsyncHandlers();
        assert.equal((events[0].mentions as any)[0].displayName, "FreshCard");
        assert.equal(memberLookups, 0);

        // 3. Explicit empty card_new clears cache so subsequent mention re-fetches
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "group_card",
            group_id: 42,
            user_id: 777,
            card_new: "",
        }));
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 888,
            message_id: 11,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        await waitForAsyncHandlers();
        assert.equal(memberLookups, 1);
        assert.equal((events[1].mentions as any)[0].displayName, "LookupNick");

        nc.dispose();
    });

    it("guards async get_group_member_info against newer notice and prevents backfill from clobbering live cache", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);
        let resolveMemberLookup!: (value: unknown) => void;

        // @ts-expect-error - override private method for test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_info") return { group_id: params.group_id, group_name: "G42" };
            if (action === "get_group_member_info") {
                return await new Promise(resolve => { resolveMemberLookup = resolve; });
            }
            throw new Error(`unexpected action: ${action}`);
        };

        // Start live message that triggers async get_group_member_info for 777
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 888,
            message_id: 20,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        await waitForAsyncHandlers();

        // While lookup is in-flight, a newer group_card notice arrives
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "group_card",
            group_id: 42,
            user_id: 777,
            card_new: "NewerNoticeCard",
        }));

        // Stale async get_group_member_info resolves with older card
        resolveMemberLookup({ user_id: 777, card: "StaleLookupCard", nickname: "OldNick" });
        await waitForAsyncHandlers();

        // Next mention must see "NewerNoticeCard" (not overwritten by stale lookup)
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 888,
            message_id: 21,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        await waitForAsyncHandlers();
        assert.equal((events[1].mentions as any)[0].displayName, "NewerNoticeCard");

        // History backfill with old card must NOT clobber live cache "NewerNoticeCard"
        // @ts-expect-error - invoke private normalizer with isHistoryBackfill
        const backfilled = await adapter.normalizeIncomingMessage({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 777,
            message_id: 5,
            time: 1770000000,
            sender: { user_id: 777, nickname: "OldNick", card: "AncientBackfillCard" },
            message: [{ type: "text", data: { text: "old msg" } }],
        }, { isHistoryBackfill: true });
        assert.equal(backfilled?.displayName, "AncientBackfillCard");

        // Live mention still sees "NewerNoticeCard"
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 888,
            message_id: 22,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        await waitForAsyncHandlers();
        assert.equal((events[2].mentions as any)[0].displayName, "NewerNoticeCard");

        nc.dispose();
    });

    it("prevents blocked senders from poisoning mention cache and tags account_fallback when group lookup fails", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc, undefined, undefined, {
            shouldCacheSender: ({ userId }) => userId !== "onebot:666",
        });

        // @ts-expect-error - override private method for test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_info") return { group_id: params.group_id, group_name: "G42" };
            if (action === "get_group_member_info") throw new Error("not in group / lookup failed");
            if (action === "get_stranger_info") return { user_id: params.user_id, nickname: "StrangerFallback" };
            throw new Error(`unexpected action: ${action}`);
        };

        // Blocked sender 666 sends a spoofed card "SpoofedName"
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 666,
            message_id: 30,
            sender: { user_id: 666, nickname: "Blocked", card: "SpoofedName" },
            message: [{ type: "text", data: { text: "blocked msg" } }],
        }));
        await waitForAsyncHandlers();

        // Allowed user mentions 666: must NOT resolve "SpoofedName", falls back to get_stranger_info tagged as account_fallback
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 888,
            message_id: 31,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "666" } }],
        }));
        await waitForAsyncHandlers();

        assert.equal((events[1].mentions as any)[0].displayName, "StrangerFallback");
        assert.equal((events[1].mentions as any)[0].nameSource, "account_fallback");

        nc.dispose();
    });

    it("guards card-clear race, skips cache writes on backfill/blocked mentions, and tags poke account_fallback", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc, undefined, undefined, {
            shouldCacheSender: ({ userId }) => userId !== "onebot:666",
        });

        let resolveLookup!: (value: unknown) => void;
        // @ts-expect-error - override private method for test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_info") return { group_id: params.group_id, group_name: "G42" };
            if (action === "get_stranger_info") return { user_id: params.user_id, nickname: "StrangerNick" };
            if (action === "get_group_member_info") {
                if (String(params.user_id) === "777") {
                    return await new Promise(resolve => { resolveLookup = resolve; });
                }
                if (String(params.user_id) === "999") {
                    return { user_id: 999, card: "BlockedTargetCard", nickname: "Nick999" };
                }
                if (String(params.user_id) === "998") {
                    return { user_id: 998, card: "BackfillTargetCard", nickname: "Nick998" };
                }
                throw new Error("member lookup failed");
            }
            throw new Error(`unexpected action: ${action}`);
        };

        // 1. Card-clear race: start lookup for 777, then clear via group_card notice card_new="" before lookup resolves
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 888,
            message_id: 40,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "777" } }],
        }));
        await waitForAsyncHandlers();

        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "group_card",
            group_id: 42,
            user_id: 777,
            card_new: "",
        }));
        resolveLookup({ user_id: 777, card: "ClearedStaleCard", nickname: "ClearedStaleNick" });
        await waitForAsyncHandlers();

        // Must NOT use ClearedStaleCard as nameSource="chat"; falls back to account_fallback
        assert.notEqual((events[0].mentions as any)[0].displayName, "ClearedStaleCard");
        assert.equal((events[0].mentions as any)[0].nameSource, "account_fallback");

        // 2. Blocked sender's mention enrichment must NOT populate groupMemberNameCache
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 666,
            message_id: 41,
            sender: { user_id: 666, nickname: "Blocked" },
            message: [{ type: "at", data: { qq: "999" } }],
        }));
        await waitForAsyncHandlers();
        assert.equal((adapter as any).groupMemberNameCache.get("42")?.has("999") ?? false, false);

        // 3. Backfill mention enrichment must NOT populate groupMemberNameCache or userNickCache
        // @ts-expect-error - invoke private normalizer with isHistoryBackfill
        await adapter.normalizeIncomingMessage({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 888,
            message_id: 42,
            time: 1770000100,
            sender: { user_id: 888, nickname: "Bob" },
            message: [{ type: "at", data: { qq: "998" } }],
        }, { isHistoryBackfill: true });
        assert.equal((adapter as any).groupMemberNameCache.get("42")?.has("998") ?? false, false);

        // 4. Group poke falling back to stranger nickname preserves displayNameSource="account_fallback"
        // @ts-expect-error - invoke private handler
        adapter.handleWsMessage(JSON.stringify({
            post_type: "notice",
            notice_type: "notify",
            sub_type: "poke",
            self_id: "123456789",
            group_id: 42,
            user_id: 555,
            target_id: 123456789,
            time: 1770000200,
        }));
        await waitForAsyncHandlers();
        const pokeEvt = events.find(e => String(e.messageId ?? "").startsWith("poke_"));
        assert.ok(pokeEvt);
        assert.equal(pokeEvt.displayName, "StrangerNick");
        assert.equal(pokeEvt.displayNameSource, "account_fallback");

        nc.dispose();
    });
});
