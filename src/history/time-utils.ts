import { HistoryUsageError } from "./errors.js";

const TZ_OFFSET_ONLY_RE = /^[+-]\d{1,2}(?::?\d{2})?$/;
const TZ_FIXED_PREFIX_RE = /^(?:UTC|GMT)[+-]/i;
const EXPLICIT_OFFSET_TS_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const WALL_CLOCK_TS_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/;

export function assertValidIanaTimezone(timezone: string): string {
    const trimmed = typeof timezone === "string" ? timezone.trim() : "";
    if (!trimmed) {
        throw new HistoryUsageError("Invalid timezone: must be a non-empty IANA timezone identifier");
    }
    if (TZ_OFFSET_ONLY_RE.test(trimmed) || TZ_FIXED_PREFIX_RE.test(trimmed)) {
        throw new HistoryUsageError(
            `Invalid IANA timezone "${timezone}": fixed offset strings are not allowed; use an IANA zone such as "Asia/Shanghai" or "UTC"`,
        );
    }
    try {
        const fmt = new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
        const resolved = fmt.resolvedOptions().timeZone;
        if (!resolved || TZ_OFFSET_ONLY_RE.test(resolved)) {
            throw new Error("not an IANA zone");
        }
        return trimmed;
    } catch {
        throw new HistoryUsageError(`Invalid IANA timezone: "${timezone}"`);
    }
}

function getZoneCalendarParts(utcMs: number, timezone: string): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    ms: number;
} {
    const date = new Date(utcMs);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(date);
    const getNum = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0);
    return {
        year: getNum("year"),
        month: getNum("month"),
        day: getNum("day"),
        hour: getNum("hour"),
        minute: getNum("minute"),
        second: getNum("second"),
        ms: date.getUTCMilliseconds(),
    };
}

export function getTimezoneOffsetMs(utcMs: number, timezone: string): number {
    const p = getZoneCalendarParts(utcMs, timezone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);
    return asUtc - utcMs;
}

function isValidCalendarAndTime(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
): boolean {
    if (
        month < 1 || month > 12
        || day < 1 || day > 31
        || hour < 0 || hour > 23
        || minute < 0 || minute > 59
        || second < 0 || second > 59
    ) {
        return false;
    }
    const check = new Date(Date.UTC(year, month - 1, day));
    return (
        check.getUTCFullYear() === year
        && check.getUTCMonth() === month - 1
        && check.getUTCDate() === day
    );
}

/**
 * Deterministic wall-clock -> UTC ms conversion in an IANA timezone:
 * - DST fall-back fold (ambiguous wall time): selects the earlier (DST) occurrence consistently.
 * - DST spring-forward gap (non-existent wall time): shifts forward past the transition deterministically.
 */
export function zonedWallTimeToUtcMs(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    ms: number,
    timezone: string,
): number {
    const wallUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    const offset1 = getTimezoneOffsetMs(wallUtc, timezone);
    const candidate1 = wallUtc - offset1;
    const offset2 = getTimezoneOffsetMs(candidate1, timezone);
    const candidate2 = wallUtc - offset2;

    const p2 = getZoneCalendarParts(candidate2, timezone);
    if (
        p2.year === year
        && p2.month === month
        && p2.day === day
        && p2.hour === hour
        && p2.minute === minute
    ) {
        return candidate2;
    }

    // Wall clock fell inside a DST spring-forward gap; candidate1 lands post-transition cleanly.
    return candidate1;
}

export function parseTimeStrInZone(rawTimeStr: string, timezone: string): number | null {
    const s = rawTimeStr.trim();
    if (!s) return null;

    const offsetMatch = EXPLICIT_OFFSET_TS_RE.exec(s);
    if (offsetMatch) {
        const year = Number(offsetMatch[1]);
        const month = Number(offsetMatch[2]);
        const day = Number(offsetMatch[3]);
        const hour = offsetMatch[4] !== undefined ? Number(offsetMatch[4]) : 0;
        const minute = offsetMatch[5] !== undefined ? Number(offsetMatch[5]) : 0;
        const second = offsetMatch[6] !== undefined ? Number(offsetMatch[6]) : 0;
        const ms = offsetMatch[7] !== undefined ? Number(offsetMatch[7].padEnd(3, "0")) : 0;
        const rawOffset = offsetMatch[8].toUpperCase();

        if (!isValidCalendarAndTime(year, month, day, hour, minute, second)) {
            return null;
        }

        let offsetMs = 0;
        if (rawOffset !== "Z") {
            const sign = rawOffset[0] === "-" ? -1 : 1;
            const digits = rawOffset.slice(1).replace(":", "");
            const offHours = Number(digits.slice(0, 2));
            const offMins = Number(digits.slice(2, 4));
            if (offHours > 23 || offMins > 59) return null;
            offsetMs = sign * (offHours * 60 + offMins) * 60_000;
        }

        const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMs;
        return Number.isFinite(utcMs) ? utcMs : null;
    }

    const dtMatch = WALL_CLOCK_TS_RE.exec(s);
    if (!dtMatch) return null;

    const year = Number(dtMatch[1]);
    const month = Number(dtMatch[2]);
    const day = Number(dtMatch[3]);
    const hour = dtMatch[4] !== undefined ? Number(dtMatch[4]) : 0;
    const minute = dtMatch[5] !== undefined ? Number(dtMatch[5]) : 0;
    const second = dtMatch[6] !== undefined ? Number(dtMatch[6]) : 0;
    const ms = dtMatch[7] !== undefined ? Number(dtMatch[7].padEnd(3, "0")) : 0;

    if (!isValidCalendarAndTime(year, month, day, hour, minute, second)) {
        return null;
    }

    const utcMs = zonedWallTimeToUtcMs(year, month, day, hour, minute, second, ms, timezone);
    return Number.isFinite(utcMs) ? utcMs : null;
}

export function parseStrictTimestampMs(raw: string, timezone: string, flagName: string): number {
    const tz = assertValidIanaTimezone(timezone);
    const s = raw.trim();
    if (!s) {
        throw new HistoryUsageError(`Invalid --${flagName} value: empty string`);
    }
    const ms = parseTimeStrInZone(s, tz);
    if (ms === null || !Number.isFinite(ms)) {
        throw new HistoryUsageError(
            `Invalid --${flagName} timestamp: "${raw}" (expected valid ISO-8601 or YYYY-MM-DD[ HH:mm:ss])`,
        );
    }
    return ms;
}
