export class HistoryUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HistoryUsageError";
    }
}

export class HistoryUnsupportedFormatError extends Error {
    constructor(detail: string) {
        super(
            `Unsupported QCE export format (${detail}). Please re-export as JSON or chunked JSONL.`,
        );
        this.name = "HistoryUnsupportedFormatError";
    }
}
