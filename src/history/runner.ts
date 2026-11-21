import { loadConfig, type AppConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import type { MemoryStoreV2 } from "../memory-v2/memory-v2.js";
import {
    isChatPrivateOrSensitive,
    runHistoryInitializationWithMemory,
    type HistoryEmbedFn,
    type HistoryInitMode,
    type HistoryLlmCallFn,
    type HistorySleepFn,
} from "./initialize.js";

const log = createLogger("history-runner");

export interface HistoryRunnerRunningInfo {
    chatId: string;
    mode: HistoryInitMode;
    startedAt: string;
}

export type StartHistoryInitResult =
    | { ok: true; running: HistoryRunnerRunningInfo; resume: boolean }
    | { ok: false; error: "busy"; running: HistoryRunnerRunningInfo }
    | { ok: false; error: "private_consent_required" };

export interface HistoryInitRunnerDeps {
    memory: MemoryStoreV2;
    getConfig?: () => AppConfig;
    runInit?: typeof runHistoryInitializationWithMemory;
    llmCall?: HistoryLlmCallFn;
    embedFn?: HistoryEmbedFn;
    sleepFn?: HistorySleepFn;
    leaseTtlMs?: number;
}

interface ActiveRunState {
    chatId: string;
    mode: HistoryInitMode;
    startedAt: string;
    abortController: AbortController;
    promise: Promise<void>;
}

export class HistoryInitRunner {
    private active: ActiveRunState | null = null;
    private readonly memory: MemoryStoreV2;
    private readonly getConfig: () => AppConfig;
    private readonly runInit: typeof runHistoryInitializationWithMemory;

    constructor(private readonly deps: HistoryInitRunnerDeps) {
        this.memory = deps.memory;
        this.getConfig = deps.getConfig ?? (() => loadConfig());
        this.runInit = deps.runInit ?? runHistoryInitializationWithMemory;
    }

    current(): HistoryRunnerRunningInfo | null {
        if (!this.active) return null;
        return {
            chatId: this.active.chatId,
            mode: this.active.mode,
            startedAt: this.active.startedAt,
        };
    }

    private shouldResumeJob(chatId: string, mode: HistoryInitMode): boolean {
        const latestJob = this.memory.findLatestHistoryJob("initialize", chatId);
        if (!latestJob) return false;

        let isResumableStatus = false;
        if (latestJob.status === "paused") {
            isResumableStatus = true;
        } else if (latestJob.status === "running") {
            const lease = this.memory.getHistoryLease(chatId);
            const leaseActive = Boolean(lease && lease.expiresAtMs > Date.now());
            isResumableStatus = !leaseActive;
        }
        if (!isResumableStatus) return false;

        let prevOpts: Record<string, unknown>;
        try {
            prevOpts = JSON.parse(latestJob.optionsJson) as Record<string, unknown>;
        } catch {
            return false;
        }
        if (!prevOpts || typeof prevOpts !== "object" || Array.isArray(prevOpts)) {
            return false;
        }
        if (prevOpts.mode !== mode) {
            return false;
        }

        const prevStage = prevOpts.stage ?? "all";
        return (
            prevStage === "all"
            && (prevOpts.windowMessages ?? null) === null
            && (prevOpts.windowHours ?? null) === null
            && (prevOpts.gapMinutes ?? null) === null
            && (prevOpts.minWindowMessages ?? null) === null
            && (prevOpts.since ?? null) === null
            && (prevOpts.until ?? null) === null
            && (prevOpts.profile ?? null) === null
        );
    }

    start(opts: {
        chatId: string;
        mode: HistoryInitMode;
        allowPrivateLlm?: boolean;
    }): StartHistoryInitResult {
        const cleanChatId = opts.chatId.trim();
        if (!cleanChatId) {
            throw new Error("chatId is required");
        }

        if (this.active) {
            return {
                ok: false,
                error: "busy",
                running: this.current()!,
            };
        }

        const config = this.getConfig();
        if (isChatPrivateOrSensitive(this.memory, cleanChatId, config) && opts.allowPrivateLlm !== true) {
            return {
                ok: false,
                error: "private_consent_required",
            };
        }

        const resume = this.shouldResumeJob(cleanChatId, opts.mode);
        const abortController = new AbortController();
        const startedAt = new Date().toISOString();

        const state: ActiveRunState = {
            chatId: cleanChatId,
            mode: opts.mode,
            startedAt,
            abortController,
            promise: Promise.resolve(),
        };
        this.active = state;

        state.promise = Promise.resolve().then(async () => {
            try {
                await this.runInit(this.memory, {
                    chatId: cleanChatId,
                    mode: opts.mode,
                    stage: "all",
                    allowPrivateLlm: opts.allowPrivateLlm === true,
                    resume,
                    config,
                    signal: abortController.signal,
                    ...(this.deps.llmCall ? { llmCall: this.deps.llmCall } : {}),
                    ...(this.deps.embedFn ? { embedFn: this.deps.embedFn } : {}),
                    ...(this.deps.sleepFn ? { sleepFn: this.deps.sleepFn } : {}),
                    ...(this.deps.leaseTtlMs !== undefined ? { leaseTtlMs: this.deps.leaseTtlMs } : {}),
                });
                log.info("后台历史初始化完成", { chatId: cleanChatId, mode: opts.mode, resume });
            } catch (err) {
                if (err instanceof Error && err.name === "AbortError") {
                    log.info("后台历史初始化已停止", { chatId: cleanChatId, mode: opts.mode });
                } else {
                    log.warn("后台历史初始化暂停或失败", {
                        chatId: cleanChatId,
                        mode: opts.mode,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            } finally {
                if (this.active === state) {
                    this.active = null;
                }
            }
        });

        return {
            ok: true,
            running: {
                chatId: cleanChatId,
                mode: opts.mode,
                startedAt,
            },
            resume,
        };
    }

    stop(chatId: string): boolean {
        const cleanChatId = chatId.trim();
        if (!cleanChatId || !this.active || this.active.chatId !== cleanChatId) {
            return false;
        }
        if (!this.active.abortController.signal.aborted) {
            const err = new Error("已在面板中手动停止");
            err.name = "AbortError";
            this.active.abortController.abort(err);
        }
        return true;
    }

    waitForIdle(): Promise<void> {
        return this.active ? this.active.promise : Promise.resolve();
    }

    async shutdown(): Promise<void> {
        if (!this.active) return;
        this.stop(this.active.chatId);
        await this.active.promise;
    }
}
