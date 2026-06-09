import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeClientErrorPayload } from "../src/client-error-reporter.js";

test("client error payload sanitizer removes secrets before local logging", () => {
  const payload = sanitizeClientErrorPayload({
    message: "failed with sk-secret-value-1234567890",
    details: {
      apiKey: "sk-should-not-leak-123456",
      nested: {
        authorization: "Bearer secret-token-value-123456",
      },
    },
  });

  const raw = JSON.stringify(payload);
  assert.doesNotMatch(raw, /sk-should-not-leak/);
  assert.doesNotMatch(raw, /Bearer secret-token-value/);
  assert.match(raw, /\[redacted\]|\[redacted-secret\]/);
});
