/**
 * tests/quotes-privacy.test.ts — 派发引用(quote)的 target-aware 隐私兜底回归
 *
 * 回归 bug：私密群内回复时，引用「该群自己」的原文被错误拦截（boundChatId="" 把本会话也当跨界）。
 * 正确：引用目标会话自己的私密内容放行；引用别的私密会话内容才拦截。
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearConfigCache } from "../src/core/config.js";
import { resolveQuoteRefs, type ParsedQuoteRef } from "../src/meta-sandbox/meta-api/quotes.js";

const PRIV = "telegram:-100priv";

function fakeMemory(): any {
    return {
        getGroupModel: (key: string) =>
            key === PRIV
                ? { chatId: PRIV, chatTitle: "私群", markedSensitive: true, isDirectMessage: false }
                : { chatId: key, chatTitle: key },
        getRecentMessages: () => [
            { messageId: "1", chatId: PRIV, userId: "u", displayName: "U", text: "secret cat msg", timestamp: new Date(0).toISOString() },
        ],
    };
}

const chatRef: ParsedQuoteRef = { kind: "chat", raw: `@${PRIV}`, chatId: PRIV, source: "test" };

describe("quote 隐私：派发引用按目标会话 target-aware", () => {
    before(() => clearConfigCache()); // 用默认 privacy（enforce=block）；markedSensitive 使 PRIV 判私密

    it("派发到该私密会话自己 → 引用其原文放行（修复点）", async () => {
        const r = await resolveQuoteRefs([chatRef], { memory: fakeMemory(), boundChatId: PRIV });
        assert.ok(r.items[0].content.includes("secret cat msg"), "本会话内引用应保留正文");
    });

    it("派发到别的会话 → 引用私密会话原文被拦截", async () => {
        const r = await resolveQuoteRefs([chatRef], { memory: fakeMemory(), boundChatId: "telegram:-100other" });
        assert.equal(r.items[0].content, "");
        assert.ok(r.items[0].warnings.some((w) => w.includes("私密")), "应给出隐私拦截警告");
    });

    it("无派发目标(boundChatId 省略) → 最严，私密内容拦截", async () => {
        const r = await resolveQuoteRefs([chatRef], { memory: fakeMemory() });
        assert.equal(r.items[0].content, "");
    });

    it("@person 指定显式 chatId 与派发目标 boundChatId 不一致 → 拒绝解析（不静默替换成目标会话）", async () => {
        const r = await resolveQuoteRefs(
            [{ kind: "person", raw: "@person[Alice in telegram:-100other]", query: "Alice", chatId: "telegram:-100other", source: "test" }],
            { memory: fakeMemory(), boundChatId: "telegram:-100target" },
        );
        assert.equal(r.items[0].content, "");
        assert.ok(r.items[0].warnings.some((w) => w.includes("不一致")));
    });

    it("被拦截的跨会话私密/历史 @topic quote 不得在 title 或 renderedMarkdown 中泄露外群 topic.label 或 summary", async () => {
        const privTopic = {
            id: "tp_priv_secret",
            chatId: PRIV,
            label: "绝密私群话题标题_PRIV_LABEL",
            summary: "绝密私群话题摘要_PRIV_SUMMARY",
            keywords: ["秘密"],
            participants: ["u1"],
            messageRange: { firstMessageId: 1, lastMessageId: 2, count: 2 },
            startedAt: "2026-01-01T00:00:00.000Z",
        };
        const foreignHistTopic = {
            id: "tp_hist_foreign",
            chatId: "telegram:-100foreign",
            historyKey: "hist_topic:foreign",
            label: "外群历史敏感标题_HIST_LABEL",
            summary: "外群历史敏感摘要_HIST_SUMMARY",
            keywords: ["历史"],
            participants: ["u2"],
            messageRange: { firstMessageId: 1, lastMessageId: 3, count: 3 },
            startedAt: "2025-01-01T00:00:00.000Z",
        };
        const mem: any = {
            ...fakeMemory(),
            getTopicById: (id: string) => (id === privTopic.id ? privTopic : id === foreignHistTopic.id ? foreignHistTopic : null),
        };

        const rPriv = await resolveQuoteRefs(
            [{ kind: "topic", raw: `@topic[${privTopic.id}]`, topicId: privTopic.id, source: "test" }],
            { memory: mem, boundChatId: "telegram:-100dest" },
        );
        assert.equal(rPriv.items[0].content, "");
        assert.equal(rPriv.items[0].title.includes(privTopic.label), false);
        assert.equal(rPriv.renderedMarkdown?.includes(privTopic.label), false);
        assert.equal(rPriv.renderedMarkdown?.includes(privTopic.summary), false);

        const rHist = await resolveQuoteRefs(
            [{ kind: "topic", raw: `@topic[${foreignHistTopic.id}]`, topicId: foreignHistTopic.id, source: "test" }],
            { memory: mem, boundChatId: "telegram:-100dest" },
        );
        assert.equal(rHist.items[0].content, "");
        assert.equal(rHist.items[0].title.includes(foreignHistTopic.label), false);
        assert.equal(rHist.renderedMarkdown?.includes(foreignHistTopic.label), false);
        assert.equal(rHist.renderedMarkdown?.includes(foreignHistTopic.summary), false);
    });
});
