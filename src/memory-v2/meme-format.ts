import { MEME_VARIANT_SPLIT_RE } from "./text-similarity.js";

export interface MemeUsageInfo {
    messages: number;
    senders: number;
}

export interface MemeFactFields {
    term: string;
    variants: string[];
    meaning: string;
    originContext: string;
    participants: string[];
    usageBoundaries: string;
    usage: MemeUsageInfo | null;
}

export interface BuildMemeFactInput {
    term: string;
    meaning: string;
    originContext?: string | null;
    participants?: readonly string[];
    usageBoundaries: string;
    usage?: {
        messages?: number;
        senders?: number;
        messageCount?: number;
        senderCount?: number;
    } | null;
}

export type MemeFlag = "short_term" | "low_usage";

const SECTION_HEADER_RE = /(?:^|[；;\r\n])\s*(真实含义|来源背景|相关成员|使用边界|使用情况)\s*[:：]\s*/g;
const TERM_PREFIX_RE = /^\[群梗:\s*(.+?)\](?:[；;\r\n]|$)/;
const TERM_ANYWHERE_RE = /\[群梗:\s*([^\]\r\n]+)\]/;
const USAGE_COUNTS_RE = /(\d+)\s*条(?:消息)?\D*(\d+)\s*人/;

export function splitMemeVariants(term: string): string[] {
    if (!term || typeof term !== "string") return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of term.split(MEME_VARIANT_SPLIT_RE)) {
        const clean = part.trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

export function buildMemeFactContent(input: BuildMemeFactInput): string {
    const term = String(input.term ?? "").trim();
    const meaning = String(input.meaning ?? "").trim();
    const originContext = String(input.originContext ?? "").trim();
    const usageBoundaries = String(input.usageBoundaries ?? "").trim();

    const participants: string[] = [];
    const seenParticipants = new Set<string>();
    for (const raw of input.participants ?? []) {
        if (typeof raw !== "string") continue;
        const clean = raw.trim();
        if (!clean || seenParticipants.has(clean)) continue;
        seenParticipants.add(clean);
        participants.push(clean);
    }

    const msgCount = input.usage?.messages ?? input.usage?.messageCount;
    const senderCount = input.usage?.senders ?? input.usage?.senderCount;
    const hasUsage = typeof msgCount === "number"
        && Number.isFinite(msgCount)
        && msgCount >= 0
        && typeof senderCount === "number"
        && Number.isFinite(senderCount)
        && senderCount >= 0;

    const parts = [
        `[群梗: ${term}]`,
        `真实含义: ${meaning}`,
        originContext ? `来源背景: ${originContext}` : "",
        participants.length > 0 ? `相关成员: ${participants.join(", ")}` : "",
        `使用边界: ${usageBoundaries}`,
        hasUsage
            ? `使用情况: 导入的历史中 ${Math.floor(msgCount!)} 条消息、${Math.floor(senderCount!)} 人用过`
            : "",
    ].filter(Boolean);

    return parts.join("；");
}

export function parseMemeFactContent(content: string): MemeFactFields {
    const raw = typeof content === "string" ? content.trim() : "";
    if (!raw) {
        return {
            term: "",
            variants: [],
            meaning: "",
            originContext: "",
            participants: [],
            usageBoundaries: "",
            usage: null,
        };
    }

    let term = "";
    let remainder = raw;

    const prefixMatch = TERM_PREFIX_RE.exec(raw);
    if (prefixMatch) {
        term = prefixMatch[1].trim();
        remainder = raw.slice(prefixMatch[0].length).replace(/^[；;\s]+/, "");
    } else {
        const anywhereMatch = TERM_ANYWHERE_RE.exec(raw);
        if (anywhereMatch) {
            term = anywhereMatch[1].trim();
            const afterIdx = anywhereMatch.index + anywhereMatch[0].length;
            remainder = raw.slice(afterIdx).replace(/^[；;\s]+/, "");
        }
    }

    const variants = splitMemeVariants(term);

    const sections: Array<{ label: string; headerStart: number; valueStart: number }> = [];
    SECTION_HEADER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SECTION_HEADER_RE.exec(remainder)) !== null) {
        sections.push({
            label: match[1],
            headerStart: match.index,
            valueStart: match.index + match[0].length,
        });
    }

    let meaning = "";
    let originContext = "";
    let usageBoundaries = "";
    const participants: string[] = [];
    const seenParticipants = new Set<string>();
    let usage: MemeUsageInfo | null = null;

    for (let i = 0; i < sections.length; i++) {
        const cur = sections[i];
        const end = i + 1 < sections.length ? sections[i + 1].headerStart : remainder.length;
        const value = remainder.slice(cur.valueStart, end).replace(/[；;\s]+$/, "").trim();

        switch (cur.label) {
            case "真实含义":
                if (!meaning && value) meaning = value;
                break;
            case "来源背景":
                if (!originContext && value) originContext = value;
                break;
            case "使用边界":
                if (!usageBoundaries && value) usageBoundaries = value;
                break;
            case "相关成员":
                for (const part of value.split(/[,，、\s]+/)) {
                    const clean = part.trim();
                    if (!clean || seenParticipants.has(clean)) continue;
                    seenParticipants.add(clean);
                    participants.push(clean);
                }
                break;
            case "使用情况": {
                const usageMatch = USAGE_COUNTS_RE.exec(value);
                if (usageMatch) {
                    const messages = Number.parseInt(usageMatch[1], 10);
                    const senders = Number.parseInt(usageMatch[2], 10);
                    if (Number.isFinite(messages) && Number.isFinite(senders)) {
                        usage = { messages, senders };
                    }
                }
                break;
            }
        }
    }

    return {
        term,
        variants,
        meaning,
        originContext,
        participants,
        usageBoundaries,
        usage,
    };
}

export function computeMemeFlags(
    variants: readonly string[],
    usage: MemeUsageInfo | null,
): MemeFlag[] {
    const flags: MemeFlag[] = [];
    if (variants.length > 0 && variants.every(v => Array.from(v.trim()).length <= 2)) {
        flags.push("short_term");
    }
    if (usage !== null && usage.senders <= 2 && usage.messages <= 3) {
        flags.push("low_usage");
    }
    return flags;
}
