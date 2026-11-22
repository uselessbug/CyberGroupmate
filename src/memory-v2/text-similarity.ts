/**
 * Deterministic text normalization and character-bigram overlap similarity helpers
 * shared between offline synthesis grounding and history-store list/fact merges.
 */

export const NEAR_DUPLICATE_OVERLAP_THRESHOLD = 0.5;
export const MEME_VARIANT_SPLIT_RE = /[/／|｜]/;

/**
 * Extract the `[群梗: ...]` term header from a stored historical anecdote fact content.
 */
export function extractMemeTermFromFactContent(content: string): string | null {
    const trimmed = content.trim();
    const match = /^\[群梗:\s*(.+?)\](?:；|$)/.exec(trimmed)
        ?? /^\[群梗:\s*([^\]]+)\]/.exec(trimmed);
    const term = match?.[1]?.trim();
    return term ? term : null;
}

/**
 * Split a meme term into variants and return deduplicated normalized variants.
 */
export function extractNormalizedMemeVariants(term: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of term.split(MEME_VARIANT_SPLIT_RE)) {
        const norm = normalizeForComparison(part);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
    }
    return out;
}

export function hasOverlappingMemeVariant(
    variants: readonly string[],
    knownVariants: ReadonlySet<string>,
): boolean {
    return variants.some(v => knownVariants.has(v));
}

/**
 * Normalize text for comparison: NFKC, lowercase, strip whitespace and punctuation.
 */
export function normalizeForComparison(text: string): string {
    return text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s\p{P}]/gu, "");
}

/**
 * Extract unique character bigrams from an already-normalized string (code-point safe).
 */
export function toCharBigramSet(normalized: string): Set<string> {
    const chars = Array.from(normalized);
    const bigrams = new Set<string>();
    for (let i = 0; i < chars.length - 1; i++) {
        bigrams.add(chars[i] + chars[i + 1]);
    }
    return bigrams;
}

/**
 * Character-bigram overlap coefficient: |A ∩ B| / min(|A|, |B|) on normalized text.
 * Returns 1 when both normalize to identical non-empty strings, 0 when either is empty or has no bigrams.
 */
export function bigramOverlapCoefficient(a: string, b: string): number {
    const normA = normalizeForComparison(a);
    const normB = normalizeForComparison(b);
    if (!normA || !normB) return 0;
    if (normA === normB) return 1;
    const setA = toCharBigramSet(normA);
    const setB = toCharBigramSet(normB);
    const minSize = Math.min(setA.size, setB.size);
    if (minSize === 0) return 0;
    let intersection = 0;
    const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const bg of smaller) {
        if (larger.has(bg)) intersection++;
    }
    return intersection / minSize;
}

export function isNearDuplicateText(
    a: string,
    b: string,
    threshold: number = NEAR_DUPLICATE_OVERLAP_THRESHOLD,
): boolean {
    return bigramOverlapCoefficient(a, b) >= threshold;
}

/**
 * Merge `existing` and `incoming` string lists up to `cap`, keeping existing items first
 * and skipping incoming items that are near-duplicates of any already-kept item.
 */
export function mergeStringsNearDedupe(
    existing: readonly string[],
    incoming: readonly string[],
    cap: number,
    threshold: number = NEAR_DUPLICATE_OVERLAP_THRESHOLD,
): string[] {
    const out: string[] = [];
    const pushIfNovel = (raw: string) => {
        if (typeof raw !== "string") return;
        const trimmed = raw.trim();
        if (!trimmed || out.length >= cap) return;
        if (out.some(kept => isNearDuplicateText(kept, trimmed, threshold))) {
            return;
        }
        out.push(trimmed);
    };

    for (const item of existing) {
        pushIfNovel(item);
        if (out.length >= cap) return out;
    }
    for (const item of incoming) {
        pushIfNovel(item);
        if (out.length >= cap) break;
    }
    return out;
}
