/** Platform-derived mention metadata. Missing means unknown (including legacy rows). */
export interface MessageMention {
    userId: string;
    displayName?: string;
    isAll?: boolean;
    rawUserId?: string;
    isSelf?: boolean;
    nameSource?: "chat" | "account_fallback" | "qce";
}

/** Never infer a mention or an account from human-readable message text. */
export function readMessageMentions(value: unknown): MessageMention[] | undefined {
    if (value == null) return undefined;
    let parsed = value;
    if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { return undefined; }
    }
    if (!Array.isArray(parsed)) return undefined;
    const mentions: MessageMention[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
        if (!item || typeof item !== "object" || typeof item.userId !== "string" || !item.userId.trim()) {
            return undefined;
        }
        const userId = item.userId.trim();
        if (seen.has(userId)) continue;
        seen.add(userId);
        const nameSource = item.nameSource === "chat" || item.nameSource === "account_fallback" || item.nameSource === "qce"
            ? item.nameSource
            : undefined;
        mentions.push({
            userId,
            ...(typeof item.displayName === "string" ? { displayName: item.displayName } : {}),
            ...(item.isAll === true ? { isAll: true } : {}),
            ...(typeof item.rawUserId === "string" && item.rawUserId.trim() ? { rawUserId: item.rawUserId.trim() } : {}),
            ...(item.isSelf === true ? { isSelf: true } : {}),
            ...(nameSource ? { nameSource } : {}),
        });
    }
    return mentions;
}

export function formatMessageSender(name?: string, userId?: string): string {
    const label = (name || userId || "?").replace(/[\r\n\t]/g, " ");
    return userId ? `${label} [userId:${userId}]` : label;
}

export function formatMessageMentions(mentions: MessageMention[] | undefined, text = ""): string {
    if (mentions === undefined) return text.includes("@") ? " [mentions:unknown]" : "";
    if (mentions.length === 0) return text.includes("@") ? " [mentions:none]" : "";
    return ` [mentions:${mentions.map(mention => mention.userId).join(",")}]`;
}
