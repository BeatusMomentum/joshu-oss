/** Expected request/storage failures that the HTTP adapter can expose safely. */
export class CwmBackendError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.name = "CwmBackendError";
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export class CwmInputError extends CwmBackendError {
    constructor(message, details) {
        super(400, "INVALID_CWM_REQUEST", message, details);
        this.name = "CwmInputError";
    }
}
export class CwmBoardNotFoundError extends CwmBackendError {
    constructor(relativePath) {
        super(404, "CWM_BOARD_NOT_FOUND", `Excalidraw board not found: ${relativePath}`);
        this.name = "CwmBoardNotFoundError";
    }
}
export class CwmConflictError extends CwmBackendError {
    constructor(message, details) {
        super(409, "CWM_CONFLICT", message, details);
        this.name = "CwmConflictError";
    }
}
export class CwmStoreCorruptError extends CwmBackendError {
    constructor(message) {
        super(500, "CWM_STORE_CORRUPT", message);
        this.name = "CwmStoreCorruptError";
    }
}
//# sourceMappingURL=errors.js.map