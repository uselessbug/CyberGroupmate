import { cleanDisplayName, normalizeChatNameKey, type ChatNameObservation } from "./chat-names.js";
import type { RecentMessageEntry } from "./types.js";

function isEligibleMessage(message: RecentMessageEntry, chatId?: string): boolean {
    if (chatId && message.chatId !== chatId) return false;
    if (message.accessControlBlocked === true) return false;
    if (!message.userId || message.userId === "system") return false;
    if ((message as { recalled?: boolean }).recalled === true) return false;
    return true;
}

function matchSelfClaim(text: string): string | undefined {
    const claim = /^(?:以后)?(?:请)?(?:叫我|我叫|我的(?:昵称|名字|别名)(?:是|叫))\s*(.+?)[。！!]?$/u.exec(text.trim());
    return claim?.[1];
}

function groundScopedName(
    userId: string,
    candidate: string,
    evidence: RecentMessageEntry[],
    chatId: string,
): ChatNameObservation | null {
    const cleanCandidate = cleanDisplayName(candidate);
    if (!cleanCandidate || cleanCandidate.length > 80) return null;
    const targetKey = normalizeChatNameKey(cleanCandidate);
    if (!targetKey) return null;

    for (const message of evidence) {
        if (!isEligibleMessage(message, chatId)) continue;
        if (message.userId === userId) {
            const ownDisplay = cleanDisplayName(message.displayName);
            if (ownDisplay && normalizeChatNameKey(ownDisplay) === targetKey) {
                return {
                    chatId,
                    messageId: message.messageId,
                    userId,
                    kind: "sender_display",
                    displayName: ownDisplay,
                    observedAt: message.timestamp,
                };
            }
            const selfClaim = matchSelfClaim(message.text);
            if (selfClaim) {
                const cleanClaim = cleanDisplayName(selfClaim);
                if (cleanClaim && normalizeChatNameKey(cleanClaim) === targetKey) {
                    return {
                        chatId,
                        messageId: message.messageId,
                        userId,
                        kind: "self_claim",
                        displayName: cleanClaim,
                        observedAt: message.timestamp,
                    };
                }
            }
        }

        if (Array.isArray(message.mentions)) {
            const isOneBot = chatId.startsWith("onebot:");
            for (const mention of message.mentions) {
                if (!mention || mention.userId !== userId || mention.isAll === true || mention.nameSource === "account_fallback") {
                    continue;
                }
                if (isOneBot && mention.nameSource !== "chat" && mention.nameSource !== "qce") {
                    continue;
                }
                const mentionDisplay = cleanDisplayName(mention.displayName);
                if (mentionDisplay && normalizeChatNameKey(mentionDisplay) === targetKey) {
                    return {
                        chatId,
                        messageId: message.messageId,
                        userId,
                        kind: "mention_display",
                        displayName: mentionDisplay,
                        observedAt: message.timestamp,
                    };
                }
            }
        }
    }

    return null;
}

/** Reflection may propose aliases or chat-local names; only grounded platform/self evidence can confirm them. */
export function groundedIdentityUpdate(
    userId: string,
    proposal: { displayName?: string; aliases?: string[]; chatNames?: string[] },
    evidence: RecentMessageEntry[],
    existingAliases: string[] = [],
    scope?: { chatId: string; localOnly: boolean },
): { displayName?: string; aliases?: string[]; chatNames?: ChatNameObservation[] } {
    const result: { displayName?: string; aliases?: string[]; chatNames?: ChatNameObservation[] } = {};

    if (!scope) {
        const ownMessages = evidence.filter(message => message.userId === userId && isEligibleMessage(message));
        // Platform display names are written by ingestion. Reflection cannot rename an account.
        const aliases = (Array.isArray(proposal.aliases) ? proposal.aliases : []).filter(alias => {
            if (typeof alias !== "string" || !alias.trim() || alias.length > 80 || alias !== alias.trim()) return false;
            return ownMessages.some(message => {
                if (message.displayName === alias) return true;
                // Deliberately narrow: quotes, peer nicknames and role-play are not account evidence.
                return matchSelfClaim(message.text) === alias;
            });
        });
        if (aliases.length) result.aliases = [...new Set([...existingAliases, ...aliases])];
        return result;
    }

    const eligibleEvidence = evidence.filter(message => isEligibleMessage(message, scope.chatId));
    const groundedChatNames: ChatNameObservation[] = [];
    const seenObs = new Set<string>();

    const pushObservation = (obs: ChatNameObservation) => {
        const key = `${obs.messageId}\0${obs.kind}\0${normalizeChatNameKey(obs.displayName)}`;
        if (seenObs.has(key)) return;
        seenObs.add(key);
        groundedChatNames.push(obs);
    };

    const candidateNames: string[] = [];
    if (typeof proposal.displayName === "string") candidateNames.push(proposal.displayName);
    if (Array.isArray(proposal.aliases)) candidateNames.push(...proposal.aliases);
    if (Array.isArray(proposal.chatNames)) candidateNames.push(...proposal.chatNames);

    for (const candidate of candidateNames) {
        if (typeof candidate !== "string") continue;
        const obs = groundScopedName(userId, candidate, eligibleEvidence, scope.chatId);
        if (obs) {
            pushObservation(obs);
        }
    }

    if (groundedChatNames.length > 0) {
        result.chatNames = groundedChatNames;
    }

    if (!scope.localOnly) {
        const ownMessages = eligibleEvidence.filter(message => message.userId === userId);
        const aliases = (Array.isArray(proposal.aliases) ? proposal.aliases : []).filter(alias => {
            if (typeof alias !== "string" || !alias.trim() || alias.length > 80 || alias !== alias.trim()) return false;
            return ownMessages.some(message => {
                if (message.displayName === alias) return true;
                return matchSelfClaim(message.text) === alias;
            });
        });
        if (aliases.length) result.aliases = [...new Set([...existingAliases, ...aliases])];
    }

    return result;
}
