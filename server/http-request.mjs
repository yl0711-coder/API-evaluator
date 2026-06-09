const DEFAULT_JSON_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

export class HttpRequestError extends Error {
  constructor(status, code, userMessage) {
    super(userMessage);
    this.name = "HttpRequestError";
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
  }
}

export async function readJson(req, { limitBytes = DEFAULT_JSON_BODY_LIMIT_BYTES } = {}) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > limitBytes) {
      throw new HttpRequestError(413, "payload_too_large", "内容太大，请减少内容后再试。");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpRequestError(400, "invalid_json", "内容格式不是有效 JSON，请检查后重试。");
  }
}
