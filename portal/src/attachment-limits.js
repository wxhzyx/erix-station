// Upload budgets are distinct from the selected model's context window.
export const ATTACHMENT_LIMITS = Object.freeze({ count: 10, fileBytes: 10 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 });
export const DOCUMENT_BODY_BYTES = Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4 + 65536;
export const CHAT_BODY_BYTES = Math.ceil(ATTACHMENT_LIMITS.totalBytes / 3) * 4 + 1024 * 1024;
// Text can double when JSON escapes quotes, backslashes, tabs and newlines.
export const WORK_BODY_BYTES = 2 * ATTACHMENT_LIMITS.totalBytes + 1024 * 1024;
// Work attachments are JSON text inside a transcript JSON envelope.
export const ATTACHMENT_TRANSCRIPT_BYTES = 4 * ATTACHMENT_LIMITS.totalBytes + 4 * 1024 * 1024;
