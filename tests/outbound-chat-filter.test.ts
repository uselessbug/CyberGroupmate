import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { AttentionAccumulator } from "../src/accumulator/attention-accumulator.js";
import { createDirectAddressItem } from "../src/accumulator/queue-entry-adapter.js";
import { userGate } from "../src/adapter/user-gate.js";
import { clearConfigCache, loadConfig, serializeConfigToYAML, type ChatFilterConfig } from "../src/core/config.js";
import { releaseChatFromFilter } from "../src/core/inbound-filter.js";
import { GlobalState } from "../src/main-agent/global-state.js";
import { MainAgentLoop } from "../src/main-agent/main-agent-loop.js";
import { registerNotifyTools } from "../src/mcp-server/tools/notify.js";
import { createConversationsApi } from "../src/meta-sandbox/meta-api/conversations.js";
import { createDispatchApi } from "../src/meta-sandbox/meta-api/dispatch.js";
import { createCronApi, createReminderApi } from "../src/meta-sandbox/meta-api/scheduler.js";
import { createTodoApi } from "../src/meta-sandbox/meta-api/todo.js";
import { createSandboxHostCallHandler } from "../src/sandbox/host-call-handler.js";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import { SubagentManager } from "../src/subagent/subagent-manager.js";
import { cleanupTestMemory, createTestMemory } from "./helpers/test-db.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

function applyChatFilterConfig(chatFilter?: ChatFilterConfig): string {
    const dir = makeTempDir("outbound-filter-cfg");
    const configPath = join(dir, "config.yaml");
    writeFilterConfigFile(configPath, chatFilter);
    return configPath;
}

function writeFilterConfigFile(configPath: string, chatFilter?: ChatFilterConfig): void {
    clearConfigCache();
    const base = loadConfig(configPath, true);
    base.chatFilter = chatFilter;
    writeFileSync(configPath, serializeConfigToYAML(base), "utf8");
    clearConfigCache();
    loadConfig(configPath, true);
}

function makeSandboxHandler(boundChatId: string) {
    const adapterCalls: Array<{ method: string; args: unknown[] }> = [];
    const dispatched: Array<{ chatId: string; spec: unknown; options?: unknown }> = [];
    const reminders: Array<unknown> = [];
    const crons: Array<unknown> = [];

    const adapters = (["onebot", "telegram", "discord", "feishu"] as const).map((platform) => ({
        platform,
        canHandle: (method: string) => {
            if (platform === "onebot") return method.startsWith("onebot.") || method.startsWith("qq.");
            return method.startsWith(`${platform}.`);
        },
        getWriteMethods: () => {
            if (platform === "onebot") {
                return [
                    "onebot.sendMessage", "onebot.sendAt", "onebot.sendText", "onebot.sendMedia",
                    "onebot.sendFile", "onebot.sendSticker", "onebot.sendFace", "onebot.sendTyping",
                    "onebot.deleteMessages",
                    "qq.sendMessage", "qq.sendAt", "qq.sendText", "qq.sendMedia",
                    "qq.sendFile", "qq.sendSticker", "qq.sendFace", "qq.sendTyping",
                    "qq.deleteMessages",
                ];
            }
            if (platform === "feishu") {
                return [
                    "feishu.sendText", "feishu.sendMessage", "feishu.sendMedia", "feishu.sendSticker",
                    "feishu.sendTemplateCard", "feishu.sendCard", "feishu.updateTemplateCard",
                    "feishu.updateCard", "feishu.patchCard", "feishu.streamCardText", "feishu.leaveChat",
                ];
            }
            if (platform === "discord") {
                return [
                    "discord.send", "discord.createMessage", "discord.sendText",
                    "discord.sendMedia", "discord.sendReaction", "discord.sendTyping",
                ];
            }
            return [
                "telegram.sendText", "telegram.sendMedia", "telegram.sendFile", "telegram.sendSticker",
                "telegram.sendTyping", "telegram.sendMediaGroup", "telegram.forwardMessage",
                "telegram.sendPoll", "telegram.sendInlineBotResult", "telegram.sendReaction",
                "telegram.editMessage", "telegram.deleteMessages", "telegram.pinMessage",
                "telegram.unpinMessage", "telegram.sendStory", "telegram.sendStoryReaction",
            ];
        },
        handleCall: async (method: string, args: unknown[]) => {
            adapterCalls.push({ method, args });
            return { ok: true };
        },
    }));

    const handler = createSandboxHostCallHandler(boundChatId, {
        appConfig: {} as any,
        globalState: {
            getSchedulerEvents: () => [],
            addReminder: (...args: unknown[]) => {
                const evt = { id: "rem-1", createdAt: new Date().toISOString(), args };
                reminders.push(evt);
                return evt;
            },
            addCron: (...args: unknown[]) => {
                const evt = { id: "cron-1", createdAt: new Date().toISOString(), args };
                crons.push(evt);
                return evt;
            },
        } as any,
        accumulator: { ingest: () => undefined } as any,
        memory: {
            getGroupModel: () => null,
        } as any,
        adapters: adapters as any,
        sandbox: {} as any,
        sandboxPool: {} as any,
        mcpBridge: {} as any,
        dispatchApi: {
            taskToGroup: async (chatId: string, spec: unknown, options?: unknown) => {
                dispatched.push({ chatId, spec, options });
                return { taskId: "task-1" };
            },
            getTask: async () => null,
            listTasks: async () => ({ tasks: [], total: 0, hasMore: false }),
        },
        buildEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
        getCurrentEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
        setCurrentEnvPlan: () => undefined,
        applyHostManagedEnv: () => undefined,
    });

    return { handler, adapterCalls, dispatched, reminders, crons };
}

afterEach(() => {
    clearConfigCache();
});

after(() => {
    clearConfigCache();
    for (const dir of tempDirs) {
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe("outbound chat_filter enforcement", () => {
    it("blocks dispatch.taskToGroup for non-whitelisted or blacklisted chats and allows once released", async () => {
        const configPath = applyChatFilterConfig({
            enabled: true,
            mode: "whitelist",
            chatIds: [],
        });

        const enqueued: unknown[] = [];
        const marked: string[] = [];
        let getOrCreateCalls = 0;

        const api = createDispatchApi({
            memory: {} as any,
            subagentManager: {
                getOrCreate: (chatId: string) => {
                    getOrCreateCalls++;
                    return {
                        chatId,
                        codeActExecutor: {
                            enqueue: (task: unknown) => enqueued.push(task),
                            getSessionFilePath: () => `workspace/sessions/${chatId}.json`,
                        },
                    } as any;
                },
                getSessionFilePath: (chatId: string) => `workspace/sessions/${chatId}.json`,
            },
            accumulator: {
                markActioned: (chatId: string) => marked.push(chatId),
            } as any,
            taskIdFactory: () => "task-allowed",
        });

        await assert.rejects(
            () => api.taskToGroup("onebot:group:10001", { contentDirection: "say hi" }),
            /\[Access control\].*onebot:group:10001.*chat_filter/,
        );
        assert.equal(getOrCreateCalls, 0);
        assert.equal(enqueued.length, 0);
        assert.deepEqual(marked, []);

        // Whitelist the chat on disk (hot-reload path without manual clearConfigCache)
        const released = releaseChatFromFilter(
            { enabled: true, mode: "whitelist", chatIds: [] },
            "onebot:group:10001",
        );
        const reloaded = loadConfig(configPath, true);
        reloaded.chatFilter = released;
        writeFileSync(configPath, serializeConfigToYAML(reloaded), "utf8");

        const res = await api.taskToGroup("onebot:group:10001", { contentDirection: "say hi" });
        assert.equal(res.taskId, "task-allowed");
        assert.equal(enqueued.length, 1);
        assert.deepEqual(marked, ["onebot:group:10001"]);

        // Other non-whitelisted chats remain blocked
        await assert.rejects(
            () => api.taskToGroup("onebot:group:10002", { contentDirection: "say hi" }),
            /\[Access control\].*onebot:group:10002.*chat_filter/,
        );

        // Blacklist mode blocks listed chat and allows after release
        writeFilterConfigFile(configPath, {
            enabled: true,
            mode: "blacklist",
            chatIds: ["telegram:-1002002"],
        });
        await assert.rejects(
            () => api.taskToGroup("telegram:-1002002", { contentDirection: "ping" }),
            /\[Access control\].*telegram:-1002002.*chat_filter/,
        );
        const tgAllowed = await api.taskToGroup("telegram:-1002001", { contentDirection: "ping" });
        assert.equal(tgAllowed.taskId, "task-allowed");

        writeFilterConfigFile(
            configPath,
            releaseChatFromFilter({ enabled: true, mode: "blacklist", chatIds: ["telegram:-1002002"] }, "telegram:-1002002"),
        );
        const tgReleased = await api.taskToGroup("telegram:-1002002", { contentDirection: "ping" });
        assert.equal(tgReleased.taskId, "task-allowed");
    });

    it("blocks sandbox platform wrapper and native/callApi writes when target or bound chat is filtered", async () => {
        applyChatFilterConfig({
            enabled: true,
            mode: "whitelist",
            chatIds: ["onebot:group:99999", "telegram:-100999", "discord:guild1:chan9", "feishu:oc_allowed"],
        });

        // 1. Whitelisted subagent trying to write to blocked targets across all 4 platforms
        const obAllowed = makeSandboxHandler("onebot:group:99999");
        for (const [method, args] of [
            ["onebot.sendText", ["onebot:group:10001", "hello"]],
            ["qq.sendText", ["group:10001", "hello"]],
            ["onebot.sendMedia", ["onebot:private:20002", { type: "photo", file: "a.png" }]],
            ["onebot.send_group_msg", [{ group_id: 10001, message: "hello" }]],
            ["onebot.callApi", ["send_group_msg", { group_id: 10001, message: "hello" }]],
            ["onebot.callApi", ["send_group_msg_async", { group_id: 10001, message: "hello" }]],
            ["onebot.callApi", ["send_msg", { user_id: 20002, message: "hi" }]],
            ["qq.callApi", ["send_private_msg", { user_id: 20002, message: "hi" }]],
            ["telegram.sendText", ["telegram:-1001001", "hello"]],
            ["telegram.joinChat", ["-1001001"]],
            ["discord.sendText", ["discord:guild1:chan1", "hello"]],
            ["discord.send", ["discord:guild1:chan1", "hello"]],
            ["feishu.sendText", ["feishu:oc_blocked", "hello"]],
            ["feishu.callApi", ["feishu:oc_blocked", "message.delete", { path: { message_id: "om_1" } }]],
        ] as Array<[string, unknown[]]>) {
            await assert.rejects(
                () => obAllowed.handler(method, args),
                /\[Access control\]/,
                `Expected ${method} to be blocked`,
            );
        }
        assert.deepEqual(obAllowed.adapterCalls, []);

        // Allowed writes to whitelisted targets succeed
        await obAllowed.handler("onebot.sendText", ["onebot:group:99999", "allowed"]);
        await obAllowed.handler("onebot.callApi", ["send_group_msg", { group_id: 99999, message: "allowed native" }]);
        await obAllowed.handler("onebot.send_group_msg", [{ group_id: 99999, message: "allowed direct" }]);
        assert.equal(obAllowed.adapterCalls.length, 3);

        // 2. __background__ sandbox (MCP sandbox_call): blocks writes to filtered chats, allows self-ops
        const bg = makeSandboxHandler("__background__");
        await assert.rejects(
            () => bg.handler("onebot.callApi", ["send_group_msg", { group_id: 10001, message: "leak" }]),
            /\[Access control\]/,
        );
        await assert.rejects(
            () => bg.handler("telegram.sendText", ["telegram:-1001001", "leak"]),
            /\[Access control\]/,
        );
        await bg.handler("onebot.callApi", ["set_qq_profile", { nickname: "self-ok" }]);
        await bg.handler("telegram.mtcute", ["updateProfile", { bio: "self-ok" }]);
        assert.equal(bg.adapterCalls.length, 2);

        // 3. Blocked boundChatId cannot perform any platform writes (even self-ops or writes targeting whitelisted chat)
        const obBlocked = makeSandboxHandler("onebot:group:10001");
        await assert.rejects(
            () => obBlocked.handler("onebot.sendText", ["onebot:group:99999", "bypass"]),
            /\[Access control\].*onebot:group:10001/,
        );
        await assert.rejects(
            () => obBlocked.handler("onebot.callApi", ["set_msg_emoji_like", { message_id: "1", emoji_id: "1" }]),
            /\[Access control\].*onebot:group:10001/,
        );
        await assert.rejects(
            () => obBlocked.handler("dispatch.taskToGroup", ["onebot:group:99999", { contentDirection: "hi" }]),
            /\[Access control\].*onebot:group:10001/,
        );
        await assert.rejects(
            () => obBlocked.handler("cron.add", ["n", "0 * * * *", "desc"]),
            /\[Access control\].*onebot:group:10001/,
        );
        await assert.rejects(
            () => obBlocked.handler("runtime.remind", ["desc", 5]),
            /\[Access control\].*onebot:group:10001/,
        );
        assert.deepEqual(obBlocked.adapterCalls, []);
        assert.deepEqual(obBlocked.dispatched, []);
        assert.deepEqual(obBlocked.crons, []);
        assert.deepEqual(obBlocked.reminders, []);
    });

    it("suppresses emergency.block sendText notification when bound chat is blocked by chat_filter", async t => {
        applyChatFilterConfig({
            enabled: true,
            mode: "whitelist",
            chatIds: [],
        });
        const blockMock = t.mock.method(userGate, "block", () => ({ newlyBlocked: true }));
        const blocked = makeSandboxHandler("telegram:-1001001");

        const result = await blocked.handler("emergency.block", ["telegram:20002"]);
        assert.equal(blockMock.mock.callCount(), 1);
        assert.deepEqual(result, {
            userId: "telegram:20002",
            blocked: true,
            alreadyBlocked: false,
            notified: false,
        });
        assert.deepEqual(blocked.adapterCalls, []);
    });

    it("excludes chat_filter-blocked chats from conversations.inbox", async () => {
        const memory = createTestMemory("outbound-filter-inbox");
        try {
            memory.storeMessageBatch([
                {
                    messageId: "m-blocked",
                    chatId: "onebot:group:10001",
                    userId: "onebot:20001",
                    displayName: "UserOne",
                    text: "unread in blocked group",
                    timestamp: "2026-01-05T10:00:00Z",
                },
                {
                    messageId: "m-allowed",
                    chatId: "onebot:group:99999",
                    userId: "onebot:20002",
                    displayName: "UserTwo",
                    text: "unread in allowed group",
                    timestamp: "2026-01-05T11:00:00Z",
                },
            ]);
            memory.upsertGroupModel("onebot:group:10001", { chatTitle: "Blocked Group" });
            memory.upsertGroupModel("onebot:group:99999", { chatTitle: "Allowed Group" });

            const api = createConversationsApi(memory, {
                getAllSubagents: () => [
                    { chatId: "onebot:group:10001", lastAttendedAt: null, observer: { getBufferSize: () => 2 } },
                    { chatId: "onebot:group:99999", lastAttendedAt: null, observer: { getBufferSize: () => 1 } },
                ],
            });

            const configPath = applyChatFilterConfig({
                enabled: true,
                mode: "whitelist",
                chatIds: ["onebot:group:99999"],
            });

            const whitelistedInbox = await api.inbox({ limit: 20 });
            assert.deepEqual(whitelistedInbox.items.map((item) => item.chatId), ["onebot:group:99999"]);
            assert.equal(whitelistedInbox.total, 1);
            assert.equal(whitelistedInbox.unreadTotal, 1);

            // Even explicit chatIds filter cannot surface a blocked chat in inbox
            const explicitBlocked = await api.inbox({ chatIds: ["onebot:group:10001"] });
            assert.deepEqual(explicitBlocked.items, []);
            assert.equal(explicitBlocked.total, 0);

            // Blacklist mode excludes only the blacklisted chat
            writeFilterConfigFile(configPath, {
                enabled: true,
                mode: "blacklist",
                chatIds: ["onebot:group:99999"],
            });
            const blacklistInbox = await api.inbox({ limit: 20 });
            assert.deepEqual(blacklistInbox.items.map((item) => item.chatId), ["onebot:group:10001"]);
        } finally {
            cleanupTestMemory(memory, "outbound-filter-inbox");
        }
    });

    it("enforces chat_filter in MCP notify/attention_enqueue and scheduler APIs", async () => {
        applyChatFilterConfig({
            enabled: true,
            mode: "whitelist",
            chatIds: ["onebot:group:99999"],
        });

        const tools = new Map<string, (input: any) => Promise<unknown>>();
        const dispatched: unknown[] = [];
        const metaAttention: unknown[] = [];

        registerNotifyTools(
            {
                tool: (name: string, ...args: any[]) => {
                    tools.set(name, args.at(-1));
                },
            } as any,
            {
                globalState: { addSessionDigest: () => ({}) },
                accumulator: { ingest: (_layer: number, item: unknown) => metaAttention.push(item) },
                metaApi: {
                    dispatch: {
                        taskToGroup: async (chatId: string, spec: unknown) => {
                            dispatched.push({ chatId, spec });
                            return { taskId: "mcp-task-1" };
                        },
                    },
                },
            } as any,
        );

        await assert.rejects(
            () => tools.get("notify")!({ to: "onebot:group:10001", content: "proactive ping" }),
            /\[Access control\]/,
        );
        await assert.rejects(
            () => tools.get("attention_enqueue")!({
                target: "onebot:group:10001",
                actorId: "harness:test",
                triggerReason: "test",
                summary: "blocked target",
            }),
            /\[Access control\]/,
        );
        assert.deepEqual(dispatched, []);

        // Meta notifications and whitelisted targets still work
        await tools.get("notify")!({ to: "meta", content: "internal note" });
        await tools.get("notify")!({ to: "onebot:group:99999", content: "allowed ping" });
        assert.equal(metaAttention.length, 1);
        assert.equal(dispatched.length, 1);

        // Scheduler APIs reject blocked bindingIds and allow meta / whitelisted bindingIds
        const events: any[] = [];
        const schedulerState = {
            addReminder: (chatId: string, description: string, triggerAt: string, requestedBy: string, options: any) => {
                const evt = { id: `rem-${events.length + 1}`, type: "reminder", chatId, description, triggerAt, requestedBy, createdAt: "now", ...options };
                events.push(evt);
                return evt;
            },
            addCron: (chatId: string, description: string, cronExpr: string, taskTemplate: string, options: any) => {
                const evt = { id: `cron-${events.length + 1}`, type: "cron", chatId, description, cronExpr, taskTemplate, createdAt: "now", ...options };
                events.push(evt);
                return evt;
            },
            getSchedulerEvents: () => events,
            cancelSchedulerEvent: () => true,
            updateSchedulerEvent: (id: string, patch: any) => ({ id, ...patch }),
        } as any;

        const remindApi = createReminderApi(schedulerState);
        const cronApi = createCronApi(schedulerState);

        await assert.rejects(
            () => remindApi.set({ name: "r1", callback: "ping", bindingId: "onebot:group:10001", delayMinutes: 5 }),
            /\[Access control\]/,
        );
        await assert.rejects(
            () => cronApi.set({ name: "c1", cronExpr: "0 * * * *", callback: "ping", bindingId: "onebot:group:10001" }),
            /\[Access control\]/,
        );

        const metaRem = await remindApi.set({ name: "meta-r", callback: "check", delayMinutes: 5 });
        assert.equal(metaRem.bindingId, "meta");
        await assert.rejects(
            () => remindApi.update(metaRem.id, { bindingId: "onebot:group:10001" }),
            /\[Access control\]/,
        );

        const allowedCron = await cronApi.set({ name: "c-ok", cronExpr: "0 * * * *", callback: "ping", bindingId: "onebot:group:99999" });
        assert.equal(allowedCron.bindingId, "onebot:group:99999");
        await assert.rejects(
            () => cronApi.update(allowedCron.id, { bindingId: "onebot:group:10001" }),
            /\[Access control\]/,
        );
    });

    it("skips queued attention items and dispatch source notifications for blocked chats in MainAgentLoop", async () => {
        const dir = makeTempDir("outbound-filter-loop");
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 5 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);

        const blockedSub = subagentManager.getOrCreate("onebot:group:10001");
        const sourceEnqueued: unknown[] = [];
        blockedSub.codeActExecutor = { enqueue: (task: unknown) => sourceEnqueued.push(task) };

        const allowedSub = subagentManager.getOrCreate("onebot:group:99999");
        allowedSub.codeActExecutor = { enqueue: () => undefined };

        globalState.recordDispatchedSubagentTask({
            taskId: "t-from-blocked",
            chatId: "onebot:group:99999",
            sourceType: "subagent",
            sourceChatId: "onebot:group:10001",
            contentDirection: "test",
            createdAt: new Date().toISOString(),
        });

        applyChatFilterConfig({
            enabled: true,
            mode: "whitelist",
            chatIds: ["onebot:group:99999"],
        });

        accumulator.ingest(0, createDirectAddressItem("onebot:group:10001", {
            reason: "stale pre-filter wake",
            queueEntry: blockedSub.buildQueueEntry("DIRECT_ADDRESS"),
        }));
        accumulator.ingest(0, createDirectAddressItem("onebot:group:99999", {
            reason: "allowed wake",
            queueEntry: allowedSub.buildQueueEntry("DIRECT_ADDRESS"),
        }));
        callbackQueue.enqueue({
            taskId: "t-from-blocked",
            chatId: "onebot:group:99999",
            status: "COMPLETED",
            summary: "done",
            durationMs: 10,
            executionType: "CODEACT",
            completedAt: new Date().toISOString(),
        });

        const attendedChats: string[] = [];
        loop.setMetaSessionHandler(async (entries) => {
            attendedChats.push(...entries.map((e) => e.chatId));
            return {
                endReason: "end_turn",
                turns: [],
                messages: [],
                attendResults: [],
            } as any;
        });

        await loop.tick();
        assert.deepEqual(attendedChats, ["onebot:group:99999"]);
        assert.deepEqual(sourceEnqueued, []);
    });

    it("suppresses PROACTIVE_IDLE wakeups when chat_filter is an empty whitelist", async () => {
        const dir = makeTempDir("outbound-filter-idle");
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 5 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);

        // Force idle duration past 15-minute PROACTIVE_IDLE_INITIAL_DELAY_MS
        (loop as any).lastNonIdleActivityAt = Date.now() - 20 * 60 * 1000;

        const attendedChats: string[] = [];
        let proactiveHandlerCalls = 0;
        loop.setProactiveIdleHandler(() => {
            proactiveHandlerCalls++;
            return true;
        });
        loop.setMetaSessionHandler(async (entries) => {
            attendedChats.push(...entries.map((e) => e.chatId));
            return {
                endReason: "end_turn",
                turns: [],
                messages: [],
                attendResults: [],
            } as any;
        });

        const configPath = applyChatFilterConfig({
            enabled: true,
            mode: "whitelist",
            chatIds: [],
            userIds: [],
        });

        await loop.tick();
        assert.equal(proactiveHandlerCalls, 0);
        assert.deepEqual(attendedChats, []);

        // Also check fallback path when proactiveIdleHandler is null
        loop.setProactiveIdleHandler(null);
        await loop.tick();
        assert.deepEqual(attendedChats, []);

        // Once at least one chat is whitelisted, PROACTIVE_IDLE is allowed again
        writeFilterConfigFile(configPath, {
            enabled: true,
            mode: "whitelist",
            chatIds: ["onebot:group:99999"],
        });
        await loop.tick();
        assert.deepEqual(attendedChats, ["__meta__"]);
    });

    it("enforces chat_filter on conversations.messages/query, todo APIs, and cross-chat platform reads", async () => {
        const memory = createTestMemory("outbound-filter-read-todo");
        try {
            memory.storeMessageBatch([
                {
                    messageId: "m-blocked-1",
                    chatId: "onebot:group:10001",
                    userId: "onebot:20001",
                    displayName: "UserOne",
                    text: "secret keyword alpha",
                    timestamp: "2026-01-05T10:00:00Z",
                },
                {
                    messageId: "m-allowed-1",
                    chatId: "onebot:group:99999",
                    userId: "onebot:20002",
                    displayName: "UserTwo",
                    text: "public keyword alpha",
                    timestamp: "2026-01-05T11:00:00Z",
                },
            ]);
            memory.upsertGroupModel("onebot:group:10001", { chatTitle: "Blocked Group" });
            memory.upsertGroupModel("onebot:group:99999", { chatTitle: "Allowed Group" });
            memory.todoUpsert("onebot:group:10001", "stale_probe", "blocked probe", null);
            memory.todoUpsert("onebot:group:99999", "allowed_todo", "allowed item", null);
            memory.todoUpsert("meta", "meta_todo", "global item", null);

            applyChatFilterConfig({
                enabled: true,
                mode: "whitelist",
                chatIds: ["onebot:group:99999", "telegram:-100999"],
            });

            const convApi = createConversationsApi(memory);
            await assert.rejects(
                () => convApi.messages("onebot:group:10001"),
                /\[Access control\].*conversations\.messages.*onebot:group:10001/,
            );
            const allowedMsgs = await convApi.messages("onebot:group:99999");
            assert.equal(allowedMsgs.messages.length, 1);

            const globalQuery = await convApi.query({ keyword: "alpha" });
            assert.deepEqual(globalQuery.messages.map((m) => m.chatId), ["onebot:group:99999"]);

            const blockedQuery = await convApi.query({ chatIds: ["onebot:group:10001"], keyword: "alpha" });
            assert.deepEqual(blockedQuery.messages, []);

            const todoApi = createTodoApi(memory);
            const listedTodos = await todoApi.list({ includeExpired: true });
            assert.deepEqual(
                listedTodos.map((t) => t.bindingId).sort(),
                ["meta", "onebot:group:99999"],
            );
            assert.equal(await todoApi.get("stale_probe", "onebot:group:10001"), null);
            await assert.rejects(
                () => todoApi.set({ key: "k1", content: "c1", bindingId: "onebot:group:10001" }),
                /\[Access control\].*todo\.set/,
            );

            // Cross-chat platform read calls & blocked subagent runtime.elevate
            const allowedSub = makeSandboxHandler("onebot:group:99999");
            await assert.rejects(
                () => allowedSub.handler("onebot.callApi", ["get_group_msg_history", { group_id: 10001, count: 20 }]),
                /\[Access control\].*onebot:group:10001/,
            );
            await assert.rejects(
                () => allowedSub.handler("onebot.callApi", ["get_friend_msg_history", { user_id: 20002, count: 20 }]),
                /\[Access control\].*onebot:private:20002/,
            );
            await assert.rejects(
                () => allowedSub.handler("telegram.getHistory", ["telegram:-1001001", { limit: 10 }]),
                /\[Access control\].*telegram:-1001001/,
            );
            await allowedSub.handler("onebot.callApi", ["get_group_msg_history", { group_id: 99999, count: 20 }]);
            await allowedSub.handler("onebot.callApi", ["get_login_info", {}]);
            assert.equal(allowedSub.adapterCalls.length, 2);

            const blockedSub = makeSandboxHandler("onebot:group:10001");
            await assert.rejects(
                () => blockedSub.handler("onebot.callApi", ["get_login_info", {}]),
                /\[Access control\].*onebot:group:10001/,
            );
            await assert.rejects(
                () => blockedSub.handler("runtime.elevate", ["need meta help"]),
                /\[Access control\].*onebot:group:10001/,
            );
        } finally {
            cleanupTestMemory(memory, "outbound-filter-read-todo");
        }
    });
});
