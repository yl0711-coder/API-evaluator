import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeClientLogs,
  buildReplayCandidate,
  buildSupplierEvidence,
  classifyClientError,
  extractClientLogRecords,
  extractReplayCandidates,
  normalizeClientLogRecord,
} from "../server/client-log-analyzer.mjs";
import { formatClientReplayReport, formatSupplierEvidenceReport } from "../server/reporting.mjs";

test("client log analyzer summarizes Claude Code proxy failures", () => {
  const records = [
    {
      requestId: "req-ok",
      userAgent: "claude-cli/2.1.145 (external, cli)",
      model: "claude-opus-4-7",
      path: "/v1/messages?beta=true",
      statusCode: 200,
      durationMs: 7900,
      inputTokens: 10,
      outputTokens: 515,
      success: true,
    },
    {
      requestId: "req-524",
      userAgent: "claude-cli/2.1.145 (external, cli)",
      model: "claude-opus-4-7",
      path: "/v1/messages?beta=true",
      statusCode: 524,
      durationMs: 125000,
      rawError: "The origin web server did not return a complete response within the 120-second Proxy Read Timeout window.",
    },
    {
      requestId: "req-cbnf",
      userAgent: "claude-cli/2.1.145 (external, cli)",
      model: "claude-opus-4-7",
      path: "/v1/messages?beta=true",
      statusCode: 500,
      durationMs: 2400,
      rawError: "API Error: Content block not found sk-should-not-leak",
    },
  ];

  const summary = analyzeClientLogs(records, { sourceName: "proxy-test" });

  assert.equal(summary.recordCount, 3);
  assert.equal(summary.clientCounts["Claude Code"], 3);
  assert.equal(summary.errorCounts.upstream_timeout_524, 1);
  assert.equal(summary.errorCounts.content_block_not_found, 1);
  assert.equal(summary.successRateText, "33%");
  assert.equal(summary.riskFlags.some((item) => item.code === "content_block_not_found"), true);

  const markdown = formatClientReplayReport(summary);
  assert.match(markdown, /真实客户端日志分析报告/);
  assert.match(markdown, /Content block not found/);
  assert.equal(markdown.includes("sk-should-not-leak"), false);
  assert.match(markdown, /\[redacted-secret\]/);
});

test("client log analyzer parses plain nginx and service log lines", () => {
  const logText = [
    'evaluator-nginx  | 10.0.0.5 - - [28/May/2026:04:21:17 +0000] "POST /v1/messages?beta=true HTTP/1.1" 499 0 "-" "claude-cli/2.1.145 (external, cli)" "203.0.113.148"',
    '[ERR] 2026/05/28 - 16:51:52 | 202605280849474100481818268d9d6ZG6GduKt | channel error (channel #21, status code: 524): The origin web server did not return a complete response within the 120-second Proxy Read Timeout window.',
  ].join("\n");

  const records = extractClientLogRecords({ logText });
  const summary = analyzeClientLogs(records);

  assert.equal(records.length, 2);
  assert.equal(summary.errorCounts.client_gone, 1);
  assert.equal(summary.errorCounts.upstream_timeout_524, 1);
});

test("client log normalization infers common fields", () => {
  const record = normalizeClientLogRecord({
    request: {
      url: "https://api.example.com/v1/chat/completions",
      headers: { "User-Agent": "codex-cli" },
      body: { model: "gpt-4.1" },
    },
    response: { statusCode: 503, body: { error: { message: "no available accounts" } } },
    totalMs: 1000,
  });

  assert.equal(record.client, "Codex");
  assert.equal(record.path, "/v1/chat/completions");
  assert.equal(record.model, "gpt-4.1");
  assert.equal(record.normalizedError, "upstream_unavailable");
});

test("client error classifier maps common upstream failures", () => {
  assert.equal(classifyClientError({ statusCode: 504, rawError: "" }), "gateway_timeout");
  assert.equal(classifyClientError({ statusCode: 500, rawError: "permission_denied" }), "permission_denied");
  assert.equal(classifyClientError({ statusCode: 200, rawError: "context canceled" }), "client_gone");
});

test("replay candidates are extracted from structured proxy logs without auth headers", () => {
  const records = [
    {
      requestId: "req-replay",
      request: {
        method: "POST",
        url: "https://api.example.com/v1/messages?beta=true",
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-should-not-leak",
          authorization: "Bearer sk-should-not-leak",
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: "claude-opus-4-7",
          max_tokens: 512,
          messages: [{ role: "user", content: "hello sk-should-not-leak" }],
        },
      },
      response: { statusCode: 524, body: "timeout" },
    },
  ];

  const candidates = extractReplayCandidates({ records });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].path, "/v1/messages");
  assert.equal(candidates[0].request.headers["x-api-key"], undefined);
  assert.equal(candidates[0].request.headers.authorization, undefined);
  assert.equal(candidates[0].request.headers["anthropic-version"], "2023-06-01");
  assert.equal(candidates[0].requestJson.includes("sk-should-not-leak"), false);
  assert.match(candidates[0].requestJson, /\[redacted-secret\]/);
});

test("replay candidate requires a request body", () => {
  const candidate = buildReplayCandidate({
    request: {
      url: "https://api.example.com/v1/messages",
      headers: { "content-type": "application/json" },
    },
  });

  assert.equal(candidate, null);
});

test("supplier evidence keeps upstream ids and removes internal sensitive fields", () => {
  const evidence = buildSupplierEvidence(
    [
      {
        requestId: "platform-req-1",
        userAgent: "claude-cli/2.1.145",
        model: "claude-opus-4-7",
        path: "/v1/messages",
        statusCode: 500,
        durationMs: 3000,
        rawError:
          'channel error (channel #9, status code: 500): {"error":{"code":"permission_denied","message":"internal error (trace ID: abc123)"}} (request id: upstream-req-1) userId=49 tokenName=公司 sk-should-not-leak',
      },
    ],
    {
      providerName: "wf",
      sourceName: "Claude Code 复盘",
    },
  );

  assert.equal(evidence.type, "supplier-evidence");
  assert.equal(evidence.providerName, "wf");
  assert.equal(evidence.failureCount, 1);
  assert.deepEqual(evidence.upstreamIds, ["abc123", "upstream-req-1"]);
  assert.equal(JSON.stringify(evidence).includes("userId=49"), false);
  assert.equal(JSON.stringify(evidence).includes("tokenName=公司"), false);
  assert.equal(JSON.stringify(evidence).includes("sk-should-not-leak"), false);

  const markdown = formatSupplierEvidenceReport(evidence);
  assert.match(markdown, /wf 异常排查证据包/);
  assert.match(markdown, /abc123/);
  assert.match(markdown, /upstream-req-1/);
  assert.equal(markdown.includes("sk-should-not-leak"), false);
});
