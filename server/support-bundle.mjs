import os from "node:os";
import { basename } from "node:path";

export function buildSupportBundle({ profiles, requests, testRuns, tasks, errors, storage = null }) {
  return {
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    system: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      release: os.release(),
    },
    // 数据层健康：SQLite 是否可用、写失败计数（>0 表示 SQLite 与 JSONL 可能已偏离）。
    storage: storage || { sqliteAvailable: null },
    summary: {
      profileCount: profiles.length,
      recentRequestCount: requests.length,
      recentTestRunCount: testRuns.length,
      recentTaskCount: tasks.length,
      recentErrorCount: errors.length,
      latestErrorId: errors[0]?.id || "",
    },
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      protocol: profile.protocol,
      baseUrlHost: safeHost(profile.baseUrl),
      defaultModel: profile.defaultModel,
      channelCode: profile.channelCode || "",
      role: profile.role,
      hasKey: Boolean(profile.hasKey || profile.apiKeyRef),
      keyStorage: profile.keyStorage || "",
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
    recentRequests: requests.map((request) => ({
      id: request.id,
      profileId: request.profileId,
      profileName: request.profileName,
      model: request.model,
      success: request.success,
      statusCode: request.statusCode,
      firstByteMs: request.firstByteMs,
      totalMs: request.totalMs,
      normalizedError: request.normalizedError || "",
      responseSummary: request.responseSummary || "",
      createdAt: request.createdAt,
    })),
    recentTestRuns: testRuns.map((run) => ({
      runId: run.runId || run.batchId || "",
      type: run.type || (run.batchId ? "batch-stability" : "stability"),
      profileName: run.profileName || "",
      model: run.model || "",
      successRateText: run.successRateText || "",
      p95TotalMs: run.p95TotalMs ?? null,
      recommendation: run.recommendation || null,
      reportPath: safeFileName(run.reportPath),
      reportHtmlPath: safeFileName(run.reportHtmlPath),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    })),
    recentTasks: tasks.map((task) => ({
      taskId: task.taskId || task.id,
      type: task.type,
      status: task.status,
      progress: task.progress,
      message: task.message,
      errorId: task.errorId || "",
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      loggedAt: task.loggedAt,
    })),
    recentErrors: errors.map((error) => ({
      id: error.id,
      loggedAt: error.loggedAt,
      source: error.source,
      name: error.name,
      message: error.message,
      context: error.context,
    })),
  };
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function safeFileName(value) {
  return value ? basename(String(value)) : "";
}
