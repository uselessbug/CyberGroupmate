import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { createMemoryStore } from "../core/memory-factory.js";
import { HistoryUnsupportedFormatError, HistoryUsageError } from "./errors.js";
import { dryRunQceImport, importQce, type QceImportOptions, type QceImportSummary } from "./qce-import.js";
import {
    runHistoryInitialization,
    type HistoryInitMode,
    type HistoryInitOptions,
    type HistoryInitStage,
    type HistoryInitSummary,
} from "./initialize.js";

const DEFAULT_DB_PATH = "workspace/memory.db";

export class CliUsageError extends HistoryUsageError {
    constructor(message: string) {
        super(message);
        this.name = "CliUsageError";
    }
}

export const HISTORY_HELP = `
CyberGroupmate History CLI

用法:
  npx tsx src/cli.ts history import <file|directory|manifest.json> [options]
  npx tsx src/cli.ts history init [options]

子命令:
  import    流式校验并导入 QQ Chat Exporter (QCE) 导出文件到 message_log
  init      对历史消息执行离线话题聚类与社会记忆初始化
  --help    显示帮助信息
`;

export const HISTORY_IMPORT_HELP = `
用法: npx tsx src/cli.ts history import <file|directory|manifest.json> [options]

选项:
  --db PATH            SQLite 数据库路径（默认: ${DEFAULT_DB_PATH}）
  --chat-id ID         覆盖目标 composite chatId（如 onebot:group:123456）
  --self-id ID         Bot 自己的 QQ 号或 composite userId（用于区分人/Bot统计）
  --user-map FILE      UID -> UIN 映射 JSON 文件
  --include-system     包含系统提示消息（默认跳过）
  --include-recalled   包含已撤回消息（默认跳过）
  --timezone IANA      用于无时区日期/小时统计的 IANA 时区
  --since TIME         仅导入此时间之后（含）的消息
  --until TIME         仅导入此时间之前（不含）的消息
  --dry-run            仅统计评估，不写入数据库
  --resume             从上次中断的导入检查点续传
  -h, --help           显示帮助信息
`;

export const HISTORY_INIT_HELP = `
用法: npx tsx src/cli.ts history init [options]

选项:
  --input PATH           可选 QCE 导出路径（在 stage=import 或 all 时先执行导入）
  --chat-id ID           目标 composite chatId（如 onebot:group:123456）
  --db PATH              SQLite 数据库路径（默认: ${DEFAULT_DB_PATH}）
  --stage STAGE          执行阶段: import|cluster|synthesize|all（默认: all）
  --mode MODE            窗口选择模式: quick|full（默认: quick）
  --window-messages N    单窗口最大消息数（默认: 120）
  --window-hours N       单窗口最大时间跨度小时数（默认: 4）
  --gap-minutes N        分段静默间隔分钟数（默认: 30）
  --min-window-messages N  少于 N 条的窗口并入时间上更近的相邻窗口（默认: 10，0 关闭）
  --since TIME           仅处理此时间之后（含）的消息/完整话题
  --until TIME           仅处理此时间之前（不含）的消息/完整话题
  --max-windows N        本次每个阶段最多新处理的逻辑单元数
  --profile NAME         显式指定 config.llmProfiles 中的 LLM profile（不静默回退）
  --embed                为已提交的历史话题与事实补写向量 embedding
  --allow-private-llm    显式允许将私聊/敏感群历史发送到 LLM/远程 embedding API
  --dry-run              仅计算窗口与调用计划，不调用 LLM 且不写数据库
  --resume               从上次中断的初始化检查点续传
  -h, --help             显示帮助信息
`;

function takeFlagValue(args: readonly string[], index: number, flag: string): string {
    const val = args[index + 1];
    if (val === undefined || val.startsWith("-")) {
        throw new CliUsageError(`Missing value for ${flag}`);
    }
    return val;
}

function parsePositiveIntFlag(raw: string, flag: string): number {
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 1) {
        throw new CliUsageError(`Invalid ${flag} value "${raw}": expected positive integer`);
    }
    return num;
}

function parsePositiveNumberFlag(raw: string, flag: string): number {
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) {
        throw new CliUsageError(`Invalid ${flag} value "${raw}": expected positive number`);
    }
    return num;
}

export function parseImportArgs(args: readonly string[]): {
    help: boolean;
    inputPath?: string;
    dbPath: string;
    options: QceImportOptions;
} {
    let help = false;
    let inputPath: string | undefined;
    let dbPath = DEFAULT_DB_PATH;
    const options: QceImportOptions = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
            help = true;
            continue;
        }
        if (arg === "--db") {
            dbPath = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--chat-id") {
            options.chatId = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--self-id") {
            options.selfId = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--user-map") {
            options.userMapPath = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--timezone") {
            options.timezone = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--since") {
            options.since = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--until") {
            options.until = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--include-system") {
            options.includeSystem = true;
        } else if (arg === "--include-recalled") {
            options.includeRecalled = true;
        } else if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--resume") {
            options.resume = true;
        } else if (arg.startsWith("-")) {
            throw new CliUsageError(`Unknown option for history import: ${arg}`);
        } else if (!inputPath) {
            inputPath = arg;
        } else {
            throw new CliUsageError(`Unexpected positional argument: ${arg}`);
        }
    }

    if (!help && !inputPath) {
        throw new CliUsageError("history import requires <file|directory|manifest.json>");
    }

    options.dbPath = dbPath;
    return { help, inputPath, dbPath, options };
}

export function parseInitArgs(args: readonly string[]): {
    help: boolean;
    dbPath: string;
    options: HistoryInitOptions;
} {
    let help = false;
    let dbPath = DEFAULT_DB_PATH;
    const qceOptions: QceImportOptions = { dbPath };
    const options: HistoryInitOptions = {
        mode: "quick",
        stage: "all",
        qceOptions,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
            help = true;
            continue;
        }
        if (arg === "--input") {
            options.inputPath = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--chat-id") {
            options.chatId = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--db") {
            dbPath = takeFlagValue(args, i, arg);
            qceOptions.dbPath = dbPath;
            i++;
        } else if (arg === "--stage") {
            const val = takeFlagValue(args, i, arg);
            if (val !== "import" && val !== "cluster" && val !== "synthesize" && val !== "all") {
                throw new CliUsageError(`Invalid --stage "${val}": expected import|cluster|synthesize|all`);
            }
            options.stage = val as HistoryInitStage;
            i++;
        } else if (arg === "--mode") {
            const val = takeFlagValue(args, i, arg);
            if (val !== "quick" && val !== "full") {
                throw new CliUsageError(`Invalid --mode "${val}": expected quick|full`);
            }
            options.mode = val as HistoryInitMode;
            i++;
        } else if (arg === "--window-messages") {
            options.windowMessages = parsePositiveIntFlag(takeFlagValue(args, i, arg), arg);
            i++;
        } else if (arg === "--window-hours") {
            options.windowHours = parsePositiveNumberFlag(takeFlagValue(args, i, arg), arg);
            i++;
        } else if (arg === "--gap-minutes") {
            options.gapMinutes = parsePositiveNumberFlag(takeFlagValue(args, i, arg), arg);
            i++;
        } else if (arg === "--min-window-messages") {
            const raw = takeFlagValue(args, i, arg);
            if (!/^\d+$/.test(raw)) {
                throw new CliUsageError(`Invalid ${arg} "${raw}": expected a non-negative integer`);
            }
            options.minWindowMessages = Number(raw);
            i++;
        } else if (arg === "--since") {
            options.since = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--until") {
            options.until = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--max-windows") {
            options.maxWindows = parsePositiveIntFlag(takeFlagValue(args, i, arg), arg);
            i++;
        } else if (arg === "--profile") {
            options.profile = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--embed") {
            options.embed = true;
        } else if (arg === "--allow-private-llm") {
            options.allowPrivateLlm = true;
        } else if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--resume") {
            options.resume = true;
        } else if (arg === "--self-id") {
            qceOptions.selfId = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--user-map") {
            qceOptions.userMapPath = takeFlagValue(args, i, arg);
            i++;
        } else if (arg === "--timezone") {
            options.timezone = takeFlagValue(args, i, arg);
            qceOptions.timezone = options.timezone;
            i++;
        } else if (arg === "--include-system") {
            qceOptions.includeSystem = true;
        } else if (arg === "--include-recalled") {
            qceOptions.includeRecalled = true;
        } else {
            throw new CliUsageError(`Unknown option for history init: ${arg}`);
        }
    }

    if (!help) {
        if (options.stage === "import" && !options.inputPath) {
            throw new CliUsageError("history init --stage import requires --input <path>");
        }
        if ((options.stage === "cluster" || options.stage === "synthesize") && !options.chatId) {
            throw new CliUsageError(`history init --stage ${options.stage} requires --chat-id <id>`);
        }
        if (!options.chatId && !options.inputPath) {
            throw new CliUsageError("history init requires --chat-id <id> or --input <path>");
        }
    }

    return { help, dbPath, options };
}

function printImportSummary(summary: QceImportSummary): void {
    console.log(JSON.stringify(summary, null, 2));
}

function printInitSummary(summary: HistoryInitSummary): void {
    console.log(JSON.stringify(summary, null, 2));
}

function isUsageOrFormatError(err: unknown): boolean {
    return err instanceof HistoryUsageError || err instanceof HistoryUnsupportedFormatError;
}

function ensureParentDirForDb(dbPath: string): void {
    const dir = path.dirname(path.resolve(dbPath));
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

export async function runHistoryCli(args: readonly string[]): Promise<number> {
    const subCmd = args[0];
    const subArgs = args.slice(1);

    if (!subCmd || subCmd === "-h" || subCmd === "--help" || subCmd === "help") {
        console.log(HISTORY_HELP);
        return 0;
    }

    const controller = new AbortController();
    let signalReceived = false;
    const onSig = () => {
        signalReceived = true;
        controller.abort(new DOMException("aborted", "AbortError"));
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    try {
        if (subCmd === "import") {
            const parsed = parseImportArgs(subArgs);
            if (parsed.help) {
                console.log(HISTORY_IMPORT_HELP);
                return 0;
            }
            if (parsed.options.dryRun) {
                const summary = await dryRunQceImport(
                    parsed.inputPath!,
                    parsed.dbPath,
                    parsed.options,
                    controller.signal,
                );
                printImportSummary(summary);
                return 0;
            }

            ensureParentDirForDb(parsed.dbPath);
            const cfg = loadConfig();
            const memory = createMemoryStore(parsed.dbPath, { config: cfg });
            try {
                const summary = await importQce(memory, parsed.inputPath!, parsed.options, controller.signal);
                printImportSummary(summary);
                return 0;
            } finally {
                memory.close();
            }
        }

        if (subCmd === "init") {
            const parsed = parseInitArgs(subArgs);
            if (parsed.help) {
                console.log(HISTORY_INIT_HELP);
                return 0;
            }
            if (!parsed.options.dryRun) {
                ensureParentDirForDb(parsed.dbPath);
            }
            const summary = await runHistoryInitialization({
                ...parsed.options,
                signal: controller.signal,
            });
            printInitSummary(summary);
            return 0;
        }

        throw new CliUsageError(`Unknown history subcommand: ${subCmd}`);
    } catch (err) {
        if (signalReceived) {
            console.error(`Aborted: ${err instanceof Error ? err.message : String(err)}`);
            return 130;
        }
        if (isUsageOrFormatError(err)) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
            return 2;
        }
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    } finally {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
    }
}
