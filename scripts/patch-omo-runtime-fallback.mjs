#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MARKER = "OpenConfig runtime-fallback primary retry patch v1";
const EXPECTED_OMO_VERSION = "4.19.4";

function usage() {
  console.log(`Usage: node scripts/patch-omo-runtime-fallback.mjs [--check|--apply] [--repo PATH]

Applies OpenConfig's small runtime-fallback patch to the pinned OmO package cache.
The patch adds same-primary retries before model fallback and makes the first
subagent prompt watchdog configurable from runtime_fallback.first_prompt_timeout_seconds.`);
}

function parseArgs(argv) {
  const args = { mode: "check", repo: resolve(import.meta.dirname, "..") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.mode = "check";
    else if (arg === "--apply") args.mode = "apply";
    else if (arg === "--repo") {
      args.repo = resolve(argv[++index] ?? "");
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pinnedPackage(repo) {
  const opencode = readJson(join(repo, "opencode.json"));
  const pin = (opencode.plugin ?? []).find(value => typeof value === "string" && value.startsWith("oh-my-openagent@"));
  if (!pin) throw new Error("opencode.json has no oh-my-openagent@ pin");
  return pin;
}

function packageDir(repo) {
  const pin = pinnedPackage(repo);
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "packages", pin, "node_modules", "oh-my-openagent");
}

function replaceOnce(text, search, replacement, label) {
  const count = text.split(search).length - 1;
  if (count !== 1) throw new Error(`Patch anchor mismatch for ${label}: expected 1, got ${count}`);
  return text.replace(search, replacement);
}

function patchDist(original) {
  if (original.includes(MARKER)) return { text: original, changed: false };
  let text = original;

  text = replaceOnce(
    text,
    `var RuntimeFallbackConfigSchema = z38.object({
  enabled: z38.boolean().optional(),
  retry_on_errors: z38.array(z38.number()).optional(),
  max_fallback_attempts: z38.number().min(1).max(20).optional(),
  cooldown_seconds: z38.number().min(0).optional(),
  timeout_seconds: z38.number().min(0).optional(),
  notify_on_fallback: z38.boolean().optional(),
  restore_primary_after_cooldown: z38.boolean().optional()
});`,
    `var RuntimeFallbackConfigSchema = z38.object({
  enabled: z38.boolean().optional(),
  retry_on_errors: z38.array(z38.number()).optional(),
  max_fallback_attempts: z38.number().min(1).max(20).optional(),
  cooldown_seconds: z38.number().min(0).optional(),
  timeout_seconds: z38.number().min(0).optional(),
  notify_on_fallback: z38.boolean().optional(),
  restore_primary_after_cooldown: z38.boolean().optional(),
  same_model_retries_before_fallback: z38.number().int().min(0).max(10).optional(),
  first_prompt_timeout_seconds: z38.number().min(1).optional()
});`,
    "RuntimeFallbackConfigSchema",
  );

  text = replaceOnce(
    text,
    `var DEFAULT_CONFIG2 = {
  enabled: false,
  retry_on_errors: [429, 500, 502, 503, 504],
  max_fallback_attempts: 3,
  cooldown_seconds: 60,
  timeout_seconds: 30,
  notify_on_fallback: true,
  restore_primary_after_cooldown: false
};`,
    `var DEFAULT_CONFIG2 = {
  enabled: false,
  retry_on_errors: [429, 500, 502, 503, 504],
  max_fallback_attempts: 3,
  cooldown_seconds: 60,
  timeout_seconds: 30,
  notify_on_fallback: true,
  restore_primary_after_cooldown: false,
  same_model_retries_before_fallback: 0,
  first_prompt_timeout_seconds: 90
};`,
    "DEFAULT_CONFIG2",
  );

  text = replaceOnce(
    text,
    `function createFallbackState(originalModel) {
  const model = stringifyRuntimeModel(originalModel) ?? String(originalModel);
  return {
    originalModel: model,
    currentModel: model,
    fallbackIndex: -1,
    failedModels: new Map,
    attemptCount: 0,
    pendingFallbackModel: undefined
  };
}`,
    `function createFallbackState(originalModel) {
  const model = stringifyRuntimeModel(originalModel) ?? String(originalModel);
  return {
    originalModel: model,
    currentModel: model,
    fallbackIndex: -1,
    failedModels: new Map,
    attemptCount: 0,
    primaryRetryCount: 0,
    pendingFallbackModel: undefined
  };
}`,
    "createFallbackState",
  );

  text = replaceOnce(
    text,
    `function prepareFallback(sessionID, state3, fallbackModels, config3) {
  if (state3.attemptCount >= config3.max_fallback_attempts) {
    log2(\`[\${HOOK_NAME13}] Max fallback attempts reached\`, { sessionID, attempts: state3.attemptCount });
    return { success: false, error: "Max fallback attempts reached", maxAttemptsReached: true };
  }
  const nextModel = findNextAvailableFallback(state3, fallbackModels, config3.cooldown_seconds);
  if (!nextModel) {
    log2(\`[\${HOOK_NAME13}] No available fallback models\`, { sessionID });
    return { success: false, error: "No available fallback models (all in cooldown or exhausted)" };
  }
  log2(\`[\${HOOK_NAME13}] Preparing fallback\`, {
    sessionID,
    from: state3.currentModel,
    to: nextModel,
    attempt: state3.attemptCount + 1
  });
  const failedModel = state3.currentModel;
  const now = Date.now();
  state3.fallbackIndex = fallbackModels.indexOf(nextModel);
  state3.failedModels.set(failedModel, now);
  state3.attemptCount++;
  state3.currentModel = nextModel;
  state3.pendingFallbackModel = nextModel;
  return { success: true, newModel: nextModel };
}`,
    `function shouldRetryPrimaryBeforeFallback(state3, config3, options = {}) {
  const maxPrimaryRetries = Number(config3.same_model_retries_before_fallback ?? 0);
  if (!Number.isFinite(maxPrimaryRetries) || maxPrimaryRetries <= 0)
    return false;
  if (options.allowPrimaryRetry === false)
    return false;
  if (state3.currentModel !== state3.originalModel)
    return false;
  return (state3.primaryRetryCount ?? 0) < maxPrimaryRetries;
}
function prepareFallback(sessionID, state3, fallbackModels, config3, options = {}) {
  if (state3.attemptCount >= config3.max_fallback_attempts) {
    log2(\`[\${HOOK_NAME13}] Max fallback attempts reached\`, { sessionID, attempts: state3.attemptCount });
    return { success: false, error: "Max fallback attempts reached", maxAttemptsReached: true };
  }
  const failedModel = state3.currentModel;
  const now = Date.now();
  if (shouldRetryPrimaryBeforeFallback(state3, config3, options)) {
    state3.failedModels.set(failedModel, now);
    state3.attemptCount++;
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;
    state3.currentModel = state3.originalModel;
    state3.pendingFallbackModel = state3.originalModel;
    log2(\`[\${HOOK_NAME13}] Preparing same-model retry before fallback\`, {
      sessionID,
      model: state3.originalModel,
      primaryRetry: state3.primaryRetryCount,
      maxPrimaryRetries: config3.same_model_retries_before_fallback,
      attempt: state3.attemptCount
    });
    return { success: true, newModel: state3.originalModel, sameModelRetry: true };
  }
  const nextModel = findNextAvailableFallback(state3, fallbackModels, config3.cooldown_seconds);
  if (!nextModel) {
    log2(\`[\${HOOK_NAME13}] No available fallback models\`, { sessionID });
    return { success: false, error: "No available fallback models (all in cooldown or exhausted)" };
  }
  log2(\`[\${HOOK_NAME13}] Preparing fallback\`, {
    sessionID,
    from: state3.currentModel,
    to: nextModel,
    attempt: state3.attemptCount + 1
  });
  state3.fallbackIndex = fallbackModels.indexOf(nextModel);
  state3.failedModels.set(failedModel, now);
  state3.attemptCount++;
  state3.currentModel = nextModel;
  state3.pendingFallbackModel = nextModel;
  return { success: true, newModel: nextModel };
}`,
    "prepareFallback",
  );

  text = replaceOnce(
    text,
    `    attemptCount: state3.attemptCount,
    pendingFallbackModel: state3.pendingFallbackModel,`,
    `    attemptCount: state3.attemptCount,
    primaryRetryCount: state3.primaryRetryCount ?? 0,
    pendingFallbackModel: state3.pendingFallbackModel,`,
    "snapshotFallbackState.primaryRetryCount",
  );

  text = replaceOnce(
    text,
    `  state3.attemptCount = snapshot.attemptCount;
  state3.pendingFallbackModel = snapshot.pendingFallbackModel;`,
    `  state3.attemptCount = snapshot.attemptCount;
  state3.primaryRetryCount = snapshot.primaryRetryCount ?? 0;
  state3.pendingFallbackModel = snapshot.pendingFallbackModel;`,
    "restoreFallbackState.primaryRetryCount",
  );

  text = replaceOnce(
    text,
    `  const snapshot = snapshotFallbackState(options.state);
  const result = prepareFallback(options.sessionID, options.state, options.fallbackModels, deps.config);`,
    `  const snapshot = snapshotFallbackState(options.state);
  const result = prepareFallback(options.sessionID, options.state, options.fallbackModels, deps.config, options);`,
    "dispatchFallbackRetry.prepareFallback",
  );

  text = replaceOnce(
    text,
    `      resolvedAgent,
      source: "session.status"
    });`,
    `      resolvedAgent,
      source: "session.status",
      allowPrimaryRetry: true
    });`,
    "session.status.allowPrimaryRetry",
  );

  text = replaceOnce(
    text,
    `    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state: state3,
      fallbackModels,
      resolvedAgent,
      source: SOURCE
    });`,
    `    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state: state3,
      fallbackModels,
      resolvedAgent,
      source: SOURCE,
      allowPrimaryRetry: true
    });`,
    "firstPromptWatchdog.allowPrimaryRetry",
  );

  text = replaceOnce(
    text,
    `      if (classifyErrorType(error) === "quota_exceeded") {
        await helpers.abortSessionRequest(sessionID, "message.updated.quota-fallback");
        sessionRetryInFlight.delete(sessionID);
      }
      await dispatchFallbackRetry(deps, helpers, {
        sessionID,
        state: state3,
        fallbackModels,
        resolvedAgent,
        source: "message.updated"
      });`,
    `      if (classifyErrorType(error) === "quota_exceeded") {
        await helpers.abortSessionRequest(sessionID, "message.updated.quota-fallback");
        sessionRetryInFlight.delete(sessionID);
      }
      const errorTypeForPrimaryRetry = classifyErrorType(error);
      const statusCodeForPrimaryRetry = extractStatusCode(error, config3.retry_on_errors);
      const allowPrimaryRetry = Boolean(retrySignal) || (!["abort", "context_overflow", "missing_api_key", "invalid_api_key", "model_not_found", "quota_exceeded"].includes(errorTypeForPrimaryRetry ?? "") && (statusCodeForPrimaryRetry === undefined || statusCodeForPrimaryRetry >= 500 || statusCodeForPrimaryRetry === 408 || statusCodeForPrimaryRetry === 425 || statusCodeForPrimaryRetry === 429));
      await dispatchFallbackRetry(deps, helpers, {
        sessionID,
        state: state3,
        fallbackModels,
        resolvedAgent,
        source: "message.updated",
        allowPrimaryRetry
      });`,
    "message.updated.allowPrimaryRetry",
  );

  text = replaceOnce(
    text,
    `  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers);`,
    `  const firstPromptWatchdogMs = Math.max(1000, Number(config3.first_prompt_timeout_seconds ?? DEFAULT_FIRST_PROMPT_WATCHDOG_MS / 1000) * 1000);
  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers, firstPromptWatchdogMs);`,
    "firstPromptWatchdog.config",
  );

  text = `${text}\n/* ${MARKER} */\n`;
  return { text, changed: true };
}

function assertPatched(text) {
  const required = [
    MARKER,
    "same_model_retries_before_fallback",
    "first_prompt_timeout_seconds",
    "function shouldRetryPrimaryBeforeFallback",
    "primaryRetryCount",
    "allowPrimaryRetry",
    "firstPromptWatchdogMs",
  ];
  const missing = required.filter(value => !text.includes(value));
  if (missing.length > 0) throw new Error(`OmO runtime-fallback patch missing: ${missing.join(", ")}`);
}

const args = parseArgs(process.argv.slice(2));
const dir = packageDir(args.repo);
const pkg = readJson(join(dir, "package.json"));
if (pkg.version !== EXPECTED_OMO_VERSION) {
  throw new Error(`Refusing to patch OmO ${pkg.version}; OpenConfig expects ${EXPECTED_OMO_VERSION}`);
}
const dist = join(dir, "dist", "index.js");
const original = readFileSync(dist, "utf8");
if (args.mode === "check") {
  assertPatched(original);
  console.log(`OK|omo runtime-fallback patch present|${dist}`);
  process.exit(0);
}
const { text, changed } = patchDist(original);
assertPatched(text);
if (changed) writeFileSync(dist, text);
console.log(`${changed ? "PATCHED" : "OK"}|omo runtime-fallback primary retry patch|${dist}`);
