#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "OpenConfig runtime-fallback and canonical agent-model patch v35";
const LEGACY_MARKERS = [
  "OpenConfig runtime-fallback primary retry patch v1",
  "OpenConfig runtime-fallback primary retry patch v2",
  "OpenConfig runtime-fallback and canonical agent-model patch v3",
  "OpenConfig runtime-fallback and canonical agent-model patch v7",
  "OpenConfig runtime-fallback and canonical agent-model patch v8",
  "OpenConfig runtime-fallback and canonical agent-model patch v9",
  "OpenConfig runtime-fallback and canonical agent-model patch v10",
  "OpenConfig runtime-fallback and canonical agent-model patch v11",
  "OpenConfig runtime-fallback and canonical agent-model patch v12",
  "OpenConfig runtime-fallback and canonical agent-model patch v13",
  "OpenConfig runtime-fallback and canonical agent-model patch v14",
  "OpenConfig runtime-fallback and canonical agent-model patch v15",
  "OpenConfig runtime-fallback and canonical agent-model patch v16",
  "OpenConfig runtime-fallback and canonical agent-model patch v17",
  "OpenConfig runtime-fallback and canonical agent-model patch v18",
  "OpenConfig runtime-fallback and canonical agent-model patch v19",
  "OpenConfig runtime-fallback and canonical agent-model patch v20",
  "OpenConfig runtime-fallback and canonical agent-model patch v21",
  "OpenConfig runtime-fallback and canonical agent-model patch v22",
  "OpenConfig runtime-fallback and canonical agent-model patch v23",
  "OpenConfig runtime-fallback and canonical agent-model patch v24",
  "OpenConfig runtime-fallback and canonical agent-model patch v25",
  "OpenConfig runtime-fallback and canonical agent-model patch v26",
  "OpenConfig runtime-fallback and canonical agent-model patch v27",
  "OpenConfig runtime-fallback and canonical agent-model patch v28",
  "OpenConfig runtime-fallback and canonical agent-model patch v29",
  "OpenConfig runtime-fallback and canonical agent-model patch v30",
  "OpenConfig runtime-fallback and canonical agent-model patch v31",
  "OpenConfig runtime-fallback and canonical agent-model patch v32",
  "OpenConfig runtime-fallback and canonical agent-model patch v33",
  "OpenConfig runtime-fallback and canonical agent-model patch v34",
];
const EXPECTED_OMO_VERSION = "4.19.4";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage: node scripts/patch-omo-runtime-fallback.mjs [--check|--apply] [--repo PATH]

Applies OpenConfig's governed runtime patch to the pinned OmO package cache.
The patch adds same-primary retries before model fallback, makes the first
subagent prompt watchdog configurable from OpenConfig-owned environment knobs,
and makes canonical agents.*.models drive task(subagent_type) resolution.
Accepts a fresh pinned dist or upgrades deployed markers v1-v3 and v7-v34; unknown
intermediate OpenConfig patch markers are refused fail-closed.`);
}

function parseArgs(argv) {
  const args = { mode: "check", repo: resolve(SCRIPT_DIR, "..") };
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

function applyEnvironmentRuntimeKnobs(original) {
  let text = original;

  if (!text.includes("function openConfigRuntimeFallbackInteger")) {
    text = replaceOnce(
      text,
      `function shouldRetryPrimaryBeforeFallback(state3, config3, options = {}) {
  const maxPrimaryRetries = Number(config3.same_model_retries_before_fallback ?? 0);`,
      `function openConfigRuntimeFallbackInteger(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw === undefined || raw === "")
    return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed))
    return fallback;
  return Math.max(0, Math.trunc(parsed));
}
function configuredPrimaryRetryLimit(config3) {
  if (Number.isFinite(Number(config3.same_model_retries_before_fallback)))
    return Math.max(0, Math.trunc(Number(config3.same_model_retries_before_fallback)));
  return openConfigRuntimeFallbackInteger("OPENCONFIG_OMO_SAME_MODEL_RETRIES_BEFORE_FALLBACK", 0);
}
function configuredFirstPromptWatchdogMs(config3) {
  const configured = Number(config3.first_prompt_timeout_seconds);
  const seconds = Number.isFinite(configured) ? configured : openConfigRuntimeFallbackInteger("OPENCONFIG_OMO_FIRST_PROMPT_TIMEOUT_SECONDS", DEFAULT_FIRST_PROMPT_WATCHDOG_MS / 1000);
  return Math.max(1000, seconds * 1000);
}
function shouldRetryPrimaryBeforeFallback(state3, config3, options = {}) {
  const maxPrimaryRetries = configuredPrimaryRetryLimit(config3);`,
      "environment runtime knobs",
    );
  }

  if (!text.includes(`      maxPrimaryRetries,`) && !text.includes(`maxPrimaryRetries: configuredPrimaryRetryLimit(config3),`)) {
    text = replaceOnce(
      text,
      `      maxPrimaryRetries: config3.same_model_retries_before_fallback,`,
      `      maxPrimaryRetries,`,
      "same-model retry log limit",
    );
  }

  if (!text.includes(`  const firstPromptWatchdogMs = configuredFirstPromptWatchdogMs(config3);`)) {
    text = replaceOnce(
      text,
      `  const firstPromptWatchdogMs = Math.max(1000, Number(config3.first_prompt_timeout_seconds ?? DEFAULT_FIRST_PROMPT_WATCHDOG_MS / 1000) * 1000);
  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers, firstPromptWatchdogMs);`,
      `  const firstPromptWatchdogMs = configuredFirstPromptWatchdogMs(config3);
  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers, firstPromptWatchdogMs);`,
      "firstPromptWatchdog.environment",
    );
  }

  return text;
}

function applyExactPentestFallbackStateMachine(original) {
  if (original.includes("function openConfigCanRetryFallbackError(error, retryOnErrors)")) return original;
  let text = original;
  text = replaceOnce(text, `function prepareFallback(sessionID, state3, fallbackModels, config3, options = {}) {
  if (state3.attemptCount >= config3.max_fallback_attempts) {
    log2(\`[\${HOOK_NAME13}] Max fallback attempts reached\`, { sessionID, attempts: state3.attemptCount });
    return { success: false, error: "Max fallback attempts reached", maxAttemptsReached: true };
  }
  const failedModel = state3.currentModel;`, `function prepareFallback(sessionID, state3, fallbackModels, config3, options = {}) {
  if (state3.pendingFallbackModel) {
    log2(\`[\${HOOK_NAME13}] Duplicate fallback signal skipped\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
    return { success: false, error: "Fallback already pending", duplicate: true };
  }
  const failedModel = state3.currentModel;`, "v8 state-machine entry");
  text = replaceOnce(text, `  if (shouldRetryPrimaryBeforeFallback(state3, config3, options)) {
    state3.failedModels.set(failedModel, now);
    state3.attemptCount++;
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;`, `  if (shouldRetryPrimaryBeforeFallback(state3, config3, options)) {
    state3.failedModels.set(failedModel, now);
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;`, "v8 retry budget");
  text = replaceOnce(text, `  const nextModel = findNextAvailableFallback(state3, fallbackModels, config3.cooldown_seconds);`, `  if (state3.attemptCount >= config3.max_fallback_attempts) {
    log2(\`[\${HOOK_NAME13}] Max fallback attempts reached\`, { sessionID, attempts: state3.attemptCount });
    return { success: false, error: "Max fallback attempts reached", maxAttemptsReached: true };
  }
  const nextModel = findNextAvailableFallback(state3, fallbackModels, config3.cooldown_seconds);`, "v8 transition budget");
  text = replaceOnce(text, `function isRetryableError(error, retryOnErrors) {
  return isRuntimeFallbackRetryableError(error, retryOnErrors, {
    onUnsafeRetryableSignalRejected: ({ statusCode, retryOnErrors: retryOnErrors2 }) => {
      log2(\`[\${HOOK_NAME13}] Retryable signal rejected due to unsafe status code\`, {
        statusCode,
        retryOnErrors: retryOnErrors2
      });
    }
  });
}`, `function isRetryableError(error, retryOnErrors) {
  return isRuntimeFallbackRetryableError(error, retryOnErrors, {
    onUnsafeRetryableSignalRejected: ({ statusCode, retryOnErrors: retryOnErrors2 }) => {
      log2(\`[\${HOOK_NAME13}] Retryable signal rejected due to unsafe status code\`, { statusCode, retryOnErrors: retryOnErrors2 });
    }
  });
}
function openConfigCanRetryFallbackError(error, retryOnErrors) {
  const statusCode = extractStatusCode(error, retryOnErrors);
  if ([400, 401, 403].includes(statusCode) || classifyErrorType(error) === "model_not_found") return false;
  if (statusCode === 429 || statusCode === 503) return true;
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, "v8 retryability classifier");
  text = replaceOnce(text, `        const assistantText = getAssistantText(parts);
        if (!assistantText) {
          continue;
        }
        if (extractAutoRetrySignalFn({ message: assistantText })) {`, `        const assistantText = getAssistantText(parts);
        const visibleNonTextPart = (parts ?? []).some((part) => part?.type === "reasoning" || part?.type === "tool" || part?.type === "tool_use" || part?.type === "tool-call" || part?.type === "tool-invocation");
        if (!assistantText && !visibleNonTextPart) continue;
        if (assistantText && extractAutoRetrySignalFn({ message: assistantText })) {`, "v8 visible output");
  text = replaceOnce(text, `      if (!isRetryableError(error, config3.retry_on_errors)) {`, `      if (!openConfigCanRetryFallbackError(error, config3.retry_on_errors)) {`, "v8 message retryability");
  text = replaceOnce(text, `      const agent2 = info?.agent;
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent2);`, `      if (await checkVisibleResponse(ctx, sessionID, info)) {
        log2(\`[\${HOOK_NAME13}] message.updated fallback skipped after visible assistant output\`, { sessionID, model });
        return;
      }
      const agent2 = info?.agent;
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent2);`, "v8 message visible guard");
  text = replaceOnce(text, `      const errorTypeForPrimaryRetry = classifyErrorType(error);
      const statusCodeForPrimaryRetry = extractStatusCode(error, config3.retry_on_errors);
      const allowPrimaryRetry = Boolean(retrySignal) || (!["abort", "context_overflow", "missing_api_key", "invalid_api_key", "model_not_found", "quota_exceeded"].includes(errorTypeForPrimaryRetry ?? "") && (statusCodeForPrimaryRetry === undefined || statusCodeForPrimaryRetry >= 500 || statusCodeForPrimaryRetry === 408 || statusCodeForPrimaryRetry === 425 || statusCodeForPrimaryRetry === 429));`, `      const allowPrimaryRetry = openConfigCanRetryFallbackError(error, config3.retry_on_errors);`, "v8 primary retryability");
  text = replaceOnce(text, `      const fetchedParts = originalRetryMetadata.parts.length > 0 ? originalRetryMetadata.parts : retryPayload.retryParts;
      const usingFetchedUserParts = originalRetryMetadata.parts.length > 0;
      const retryParts = fetchedParts.length > 0 ? fetchedParts : (() => {
        log2(\`[\${HOOK_NAME13}] No user message parts found for auto-retry (\${source}); using synthetic continuation\`, {
          sessionID,
          hint: "This can occur when the working directory contains .git and messages are not yet persisted"
        });
        return [createInternalAgentContinuationTextPart("continue")];
      })();
      const retryMessageID = usingFetchedUserParts ? originalRetryMetadata.messageID : undefined;`, `      const retryParts = originalRetryMetadata.parts;
      const retryMessageID = originalRetryMetadata.messageID;
      if (retryParts.length === 0 || !retryMessageID) {
        log2(\`[\${HOOK_NAME13}] Auto-retry blocked without one durable human user message/messageID (\${source})\`, { sessionID });
        return { accepted: false, status: "missing-user-message", reason: "No durable human user message/messageID" };
      }`, "v8 durable user retry");
  return text;
}

function applyFinalPentestFallbackGuards(original) {
  if (original.includes("session.status retry skipped after visible assistant output")) return original;
  let text = original;
  text = replaceOnce(text, `    if (!retrySignal) {
      const messageLower = retryMessage.toLowerCase();
      const matchesRetryablePattern = RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(messageLower));
      if (!matchesRetryablePattern) {
        if (retryMessage) {
          log2(\`[\${HOOK_NAME13}] session.status retry with non-matching message\`, {
            sessionID,
            attempt: status.attempt,
            retryMessage
          });
        }
        return;
      }
    }`, `    if (!openConfigCanRetryFallbackError({ message: retryMessage, status: retryMessage }, deps.config.retry_on_errors)) {
      if (retryMessage) log2(\`[\${HOOK_NAME13}] session.status retry with non-matching message\`, { sessionID, attempt: status.attempt, retryMessage });
      return;
    }`, "v9 session retryability");
  text = replaceOnce(text, `    if (state3.pendingFallbackModel) {
      if (state3.pendingFallbackPromptMayHaveBeenAccepted) {
        log2(\`[\${HOOK_NAME13}] session.status retry skipped (pending fallback prompt may already be accepted)\`, {
          sessionID,
          pendingFallbackModel: state3.pendingFallbackModel
        });
        return;
      }
      if (timeoutEnabled) {
        log2(\`[\${HOOK_NAME13}] Clearing pending fallback due to provider auto-retry signal\`, {
          sessionID,
          pendingFallbackModel: state3.pendingFallbackModel
        });
        state3.pendingFallbackModel = undefined;
        state3.pendingFallbackPromptMayHaveBeenAccepted = false;
      } else {
        log2(\`[\${HOOK_NAME13}] session.status retry skipped (pending fallback in progress)\`, {
          sessionID,
          pendingFallbackModel: state3.pendingFallbackModel
        });
        return;
      }
    }`, `    if (state3.pendingFallbackModel) {
      log2(\`[\${HOOK_NAME13}] session.status retry skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
      return;
    }
    if (await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {
      log2(\`[\${HOOK_NAME13}] session.status retry skipped after visible assistant output\`, { sessionID });
      return;
    }`, "v9 session duplicate and visible guard");
  text = replaceOnce(text, `      if (retrySignal && timeoutEnabled && (sessionRetryInFlight.has(sessionID) || wasAwaitingFallbackResult)) {
        log2(\`[\${HOOK_NAME13}] Overriding active retry due to provider auto-retry signal\`, {
          sessionID,
          model
        });
        await helpers.abortSessionRequest(sessionID, "message.updated.retry-signal");
        sessionRetryInFlight.delete(sessionID);
      }`, `      if (retrySignal && timeoutEnabled && (sessionRetryInFlight.has(sessionID) || wasAwaitingFallbackResult)) {
        log2(\`[\${HOOK_NAME13}] message.updated duplicate retry signal skipped\`, { sessionID, model });
        return;
      }`, "v9 in-flight duplicate guard");
  text = replaceOnce(text, `        if (state3.pendingFallbackModel) {
          if (retrySignal && timeoutEnabled) {
            log2(\`[\${HOOK_NAME13}] Clearing pending fallback due to provider auto-retry signal\`, {
              sessionID,
              pendingFallbackModel: state3.pendingFallbackModel
            });
            state3.pendingFallbackModel = undefined;
            state3.pendingFallbackPromptMayHaveBeenAccepted = false;
          } else {
            log2(\`[\${HOOK_NAME13}] message.updated fallback skipped (pending fallback in progress)\`, {
              sessionID,
              pendingFallbackModel: state3.pendingFallbackModel
            });
            return;
          }
        }`, `        if (state3.pendingFallbackModel) {
          log2(\`[\${HOOK_NAME13}] message.updated fallback skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
          return;
        }`, "v9 pending duplicate guard");
  return text;
}

function applyPrimaryRetryLogFix(original) {
  if (original.includes("maxPrimaryRetries: configuredPrimaryRetryLimit(config3),")) return original;
  return replaceOnce(original, `      maxPrimaryRetries,`, `      maxPrimaryRetries: configuredPrimaryRetryLimit(config3),`, "v10 primary retry log scope");
}

/* Superseded v11 implementation retained only to support review of historical
 * patch anchors; v12 uses the clean helpers below. */
/*
function applyPentestTransitionCap(original) {
  if (original.includes("function openConfigFallbackTransitionLimit(config3)")) return original;
  let text = original;
  text = replaceOnce(
    text,
    `function prepareFallback(sessionID, state3, fallbackModels, config3, options = {}) {`,
    `function openConfigFallbackTransitionLimit(config3) {
  const configured = Number(config3.max_fallback_attempts);
  const limit = Number.isFinite(configured) ? Math.max(1, Math.trunc(configured)) : 1;
  // Pentest has exactly one model transition (Flash → Pro); normal preserves
  // the configured native OmO transition budget.
  return typeof process !== "undefined" && process.env?.OPENCONFIG_RUNTIME_PROFILE === "pentest" ? Math.min(limit, 1) : limit;
}

function applyPentestEventGuardsAndNormalPreservation(original) {
  if (original.includes("function openConfigPentestFallbackActive()")) return original;
  let text = original;
  text = replaceOnce(text, `function openConfigCanRetryFallbackError(error, retryOnErrors) {
  const statusCode = extractStatusCode(error, retryOnErrors);
  if ([400, 401, 403].includes(statusCode) || classifyErrorType(error) === "model_not_found") return false;
  if (statusCode === 429 || statusCode === 503) return true;
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, `function openConfigPentestFallbackActive() {
  return typeof process !== "undefined" && process.env?.OPENCONFIG_RUNTIME_PROFILE === "pentest";
}
function openConfigCanRetryFallbackError(error, retryOnErrors) {
  // Preserve normal's native retry classification byte-for-byte in behavior.
  if (!openConfigPentestFallbackActive()) return isRetryableError(error, retryOnErrors);
  const statusCode = extractStatusCode(error, retryOnErrors);
  if ([400, 401, 403].includes(statusCode) || classifyErrorType(error) === "model_not_found") return false;
  if (statusCode === 429 || statusCode === 503) return true;
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}
function openConfigAllowPrimaryRetry(error, retrySignal, retryOnErrors) {
  if (openConfigPentestFallbackActive()) return openConfigCanRetryFallbackError(error, retryOnErrors);
  const errorType = classifyErrorType(error);
  const statusCode = extractStatusCode(error, retryOnErrors);
  return Boolean(retrySignal) || (![
    "abort", "context_overflow", "missing_api_key", "invalid_api_key", "model_not_found", "quota_exceeded"
  ].includes(errorType ?? "") && (statusCode === undefined || statusCode >= 500 || statusCode === 408 || statusCode === 425 || statusCode === 429));
}
function openConfigCanRetrySessionStatus(retrySignal, retryMessage, retryOnErrors) {
  if (openConfigPentestFallbackActive()) return openConfigCanRetryFallbackError({ message: retryMessage, status: retryMessage }, retryOnErrors);
  if (retrySignal) return true;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(retryMessage.toLowerCase()));
}`, "v12 profile-gated retry classifier");
  text = replaceOnce(text, `  if (state3.pendingFallbackModel) {
    log2(\`[\${HOOK_NAME13}] Duplicate fallback signal skipped\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
    return { success: false, error: "Fallback already pending", duplicate: true };
  }
  const failedModel = state3.currentModel;
  const now = Date.now();`, `  if (openConfigPentestFallbackActive() && state3.pendingFallbackModel) {
    log2(\`[\${HOOK_NAME13}] Duplicate fallback signal skipped\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
    return { success: false, error: "Fallback already pending", duplicate: true };
  }
  const failedModel = state3.currentModel;
  const now = Date.now();
  if (!openConfigPentestFallbackActive() && state3.attemptCount >= config3.max_fallback_attempts) {
    log2(\`[\${HOOK_NAME13}] Max fallback attempts reached\`, { sessionID, attempts: state3.attemptCount });
    return { success: false, error: "Max fallback attempts reached", maxAttemptsReached: true };
  }`, "v12 normal prepareFallback budget");
  text = replaceOnce(text, `    state3.failedModels.set(failedModel, now);
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;`, `    state3.failedModels.set(failedModel, now);
    if (!openConfigPentestFallbackActive()) state3.attemptCount++;
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;`, "v12 normal primary retry budget");
  text = replaceOnce(text, `      const retryParts = originalRetryMetadata.parts;
      const retryMessageID = originalRetryMetadata.messageID;
      if (retryParts.length === 0 || !retryMessageID) {
        log2(\`[\${HOOK_NAME13}] Auto-retry blocked without one durable human user message/messageID (\${source})\`, { sessionID });
        return { accepted: false, status: "missing-user-message", reason: "No durable human user message/messageID" };
      }`, `      let retryParts = originalRetryMetadata.parts;
      let retryMessageID = originalRetryMetadata.messageID;
      if (!openConfigPentestFallbackActive()) {
        const fetchedParts = originalRetryMetadata.parts.length > 0 ? originalRetryMetadata.parts : retryPayload.retryParts;
        const usingFetchedUserParts = originalRetryMetadata.parts.length > 0;
        retryParts = fetchedParts.length > 0 ? fetchedParts : [createInternalAgentContinuationTextPart("continue")];
        retryMessageID = usingFetchedUserParts ? originalRetryMetadata.messageID : undefined;
      } else if (retryParts.length === 0 || !retryMessageID) {
        log2(\`[\${HOOK_NAME13}] Auto-retry blocked without one durable human user message/messageID (\${source})\`, { sessionID });
        return { accepted: false, status: "missing-user-message", reason: "No durable human user message/messageID" };
      }`, "v12 durable retry profile gate");
  text = replaceOnce(text, `    if (!openConfigCanRetryFallbackError({ message: retryMessage, status: retryMessage }, deps.config.retry_on_errors)) {`, `    if (!openConfigCanRetrySessionStatus(retrySignal, retryMessage, deps.config.retry_on_errors)) {`, "v12 session.status classifier");
  text = replaceOnce(text, `    if (await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {`, `    if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {`, "v12 session.status semantic guard");
  text = replaceOnce(text, `    if (!isRetryableError(error, config3.retry_on_errors)) {`, `    if (!openConfigCanRetryFallbackError(error, config3.retry_on_errors)) {`, "v12 session.error classifier");
  text = replaceOnce(text, `    let state3 = sessionStates.get(sessionID);
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig);`, `    if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {
      log2(\`[\${HOOK_NAME13}] session.error fallback skipped after visible assistant output\`, { sessionID });
      return;
    }
    let state3 = sessionStates.get(sessionID);
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig);`, "v12 session.error semantic guard");
  text = replaceOnce(text, `      if (sessionRetryInFlight.has(sessionID)) {
        log2(\`[\${HOOK_NAME13}] Overriding in-flight retry due to session timeout\`, { sessionID });
      }
      await abortSessionRequest(sessionID, "session.timeout");`, `      if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {
        log2(\`[\${HOOK_NAME13}] session.timeout retry skipped after visible assistant output\`, { sessionID });
        return;
      }
      if (sessionRetryInFlight.has(sessionID)) {
        log2(\`[\${HOOK_NAME13}] Overriding in-flight retry due to session timeout\`, { sessionID });
      }
      await abortSessionRequest(sessionID, "session.timeout");`, "v12 timeout semantic guard");
  text = replaceOnce(text, `      if (await checkVisibleResponse(ctx, sessionID, info)) {`, `      if (openConfigPentestFallbackActive() && await checkVisibleResponse(ctx, sessionID, info)) {`, "v12 message.updated semantic guard");
  text = replaceOnce(text, `      const allowPrimaryRetry = openConfigCanRetryFallbackError(error, config3.retry_on_errors);`, `      const allowPrimaryRetry = openConfigAllowPrimaryRetry(error, retrySignal, config3.retry_on_errors);`, "v12 message.updated primary classifier");
  return text;
}
function prepareFallback(sessionID, state3, fallbackModels, config3, options = {}) {`,
    "v11 pentest transition limit helper",
  );
  text = replaceOnce(
    text,
    `  if (state3.attemptCount >= config3.max_fallback_attempts) {`,
    `  if (state3.attemptCount >= openConfigFallbackTransitionLimit(config3)) {`,
    "v11 pentest transition limit",
  );
  return text;
}

*/

function applyPentestTransitionCapV12(original) {
  if (original.includes("function openConfigFallbackTransitionLimit(config3)")) return original;
  let text = original;
  text = replaceOnce(
    text,
    `function prepareFallback(sessionID, state3, fallbackModels, config3, options = {}) {`,
    `function openConfigFallbackTransitionLimit(config3) {
  const configured = Number(config3.max_fallback_attempts);
  const limit = Number.isFinite(configured) ? Math.max(1, Math.trunc(configured)) : 1;
  return typeof process !== "undefined" && process.env?.OPENCONFIG_RUNTIME_PROFILE === "pentest" ? Math.min(limit, 1) : limit;
}
function prepareFallback(sessionID, state3, fallbackModels, config3, options = {}) {`,
    "v12 pentest transition limit helper",
  );
  text = replaceOnce(
    text,
    `  if (state3.attemptCount >= config3.max_fallback_attempts) {`,
    `  if (state3.attemptCount >= openConfigFallbackTransitionLimit(config3)) {`,
    "v12 pentest transition limit",
  );
  return text;
}

function applyPentestEventGuardsV12(original) {
  if (original.includes("function openConfigPentestFallbackActive()")) return original;
  let text = original;
  text = replaceOnce(text, `function openConfigCanRetryFallbackError(error, retryOnErrors) {
  const statusCode = extractStatusCode(error, retryOnErrors);
  if ([400, 401, 403].includes(statusCode) || classifyErrorType(error) === "model_not_found") return false;
  if (statusCode === 429 || statusCode === 503) return true;
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, `function openConfigPentestFallbackActive() {
  return typeof process !== "undefined" && process.env?.OPENCONFIG_RUNTIME_PROFILE === "pentest";
}
function openConfigCanRetryFallbackError(error, retryOnErrors) {
  if (!openConfigPentestFallbackActive()) return isRetryableError(error, retryOnErrors);
  const statusCode = extractStatusCode(error, retryOnErrors);
  if ([400, 401, 403].includes(statusCode) || classifyErrorType(error) === "model_not_found") return false;
  if (statusCode === 429 || statusCode === 503) return true;
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}
function openConfigAllowPrimaryRetry(error, retrySignal, retryOnErrors) {
  if (openConfigPentestFallbackActive()) return openConfigCanRetryFallbackError(error, retryOnErrors);
  const errorType = classifyErrorType(error);
  const statusCode = extractStatusCode(error, retryOnErrors);
  return Boolean(retrySignal) || (![
    "abort", "context_overflow", "missing_api_key", "invalid_api_key", "model_not_found", "quota_exceeded"
  ].includes(errorType ?? "") && (statusCode === undefined || statusCode >= 500 || statusCode === 408 || statusCode === 425 || statusCode === 429));
}
function openConfigCanRetrySessionStatus(retrySignal, retryMessage, retryOnErrors) {
  if (openConfigPentestFallbackActive()) return openConfigCanRetryFallbackError({ message: retryMessage, status: retryMessage }, retryOnErrors);
  if (retrySignal) return true;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(retryMessage.toLowerCase()));
}`, "v12 profile-gated retry classifier");
  text = replaceOnce(text, `  if (state3.pendingFallbackModel) {
    log2(\`[\${HOOK_NAME13}] Duplicate fallback signal skipped\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
    return { success: false, error: "Fallback already pending", duplicate: true };
  }
  const failedModel = state3.currentModel;
  const now = Date.now();`, `  if (openConfigPentestFallbackActive() && state3.pendingFallbackModel) {
    log2(\`[\${HOOK_NAME13}] Duplicate fallback signal skipped\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
    return { success: false, error: "Fallback already pending", duplicate: true };
  }
  const failedModel = state3.currentModel;
  const now = Date.now();
  if (!openConfigPentestFallbackActive() && state3.attemptCount >= config3.max_fallback_attempts) {
    return { success: false, error: "Max fallback attempts reached", maxAttemptsReached: true };
  }`, "v12 normal prepareFallback budget");
  text = replaceOnce(text, `    state3.failedModels.set(failedModel, now);
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;`, `    state3.failedModels.set(failedModel, now);
    if (!openConfigPentestFallbackActive()) state3.attemptCount++;
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;`, "v12 normal primary retry budget");
  text = replaceOnce(text, `      const retryParts = originalRetryMetadata.parts;
      const retryMessageID = originalRetryMetadata.messageID;
      if (retryParts.length === 0 || !retryMessageID) {
        log2(\`[\${HOOK_NAME13}] Auto-retry blocked without one durable human user message/messageID (\${source})\`, { sessionID });
        return { accepted: false, status: "missing-user-message", reason: "No durable human user message/messageID" };
      }`, `      let retryParts = originalRetryMetadata.parts;
      let retryMessageID = originalRetryMetadata.messageID;
      if (!openConfigPentestFallbackActive()) {
        const fetchedParts = originalRetryMetadata.parts.length > 0 ? originalRetryMetadata.parts : retryPayload.retryParts;
        const usingFetchedUserParts = originalRetryMetadata.parts.length > 0;
        retryParts = fetchedParts.length > 0 ? fetchedParts : [createInternalAgentContinuationTextPart("continue")];
        retryMessageID = usingFetchedUserParts ? originalRetryMetadata.messageID : undefined;
      } else if (retryParts.length === 0 || !retryMessageID) {
        log2(\`[\${HOOK_NAME13}] Auto-retry blocked without one durable human user message/messageID (\${source})\`, { sessionID });
        return { accepted: false, status: "missing-user-message", reason: "No durable human user message/messageID" };
      }`, "v12 durable retry profile gate");
  text = replaceOnce(text, `    if (!openConfigCanRetryFallbackError({ message: retryMessage, status: retryMessage }, deps.config.retry_on_errors)) {`, `    if (!openConfigCanRetrySessionStatus(retrySignal, retryMessage, deps.config.retry_on_errors)) {`, "v12 session.status classifier");
  text = replaceOnce(text, `    if (await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {`, `    if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {`, "v12 session.status semantic guard");
  text = replaceOnce(text, `    if (!isRetryableError(error, config3.retry_on_errors)) {`, `    if (!openConfigCanRetryFallbackError(error, config3.retry_on_errors)) {`, "v12 session.error classifier");
  text = replaceOnce(text, `    let state3 = sessionStates.get(sessionID);
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig);`, `    if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {
      log2(\`[\${HOOK_NAME13}] session.error fallback skipped after visible assistant output\`, { sessionID });
      return;
    }
    let state3 = sessionStates.get(sessionID);
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig);`, "v12 session.error semantic guard");
  text = replaceOnce(text, `      if (sessionRetryInFlight.has(sessionID)) {
        log2(\`[\${HOOK_NAME13}] Overriding in-flight retry due to session timeout\`, { sessionID });
      }
      await abortSessionRequest(sessionID, "session.timeout");`, `      if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {
        log2(\`[\${HOOK_NAME13}] session.timeout retry skipped after visible assistant output\`, { sessionID });
        return;
      }
      if (sessionRetryInFlight.has(sessionID)) {
        log2(\`[\${HOOK_NAME13}] Overriding in-flight retry due to session timeout\`, { sessionID });
      }
      await abortSessionRequest(sessionID, "session.timeout");`, "v12 timeout semantic guard");
  text = replaceOnce(text, `      if (await checkVisibleResponse(ctx, sessionID, info)) {`, `      if (openConfigPentestFallbackActive() && await checkVisibleResponse(ctx, sessionID, info)) {`, "v12 message.updated semantic guard");
  text = replaceOnce(text, `      const allowPrimaryRetry = openConfigCanRetryFallbackError(error, config3.retry_on_errors);`, `      const allowPrimaryRetry = openConfigAllowPrimaryRetry(error, retrySignal, config3.retry_on_errors);`, "v12 message.updated primary classifier");
  return text;
}

function applyPentestEventGuardsV13(original) {
  if (original.includes("function openConfigShouldBlockFallbackReplay")) return original;
  let text = original;
  text = replaceOnce(text, `function hasVisibleAssistantResponse(extractAutoRetrySignalFn) {
  return async (ctx, sessionID, _info) => {
    try {
      const messagesResponse = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory }
      });
      const messages = extractSessionMessages(messagesResponse);
      if (!messages || messages.length === 0)
        return false;
      const lastUserMessageIndex = getLastUserMessageIndex(messages);
      if (lastUserMessageIndex === -1)
        return false;
      for (let index = lastUserMessageIndex + 1;index < messages.length; index++) {
        const message = messages[index];
        if (message?.info?.role !== "assistant") {
          continue;
        }
        if (message.info?.error) {
          continue;
        }
        const infoParts = message.info?.parts;
        const infoMessageParts = Array.isArray(infoParts) ? infoParts.filter((part) => typeof part === "object" && part !== null) : undefined;
        const parts = message.parts && message.parts.length > 0 ? message.parts : infoMessageParts;
        const assistantText = getAssistantText(parts);
        const visibleNonTextPart = (parts ?? []).some((part) => part?.type === "reasoning" || part?.type === "tool" || part?.type === "tool_use" || part?.type === "tool-call" || part?.type === "tool-invocation");
        if (!assistantText && !visibleNonTextPart) continue;
        if (assistantText && extractAutoRetrySignalFn({ message: assistantText })) {
          continue;
        }
        return true;
      }
      return false;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      return false;
    }
  };
}`, `const openConfigVisibleAssistantOutputSessions = new Set;
function openConfigHasVisibleAssistantOutput(info, parts, extractAutoRetrySignalFn) {
  const infoParts = info?.parts;
  const candidates = Array.isArray(parts) && parts.length > 0 ? parts : Array.isArray(infoParts) ? infoParts.filter((part) => typeof part === "object" && part !== null) : [];
  const assistantText = getAssistantText(candidates);
  const visibleNonTextPart = candidates.some((part) => part?.type === "reasoning" || part?.type === "tool" || part?.type === "tool_use" || part?.type === "tool-call" || part?.type === "tool-invocation");
  if (!assistantText && !visibleNonTextPart) return false;
  return visibleNonTextPart || !extractAutoRetrySignalFn({ message: assistantText, status: assistantText, summary: assistantText });
}
function openConfigShouldBlockFallbackReplay(sessionID, info, parts, extractAutoRetrySignalFn) {
  if (info?.role === "assistant" && openConfigHasVisibleAssistantOutput(info, parts, extractAutoRetrySignalFn)) {
    openConfigVisibleAssistantOutputSessions.add(sessionID);
    return true;
  }
  return openConfigVisibleAssistantOutputSessions.has(sessionID);
}
function hasVisibleAssistantResponse(extractAutoRetrySignalFn) {
  return async (ctx, sessionID, currentInfo, currentParts) => {
    if (openConfigShouldBlockFallbackReplay(sessionID, currentInfo, currentParts, extractAutoRetrySignalFn)) return true;
    try {
      const messagesResponse = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory }
      });
      const messages = extractSessionMessages(messagesResponse);
      if (!messages || messages.length === 0) return false;
      const lastUserMessageIndex = getLastUserMessageIndex(messages);
      if (lastUserMessageIndex === -1) return false;
      for (let index = lastUserMessageIndex + 1;index < messages.length; index++) {
        const message = messages[index];
        if (message?.info?.role !== "assistant") continue;
        if (openConfigShouldBlockFallbackReplay(sessionID, message.info, message.parts, extractAutoRetrySignalFn)) return true;
      }
      return false;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  };
}`, "v13 current assistant output guard");
  text = replaceOnce(text, `function openConfigCanRetryFallbackError(error, retryOnErrors) {
  if (!openConfigPentestFallbackActive()) return isRetryableError(error, retryOnErrors);
  const statusCode = extractStatusCode(error, retryOnErrors);
  if ([400, 401, 403].includes(statusCode) || classifyErrorType(error) === "model_not_found") return false;
  if (statusCode === 429 || statusCode === 503) return true;
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, `function openConfigPentestStatusCode(error) {
  const seen = new Set;
  const visit = (value) => {
    if (value === null || value === undefined || seen.has(value)) return undefined;
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string") {
      const match = value.match(/(?:^|\\b)(?:HTTP\\s*)?(400|401|403|408|425|429|500|502|503|504)(?:\\b|$)/i);
      return match ? Number(match[1]) : undefined;
    }
    if (typeof value !== "object") return undefined;
    seen.add(value);
    for (const key of ["statusCode", "status", "httpStatus", "code"]) {
      const found = visit(value[key]);
      if (found !== undefined) return found;
    }
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(error);
}
function openConfigCanRetryFallbackError(error, retryOnErrors) {
  if (!openConfigPentestFallbackActive()) return isRetryableError(error, retryOnErrors);
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  const errorType = String(classifyErrorType(error) ?? "").toLowerCase();
  const unsafeType = /model[ _-]?not[ _-]?found|missing[ _-]?api[ _-]?key|invalid[ _-]?api[ _-]?key|quota[ _-]?exceeded/i.test(\`\${errorType} \${serialized}\`);
  const statusCode = openConfigPentestStatusCode(error) ?? extractStatusCode(error, retryOnErrors);
  if ([400, 401, 403].includes(Number(statusCode)) || unsafeType) return false;
  if (Number(statusCode) === 429 || Number(statusCode) === 503) return true;
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, "v13 absolute pentest retry classifier");
  text = replaceOnce(text, `      if (openConfigPentestFallbackActive() && await checkVisibleResponse(ctx, sessionID, info)) {`, `      if (openConfigPentestFallbackActive() && await checkVisibleResponse(ctx, sessionID, info, parts)) {`, "v13 message.updated current output guard");
  text = replaceOnce(text, `    if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {
      log2(\`[\${HOOK_NAME13}] session.error fallback skipped after visible assistant output\`, { sessionID });`, `    if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID, props?.info, props?.parts)) {
      log2(\`[\${HOOK_NAME13}] session.error fallback skipped after visible assistant output\`, { sessionID });`, "v13 session.error current output guard");
  text = replaceOnce(text, `      if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {
        log2(\`[\${HOOK_NAME13}] session.timeout retry skipped after visible assistant output\`, { sessionID });`, `      if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {
        log2(\`[\${HOOK_NAME13}] session.timeout retry skipped after visible assistant output\`, { sessionID });`, "v13 timeout output guard");
  text = replaceOnce(text, `    if (state3.pendingFallbackModel) {
      log2(\`[\${HOOK_NAME13}] session.status retry skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
      return;
    }
    if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {`, `    if (state3.pendingFallbackModel) {
      if (openConfigPentestFallbackActive()) {
        log2(\`[\${HOOK_NAME13}] session.status retry skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
        return;
      }
      if (state3.pendingFallbackPromptMayHaveBeenAccepted) return;
      if (timeoutEnabled) {
        state3.pendingFallbackModel = undefined;
        state3.pendingFallbackPromptMayHaveBeenAccepted = false;
      } else return;
    }
    if (openConfigPentestFallbackActive() && await hasVisibleAssistantResponse(extractAutoRetrySignal)(deps.ctx, sessionID)) {`, "v13 normal session.status duplicate semantics");
  text = replaceOnce(text, `      if (retrySignal && timeoutEnabled && (sessionRetryInFlight.has(sessionID) || wasAwaitingFallbackResult)) {
        log2(\`[\${HOOK_NAME13}] message.updated duplicate retry signal skipped\`, { sessionID, model });
        return;
      }`, `      if (retrySignal && timeoutEnabled && (sessionRetryInFlight.has(sessionID) || wasAwaitingFallbackResult)) {
        if (openConfigPentestFallbackActive()) {
          log2(\`[\${HOOK_NAME13}] message.updated duplicate retry signal skipped\`, { sessionID, model });
          return;
        }
        await helpers.abortSessionRequest(sessionID, "message.updated.retry-signal");
        sessionRetryInFlight.delete(sessionID);
      }`, "v13 normal message.updated in-flight semantics");
  return text;
}

function applyPentestEventGuardsV14(original) {
  if (original.includes("function openConfigObserveFallbackEvent")) return original;
  let text = original;
  text = replaceOnce(text, `const openConfigVisibleAssistantOutputSessions = new Set;
function openConfigHasVisibleAssistantOutput(info, parts, extractAutoRetrySignalFn) {
  const infoParts = info?.parts;
  const candidates = Array.isArray(parts) && parts.length > 0 ? parts : Array.isArray(infoParts) ? infoParts.filter((part) => typeof part === "object" && part !== null) : [];
  const assistantText = getAssistantText(candidates);
  const visibleNonTextPart = candidates.some((part) => part?.type === "reasoning" || part?.type === "tool" || part?.type === "tool_use" || part?.type === "tool-call" || part?.type === "tool-invocation");
  if (!assistantText && !visibleNonTextPart) return false;
  return visibleNonTextPart || !extractAutoRetrySignalFn({ message: assistantText, status: assistantText, summary: assistantText });
}
function openConfigShouldBlockFallbackReplay(sessionID, info, parts, extractAutoRetrySignalFn) {
  if (info?.role === "assistant" && openConfigHasVisibleAssistantOutput(info, parts, extractAutoRetrySignalFn)) {
    openConfigVisibleAssistantOutputSessions.add(sessionID);
    return true;
  }
  return openConfigVisibleAssistantOutputSessions.has(sessionID);
}`, `const openConfigVisibleAssistantOutputSessions = new Map;
function openConfigClearFallbackReplay(sessionID) {
  if (sessionID) openConfigVisibleAssistantOutputSessions.delete(sessionID);
}
function openConfigClearAllFallbackReplays() {
  openConfigVisibleAssistantOutputSessions.clear();
}
function openConfigIsPureRetrySignalText(text, extractAutoRetrySignalFn) {
  const normalized = String(text ?? "").trim().replace(/\\s+/g, " ").toLowerCase();
  if (!normalized || !extractAutoRetrySignalFn({ message: normalized, status: normalized, summary: normalized })) return false;
  return /^(?:\\[?503\\]?\\s*)?(?:request queue is full|endpoint is unavailable|service unavailable)(?:[.;,]?\\s*(?:retrying|try again))?$|^retrying(?:\\s+request)?$/.test(normalized);
}
function openConfigHasVisibleAssistantOutput(info, parts, extractAutoRetrySignalFn) {
  const infoParts = info?.parts;
  const candidates = Array.isArray(parts) && parts.length > 0 ? parts : Array.isArray(infoParts) ? infoParts.filter((part) => typeof part === "object" && part !== null) : [];
  const assistantText = getAssistantText(candidates);
  const visibleNonTextPart = candidates.some((part) => part?.type === "reasoning" || part?.type === "tool" || part?.type === "tool_use" || part?.type === "tool-call" || part?.type === "tool-invocation");
  if (!assistantText && !visibleNonTextPart) return false;
  return visibleNonTextPart || !openConfigIsPureRetrySignalText(assistantText, extractAutoRetrySignalFn);
}
function openConfigObserveFallbackEvent(props, extractAutoRetrySignalFn) {
  const sessionID = resolveMessageEventSessionID(props);
  const info = props?.info;
  if (!sessionID) return false;
  if (info?.role === "user") {
    openConfigClearFallbackReplay(sessionID);
    return false;
  }
  const parts = props?.parts ?? (props?.part ? [props.part] : info?.parts);
  return openConfigShouldBlockFallbackReplay(sessionID, info, parts, extractAutoRetrySignalFn);
}
function openConfigShouldBlockFallbackReplay(sessionID, info, parts, extractAutoRetrySignalFn) {
  if (info?.role === "assistant" && openConfigHasVisibleAssistantOutput(info, parts, extractAutoRetrySignalFn)) {
    openConfigVisibleAssistantOutputSessions.set(sessionID, info?.messageID ?? info?.id ?? "current-turn");
    return true;
  }
  return openConfigVisibleAssistantOutputSessions.has(sessionID);
}`, "v14 turn-scoped visible output latch");
  text = replaceOnce(text, `    if (event.type === "message.updated") {
      if (!config3.enabled)
        return;
      const props = event.properties;
      await messageUpdateHandler(props);
      return;
    }
    await baseEventHandler({ event });`, `    const props = event.properties;
    if (event.type === "message.updated") {
      if (!config3.enabled) return;
      openConfigObserveFallbackEvent(props, extractAutoRetrySignal);
      await messageUpdateHandler(props);
      return;
    }
    if (event.type === "message.part.updated" || event.type === "message.part.delta") {
      if (config3.enabled) openConfigObserveFallbackEvent(props, extractAutoRetrySignal);
      return;
    }
    if (event.type === "session.idle" || event.type === "session.deleted") openConfigClearFallbackReplay(resolveSessionEventID(props));
    await baseEventHandler({ event });`, "v14 synchronous message part latch and cleanup");
  text = replaceOnce(text, `    deps.sessionStatusRetryKeys.clear();
    deps.internallyAbortedSessions.clear();
  };`, `    deps.sessionStatusRetryKeys.clear();
    deps.internallyAbortedSessions.clear();
    openConfigClearAllFallbackReplays();
  };`, "v14 dispose visible output cleanup");
  text = replaceOnce(text, `    if (!sessionID)
      return;
    if (cancelledSessions.has(sessionID)) {`, `    if (!sessionID)
      return;
    openConfigClearFallbackReplay(sessionID);
    if (cancelledSessions.has(sessionID)) {`, "v14 idle latch cleanup");
  text = replaceOnce(text, `function openConfigCanRetryFallbackError(error, retryOnErrors) {
  if (!openConfigPentestFallbackActive()) return isRetryableError(error, retryOnErrors);
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  const errorType = String(classifyErrorType(error) ?? "").toLowerCase();
  const unsafeType = /model[ _-]?not[ _-]?found|missing[ _-]?api[ _-]?key|invalid[ _-]?api[ _-]?key|quota[ _-]?exceeded/i.test(\`\${errorType} \${serialized}\`);
  const statusCode = openConfigPentestStatusCode(error) ?? extractStatusCode(error, retryOnErrors);
  if ([400, 401, 403].includes(Number(statusCode)) || unsafeType) return false;
  if (Number(statusCode) === 429 || Number(statusCode) === 503) return true;
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, `function openConfigPentestStatusCodes(error) {
  const statuses = new Set;
  const seen = new Set;
  const visit = (value) => {
    if (value === null || value === undefined || seen.has(value)) return;
    if (typeof value === "number" && Number.isFinite(value)) { statuses.add(Math.trunc(value)); return; }
    if (typeof value === "string") {
      for (const match of value.matchAll(/(?:^|\\b)(?:HTTP\\s*)?(400|401|403|408|425|429|500|502|503|504)(?:\\b|$)/gi)) statuses.add(Number(match[1]));
      return;
    }
    if (typeof value !== "object") return;
    seen.add(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(error);
  return statuses;
}
function openConfigCanRetryFallbackError(error, retryOnErrors) {
  if (!openConfigPentestFallbackActive()) return isRetryableError(error, retryOnErrors);
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  const errorType = String(classifyErrorType(error) ?? "").toLowerCase();
  const unsafeType = /model[ _-]?not[ _-]?found|missing[ _-]?api[ _-]?key|invalid[ _-]?api[ _-]?key|quota[ _-]?exceeded/i.test(\`\${errorType} \${serialized}\`);
  const statuses = openConfigPentestStatusCodes(error);
  if ([400, 401, 403].some((status) => statuses.has(status)) || unsafeType) return false;
  if (statuses.has(429) || statuses.has(503)) return true;
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, "v14 collect every nested status before retrying");
  text = replaceOnce(text, `        if (state3.pendingFallbackModel) {
          log2(\`[\${HOOK_NAME13}] message.updated fallback skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
          return;
        }`, `        if (state3.pendingFallbackModel) {
          if (openConfigPentestFallbackActive()) {
            log2(\`[\${HOOK_NAME13}] message.updated fallback skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
            return;
          }
          if (retrySignal && timeoutEnabled) {
            state3.pendingFallbackModel = undefined;
            state3.pendingFallbackPromptMayHaveBeenAccepted = false;
          } else {
            log2(\`[\${HOOK_NAME13}] message.updated fallback skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
            return;
          }
        }`, "v14 normal message.updated pending fallback semantics");
  return text;
}

function applyPentestEventGuardsV15(original) {
  if (original.includes("const openConfigFallbackUserTurns = new Map;")) return original;
  let text = original;
  text = replaceOnce(text, `const openConfigVisibleAssistantOutputSessions = new Map;
function openConfigClearFallbackReplay(sessionID) {
  if (sessionID) openConfigVisibleAssistantOutputSessions.delete(sessionID);
}
function openConfigClearAllFallbackReplays() {
  openConfigVisibleAssistantOutputSessions.clear();
}`, `const openConfigVisibleAssistantOutputSessions = new Map;
const openConfigFallbackUserTurns = new Map;
function openConfigClearFallbackReplay(sessionID) {
  if (!sessionID) return;
  openConfigVisibleAssistantOutputSessions.delete(sessionID);
  openConfigFallbackUserTurns.delete(sessionID);
}
function openConfigClearAllFallbackReplays() {
  openConfigVisibleAssistantOutputSessions.clear();
  openConfigFallbackUserTurns.clear();
}`, "v15 durable user turn latch scope");
  text = replaceOnce(text, `  if (info?.role === "user") {
    openConfigClearFallbackReplay(sessionID);
    return false;
  }`, `  if (info?.role === "user") {
    openConfigClearFallbackReplay(sessionID);
    openConfigFallbackUserTurns.set(sessionID, info?.id ?? info?.messageID ?? "current-turn");
    return false;
  }`, "v15 record durable user turn");
  text = replaceOnce(text, `    openConfigVisibleAssistantOutputSessions.set(sessionID, info?.messageID ?? info?.id ?? "current-turn");`, `    openConfigVisibleAssistantOutputSessions.set(sessionID, openConfigFallbackUserTurns.get(sessionID) ?? "current-turn");`, "v15 bind visible output to durable user turn");
  return text;
}

function applyPentestEventGuardsV16(original) {
  if (original.includes("function openConfigPartEventAsAssistant")) return original;
  let text = original;
  text = replaceOnce(text, `function openConfigObserveFallbackEvent(props, extractAutoRetrySignalFn) {
  const sessionID = resolveMessageEventSessionID(props);
  const info = props?.info;
  if (!sessionID) return false;
  if (info?.role === "user") {
    openConfigClearFallbackReplay(sessionID);
    openConfigFallbackUserTurns.set(sessionID, info?.id ?? info?.messageID ?? "current-turn");
    return false;
  }
  const parts = props?.parts ?? (props?.part ? [props.part] : info?.parts);
  return openConfigShouldBlockFallbackReplay(sessionID, info, parts, extractAutoRetrySignalFn);
}`, `function openConfigPartEventAsAssistant(props, sessionID) {
  const messageID = props?.messageID ?? props?.part?.messageID;
  const currentUserMessageID = openConfigFallbackUserTurns.get(sessionID);
  if (!messageID || messageID === currentUserMessageID) return undefined;
  const part = props?.part;
  if (part) return { info: { role: "assistant", messageID }, parts: [part] };
  if (typeof props?.field === "string") {
    const type = props.field === "reasoning" ? "reasoning" : props.field === "text" ? "text" : props.field;
    return { info: { role: "assistant", messageID }, parts: [{ type, text: typeof props.delta === "string" ? props.delta : undefined }] };
  }
  return undefined;
}
function openConfigObserveFallbackEvent(props, extractAutoRetrySignalFn) {
  const sessionID = resolveMessageEventSessionID(props);
  const info = props?.info;
  if (!sessionID) return false;
  if (info?.role === "user") {
    openConfigClearFallbackReplay(sessionID);
    openConfigFallbackUserTurns.set(sessionID, info?.id ?? info?.messageID ?? "current-turn");
    return false;
  }
  const partEvent = openConfigPartEventAsAssistant(props, sessionID);
  const effectiveInfo = info ?? partEvent?.info;
  const parts = props?.parts ?? (props?.part ? [props.part] : partEvent?.parts ?? info?.parts);
  return openConfigShouldBlockFallbackReplay(sessionID, effectiveInfo, parts, extractAutoRetrySignalFn);
}`, "v16 actual OpenCode part event shapes");
  return text;
}

function applyPentestEventGuardsV17(original) {
  if (original.includes("const openConfigPartDeltaBuffers = new Map;")) return original;
  let text = original;
  text = replaceOnce(text, `const openConfigVisibleAssistantOutputSessions = new Map;
const openConfigFallbackUserTurns = new Map;
function openConfigClearFallbackReplay(sessionID) {
  if (!sessionID) return;
  openConfigVisibleAssistantOutputSessions.delete(sessionID);
  openConfigFallbackUserTurns.delete(sessionID);
}
function openConfigClearAllFallbackReplays() {
  openConfigVisibleAssistantOutputSessions.clear();
  openConfigFallbackUserTurns.clear();
}`, `const openConfigVisibleAssistantOutputSessions = new Map;
const openConfigFallbackUserTurns = new Map;
const openConfigPartDeltaBuffers = new Map;
function openConfigPartDeltaBufferKey(sessionID, messageID, props) {
  const partIdentity = props?.partID ?? props?.part?.id ?? props?.part?.partID ?? props?.part?.type ?? props?.field ?? "part";
  return \`\${sessionID}\\u0000\${messageID}\\u0000\${partIdentity}\`;
}
function openConfigClearFallbackReplay(sessionID) {
  if (!sessionID) return;
  openConfigVisibleAssistantOutputSessions.delete(sessionID);
  openConfigFallbackUserTurns.delete(sessionID);
  const sessionPrefix = \`\${sessionID}\\u0000\`;
  for (const key of openConfigPartDeltaBuffers.keys()) {
    if (key.startsWith(sessionPrefix)) openConfigPartDeltaBuffers.delete(key);
  }
}
function openConfigClearAllFallbackReplays() {
  openConfigVisibleAssistantOutputSessions.clear();
  openConfigFallbackUserTurns.clear();
  openConfigPartDeltaBuffers.clear();
}`, "v17 delta buffer lifecycle cleanup");
  text = replaceOnce(text, `function openConfigPartEventAsAssistant(props, sessionID) {
  const messageID = props?.messageID ?? props?.part?.messageID;
  const currentUserMessageID = openConfigFallbackUserTurns.get(sessionID);
  if (!messageID || messageID === currentUserMessageID) return undefined;
  const part = props?.part;
  if (part) return { info: { role: "assistant", messageID }, parts: [part] };
  if (typeof props?.field === "string") {
    const type = props.field === "reasoning" ? "reasoning" : props.field === "text" ? "text" : props.field;
    return { info: { role: "assistant", messageID }, parts: [{ type, text: typeof props.delta === "string" ? props.delta : undefined }] };
  }
  return undefined;
}
function openConfigObserveFallbackEvent(props, extractAutoRetrySignalFn) {
  const sessionID = resolveMessageEventSessionID(props);
  const info = props?.info;
  if (!sessionID) return false;
  if (info?.role === "user") {
    openConfigClearFallbackReplay(sessionID);
    openConfigFallbackUserTurns.set(sessionID, info?.id ?? info?.messageID ?? "current-turn");
    return false;
  }
  const partEvent = openConfigPartEventAsAssistant(props, sessionID);
  const effectiveInfo = info ?? partEvent?.info;
  const parts = props?.parts ?? (props?.part ? [props.part] : partEvent?.parts ?? info?.parts);
  return openConfigShouldBlockFallbackReplay(sessionID, effectiveInfo, parts, extractAutoRetrySignalFn);
}`, `function openConfigIsRetrySignalTextPrefix(text) {
  const normalized = String(text ?? "").trimStart().replace(/\\s+/g, " ").toLowerCase();
  if (!normalized) return false;
  return [
    "[503] request queue is full",
    "request queue is full",
    "endpoint is unavailable; retrying",
    "endpoint is unavailable; try again",
    "endpoint is unavailable",
    "service unavailable; retrying",
    "service unavailable; try again",
    "service unavailable",
    "retrying request",
    "retrying"
  ].some((signal) => signal.startsWith(normalized));
}
function openConfigPartEventAsAssistant(props, sessionID, extractAutoRetrySignalFn) {
  const messageID = props?.messageID ?? props?.part?.messageID;
  const currentUserMessageID = openConfigFallbackUserTurns.get(sessionID);
  if (!messageID || messageID === currentUserMessageID) return undefined;
  const part = props?.part;
  if (part) {
    openConfigPartDeltaBuffers.delete(openConfigPartDeltaBufferKey(sessionID, messageID, props));
    return { info: { role: "assistant", messageID }, parts: [part] };
  }
  if (typeof props?.field === "string") {
    const type = props.field === "reasoning" ? "reasoning" : props.field === "text" ? "text" : props.field;
    const delta = typeof props.delta === "string" ? props.delta : "";
    const key = openConfigPartDeltaBufferKey(sessionID, messageID, props);
    const text = \`\${openConfigPartDeltaBuffers.get(key) ?? ""}\${delta}\`;
    openConfigPartDeltaBuffers.set(key, text);
    const provisionalRetryText = type === "text" && !openConfigIsPureRetrySignalText(text, extractAutoRetrySignalFn) && openConfigIsRetrySignalTextPrefix(text);
    return { info: { role: "assistant", messageID }, parts: [{ type, text }], provisionalRetryText };
  }
  return undefined;
}
function openConfigObserveFallbackEvent(props, extractAutoRetrySignalFn) {
  const sessionID = resolveMessageEventSessionID(props);
  const info = props?.info;
  if (!sessionID) return false;
  if (info?.role === "user") {
    openConfigClearFallbackReplay(sessionID);
    openConfigFallbackUserTurns.set(sessionID, info?.id ?? info?.messageID ?? "current-turn");
    return false;
  }
  const partEvent = openConfigPartEventAsAssistant(props, sessionID, extractAutoRetrySignalFn);
  if (partEvent?.provisionalRetryText) return openConfigVisibleAssistantOutputSessions.has(sessionID);
  const effectiveInfo = info ?? partEvent?.info;
  const parts = props?.parts ?? (props?.part ? [props.part] : partEvent?.parts ?? info?.parts);
  return openConfigShouldBlockFallbackReplay(sessionID, effectiveInfo, parts, extractAutoRetrySignalFn);
}`, "v17 buffer partial retry-only text deltas");
  return text;
}

function applyPentestEventGuardsV18(original) {
  if (original.includes("const partIdentity = props?.partID ??")) return original;
  return replaceOnce(original, `  const partIdentity = props?.part?.id ?? props?.part?.partID ?? props?.part?.type ?? props?.field ?? "part";`, `  const partIdentity = props?.partID ?? props?.part?.id ?? props?.part?.partID ?? props?.part?.type ?? props?.field ?? "part";`, "v18 match delta partID to completed part.id");
}

// The initial pentest rollout deliberately retained OmO's normal-mode retry
// behavior.  That left normal routes able to replay after a nested fatal error
// or assistant output.  The same fail-closed safety kernel now protects every
// profile; only the pentest transition ceiling remains profile-specific.
function applyStrictFallbackSafetyAllProfilesV19(original) {
  if (original.includes("OpenConfig strict fallback safety kernel v19")) return original;
  let text = original;
  text = replaceOnce(text, `function openConfigCanRetryFallbackError(error, retryOnErrors) {
  if (!openConfigPentestFallbackActive()) return isRetryableError(error, retryOnErrors);`, `function openConfigCanRetryFallbackError(error, retryOnErrors) {
  // OpenConfig strict fallback safety kernel v19: fatal nested errors never replay in any profile.`, "v19 strict classifier scope");
  text = replaceOnce(text, `function openConfigAllowPrimaryRetry(error, retrySignal, retryOnErrors) {
  if (openConfigPentestFallbackActive()) return openConfigCanRetryFallbackError(error, retryOnErrors);
  const errorType = classifyErrorType(error);
  const statusCode = extractStatusCode(error, retryOnErrors);
  return Boolean(retrySignal) || (![
    "abort", "context_overflow", "missing_api_key", "invalid_api_key", "model_not_found", "quota_exceeded"
  ].includes(errorType ?? "") && (statusCode === undefined || statusCode >= 500 || statusCode === 408 || statusCode === 425 || statusCode === 429));
}`, `function openConfigAllowPrimaryRetry(error, retrySignal, retryOnErrors) {
  return openConfigCanRetryFallbackError(error, retryOnErrors);
}`, "v19 strict primary retry classifier");
  text = replaceOnce(text, `function openConfigCanRetrySessionStatus(retrySignal, retryMessage, retryOnErrors) {
  if (openConfigPentestFallbackActive()) return openConfigCanRetryFallbackError({ message: retryMessage, status: retryMessage }, retryOnErrors);
  if (retrySignal) return true;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(retryMessage.toLowerCase()));
}`, `function openConfigCanRetrySessionStatus(retrySignal, retryMessage, retryOnErrors) {
  return openConfigCanRetryFallbackError({ message: retryMessage, status: retryMessage }, retryOnErrors);
}`, "v19 strict status retry classifier");
  text = replaceOnce(text, `  if (openConfigPentestFallbackActive() && state3.pendingFallbackModel) {`, `  if (state3.pendingFallbackModel) {`, "v19 all-profile duplicate transition guard");
  text = replaceOnce(text, `  if (!openConfigPentestFallbackActive() && state3.attemptCount >= config3.max_fallback_attempts) {
    return { success: false, error: "Max fallback attempts reached", maxAttemptsReached: true };
  }
`, "", "v19 remove normal retry budget consumption");
  text = replaceOnce(text, `    if (!openConfigPentestFallbackActive()) state3.attemptCount++;
`, "", "v19 same-model retries do not consume transitions");
  text = replaceOnce(text, `      let retryParts = originalRetryMetadata.parts;
      let retryMessageID = originalRetryMetadata.messageID;
      if (!openConfigPentestFallbackActive()) {
        const fetchedParts = originalRetryMetadata.parts.length > 0 ? originalRetryMetadata.parts : retryPayload.retryParts;
        const usingFetchedUserParts = originalRetryMetadata.parts.length > 0;
        retryParts = fetchedParts.length > 0 ? fetchedParts : [createInternalAgentContinuationTextPart("continue")];
        retryMessageID = usingFetchedUserParts ? originalRetryMetadata.messageID : undefined;
      } else if (retryParts.length === 0 || !retryMessageID) {
        log2(\`[\${HOOK_NAME13}] Auto-retry blocked without one durable human user message/messageID (\${source})\`, { sessionID });
        return { accepted: false, status: "missing-user-message", reason: "No durable human user message/messageID" };
      }`, `      const retryParts = originalRetryMetadata.parts;
      const retryMessageID = originalRetryMetadata.messageID;
      if (retryParts.length === 0 || !retryMessageID) {
        log2(\`[\${HOOK_NAME13}] Auto-retry blocked without one durable human user message/messageID (\${source})\`, { sessionID });
        return { accepted: false, status: "missing-user-message", reason: "No durable human user message/messageID" };
      }`, "v19 durable user replay guard");
  text = replaceOnce(text, `    if (state3.pendingFallbackModel) {
      if (openConfigPentestFallbackActive()) {
        log2(\`[\${HOOK_NAME13}] session.status retry skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
        return;
      }
      if (state3.pendingFallbackPromptMayHaveBeenAccepted) return;
      if (timeoutEnabled) {
        state3.pendingFallbackModel = undefined;
        state3.pendingFallbackPromptMayHaveBeenAccepted = false;
      } else return;
    }`, `    if (state3.pendingFallbackModel) {
      log2(\`[\${HOOK_NAME13}] session.status retry skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
      return;
    }`, "v19 all-profile pending status guard");
  text = replaceOnce(text, `        if (state3.pendingFallbackModel) {
          if (openConfigPentestFallbackActive()) {
            log2(\`[\${HOOK_NAME13}] message.updated fallback skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
            return;
          }
          if (retrySignal && timeoutEnabled) {
            state3.pendingFallbackModel = undefined;
            state3.pendingFallbackPromptMayHaveBeenAccepted = false;
          } else {
            log2(\`[\${HOOK_NAME13}] message.updated fallback skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
            return;
          }
        }`, `        if (state3.pendingFallbackModel) {
          log2(\`[\${HOOK_NAME13}] message.updated fallback skipped (pending fallback in progress)\`, { sessionID, pendingFallbackModel: state3.pendingFallbackModel });
          return;
        }`, "v19 all-profile pending message guard");
  text = text.replaceAll("openConfigPentestFallbackActive() && await", "await");
  return text;
}

function applyStrictFallbackClassifierAndDedupV20(original) {
  if (original.includes("OpenConfig strict fallback classifier v20")) return original;
  let text = original;
  text = replaceOnce(text, `function openConfigPentestStatusCodes(error) {
  const statuses = new Set;
  const seen = new Set;
  const visit = (value) => {
    if (value === null || value === undefined || seen.has(value)) return;
    if (typeof value === "number" && Number.isFinite(value)) { statuses.add(Math.trunc(value)); return; }
    if (typeof value === "string") {
      for (const match of value.matchAll(/(?:^|\\b)(?:HTTP\\s*)?(400|401|403|408|425|429|500|502|503|504)(?:\\b|$)/gi)) statuses.add(Number(match[1]));
      return;
    }
    if (typeof value !== "object") return;
    seen.add(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(error);
  return statuses;
}
function openConfigCanRetryFallbackError(error, retryOnErrors) {
  // OpenConfig strict fallback safety kernel v19: fatal nested errors never replay in any profile.
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  const errorType = String(classifyErrorType(error) ?? "").toLowerCase();
  const unsafeType = /model[ _-]?not[ _-]?found|missing[ _-]?api[ _-]?key|invalid[ _-]?api[ _-]?key|quota[ _-]?exceeded/i.test(\`\${errorType} \${serialized}\`);
  const statuses = openConfigPentestStatusCodes(error);
  if ([400, 401, 403].some((status) => statuses.has(status)) || unsafeType) return false;
  if (statuses.has(429) || statuses.has(503)) return true;
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, `function openConfigPentestStatusCodes(error) {
  const statuses = new Set;
  const seen = new Set;
  const statusKeys = new Set(["statusCode", "status", "httpStatus", "code"]);
  const addStatus = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      statuses.add(Math.trunc(value));
      return;
    }
    if (typeof value !== "string") return;
    for (const match of value.matchAll(/(?:^|\\b)(?:HTTP\\s*)?(\\d{3})(?:\\b|$)/gi)) statuses.add(Number(match[1]));
  };
  const visit = (value) => {
    if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (statusKeys.has(key)) addStatus(child);
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(error);
  return statuses;
}
function openConfigCanRetryFallbackError(error, retryOnErrors) {
  // OpenConfig strict fallback classifier v20: fatal/config errors and unsafe 4xx win over nested transient signals.
  let serialized = "";
  try { serialized = typeof error === "string" ? error : JSON.stringify(error); } catch {}
  const errorType = String(classifyErrorType(error) ?? "").toLowerCase();
  const fatalType = new Set(["abort", "context_overflow", "missing_api_key", "invalid_api_key", "model_not_found", "quota_exceeded"]);
  const fatalSignal = /(?:^|[^a-z])(?:abort(?:ed|ing)?|cancel(?:led|ed)?|context[ _-]?overflow|missing[ _-]?api[ _-]?key|invalid[ _-]?api[ _-]?key|model[ _-]?not[ _-]?found|quota[ _-]?exceeded|insufficient[ _-]?(?:quota|funds?|balance)|payment[ _-]?required)(?:$|[^a-z])/i;
  const statuses = openConfigPentestStatusCodes(error);
  const terminalClientStatus = [...statuses].some((status) => status >= 400 && status < 500 && ![408, 425, 429].includes(status));
  if (fatalType.has(errorType) || fatalSignal.test(\`\${errorType} \${serialized}\`) || terminalClientStatus) return false;
  if (statuses.has(408) || statuses.has(425) || statuses.has(429) || statuses.has(503)) return true;
  if (/\\[503\\]\\s*request queue is full|endpoint is unavailable/i.test(serialized)) return true;
  return isRetryableError(error, retryOnErrors);
}`, "v20 strict status-key classifier");
  text = replaceOnce(text, `      if (retrySignal && timeoutEnabled && (sessionRetryInFlight.has(sessionID) || wasAwaitingFallbackResult)) {
        if (openConfigPentestFallbackActive()) {
          log2(\`[\${HOOK_NAME13}] message.updated duplicate retry signal skipped\`, { sessionID, model });
          return;
        }
        await helpers.abortSessionRequest(sessionID, "message.updated.retry-signal");
        sessionRetryInFlight.delete(sessionID);
      }`, `      if (retrySignal && timeoutEnabled && (sessionRetryInFlight.has(sessionID) || wasAwaitingFallbackResult)) {
        log2(\`[\${HOOK_NAME13}] message.updated duplicate retry signal skipped\`, { sessionID, model });
        return;
      }`, "v20 all-profile in-flight duplicate guard");
  return text;
}

function applyExplicitTextStatusSafetyV21(original) {
  if (original.includes("OpenConfig explicit text status safety v21")) return original;
  let text = replaceOnce(original, `function openConfigPentestStatusCodes(error) {
  const statuses = new Set;
  const seen = new Set;
  const statusKeys = new Set(["statusCode", "status", "httpStatus", "code"]);
  const addStatus = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      statuses.add(Math.trunc(value));
      return;
    }
    if (typeof value !== "string") return;
    for (const match of value.matchAll(/(?:^|\\b)(?:HTTP\\s*)?(\\d{3})(?:\\b|$)/gi)) statuses.add(Number(match[1]));
  };
  const visit = (value) => {
    if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (statusKeys.has(key)) addStatus(child);
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(error);
  return statuses;
}`, `function openConfigPentestStatusCodes(error) {
  // OpenConfig explicit text status safety v21: only status-shaped tokens count, never arbitrary numbers.
  const statuses = new Set;
  const seen = new Set;
  const statusKeys = new Set(["statusCode", "status", "httpStatus", "code"]);
  const messageKeys = new Set(["message", "errorMessage", "error_message"]);
  const addStatus = (value, explicitStatusField = false) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      statuses.add(Math.trunc(value));
      return;
    }
    if (typeof value !== "string") return;
    if (explicitStatusField && /^\\s*[1-5]\\d{2}\\s*$/.test(value)) {
      statuses.add(Number(value.trim()));
      return;
    }
    for (const match of value.matchAll(/(?:^|\\b)(?:HTTP\\s+|status(?:\\s*code)?\\s*[:=]\\s*|\\[\\s*)([1-5]\\d{2})(?=\\b|\\s*\\])/gi)) statuses.add(Number(match[1]));
  };
  const visit = (value, rawRoot = false) => {
    if (typeof value === "string") {
      if (rawRoot) addStatus(value);
      return;
    }
    if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (statusKeys.has(key)) addStatus(child, true);
      else if (messageKeys.has(key) && typeof child === "string") addStatus(child);
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(error, true);
  return statuses;
}`, "v21 explicit root/message status tokens");
  text = replaceOnce(text, `  if (statuses.has(408) || statuses.has(425) || statuses.has(429) || statuses.has(503)) return true;`, `  if ([...statuses].some((status) => [408, 425, 429].includes(status) || retryOnErrors.includes(status))) return true;`, "v21 configured transient status retry");
  return text;
}

function applyNestedTextStatusSafetyV22(original) {
  if (original.includes("OpenConfig nested text status safety v22")) return original;
  return replaceOnce(original, `function openConfigPentestStatusCodes(error) {
  // OpenConfig explicit text status safety v21: only status-shaped tokens count, never arbitrary numbers.
  const statuses = new Set;
  const seen = new Set;
  const statusKeys = new Set(["statusCode", "status", "httpStatus", "code"]);
  const messageKeys = new Set(["message", "errorMessage", "error_message"]);
  const addStatus = (value, explicitStatusField = false) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      statuses.add(Math.trunc(value));
      return;
    }
    if (typeof value !== "string") return;
    if (explicitStatusField && /^\\s*[1-5]\\d{2}\\s*$/.test(value)) {
      statuses.add(Number(value.trim()));
      return;
    }
    for (const match of value.matchAll(/(?:^|\\b)(?:HTTP\\s+|status(?:\\s*code)?\\s*[:=]\\s*|\\[\\s*)([1-5]\\d{2})(?=\\b|\\s*\\])/gi)) statuses.add(Number(match[1]));
  };
  const visit = (value, rawRoot = false) => {
    if (typeof value === "string") {
      if (rawRoot) addStatus(value);
      return;
    }
    if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (statusKeys.has(key)) addStatus(child, true);
      else if (messageKeys.has(key) && typeof child === "string") addStatus(child);
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(error, true);
  return statuses;
}`, `function openConfigPentestStatusCodes(error) {
  // OpenConfig nested text status safety v22: only explicit HTTP/status/[NNN] tokens count, at every depth.
  const statuses = new Set;
  const seen = new Set;
  const statusKeys = new Set(["statusCode", "status", "httpStatus", "code"]);
  const addStatus = (value, explicitStatusField = false) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      statuses.add(Math.trunc(value));
      return;
    }
    if (typeof value !== "string") return;
    if (explicitStatusField && /^\\s*[1-5]\\d{2}\\s*$/.test(value)) {
      statuses.add(Number(value.trim()));
      return;
    }
    for (const match of value.matchAll(/(?:\\bHTTP\\s+|\\bstatus(?:\\s*code)?\\s*[:=]\\s*|\\[\\s*)([1-5]\\d{2})(?=\\b|\\s*\\])/gi)) statuses.add(Number(match[1]));
  };
  const visit = (value) => {
    if (typeof value === "string") {
      addStatus(value);
      return;
    }
    if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (statusKeys.has(key)) addStatus(child, true);
      visit(child);
    }
  };
  visit(error);
  return statuses;
}`, "v22 nested explicit status tokens");
}

function applyErrorEnvelopeStatusSafetyV23(original) {
  if (original.includes("OpenConfig Error envelope status safety v23")) return original;
  return replaceOnce(original, `function openConfigPentestStatusCodes(error) {
  // OpenConfig nested text status safety v22: only explicit HTTP/status/[NNN] tokens count, at every depth.
  const statuses = new Set;
  const seen = new Set;
  const statusKeys = new Set(["statusCode", "status", "httpStatus", "code"]);
  const addStatus = (value, explicitStatusField = false) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      statuses.add(Math.trunc(value));
      return;
    }
    if (typeof value !== "string") return;
    if (explicitStatusField && /^\\s*[1-5]\\d{2}\\s*$/.test(value)) {
      statuses.add(Number(value.trim()));
      return;
    }
    for (const match of value.matchAll(/(?:\\bHTTP\\s+|\\bstatus(?:\\s*code)?\\s*[:=]\\s*|\\[\\s*)([1-5]\\d{2})(?=\\b|\\s*\\])/gi)) statuses.add(Number(match[1]));
  };
  const visit = (value) => {
    if (typeof value === "string") {
      addStatus(value);
      return;
    }
    if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (statusKeys.has(key)) addStatus(child, true);
      visit(child);
    }
  };
  visit(error);
  return statuses;
}`, `function openConfigPentestStatusCodes(error) {
  // OpenConfig Error envelope status safety v23: scan non-enumerable Error.message/cause plus explicit tokens only.
  const statuses = new Set;
  const seen = new Set;
  const statusKeys = new Set(["statusCode", "status", "httpStatus", "code"]);
  const addStatus = (value, explicitStatusField = false) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      statuses.add(Math.trunc(value));
      return;
    }
    if (typeof value !== "string") return;
    if (explicitStatusField && /^\\s*[1-5]\\d{2}\\s*$/.test(value)) {
      statuses.add(Number(value.trim()));
      return;
    }
    for (const match of value.matchAll(/(?:\\bHTTP\\s+|\\bstatus(?:\\s*code)?\\s*[:=]\\s*|\\[\\s*)([1-5]\\d{2})(?=\\b|\\s*\\])/gi)) statuses.add(Number(match[1]));
  };
  const visit = (value) => {
    if (typeof value === "string") {
      addStatus(value);
      return;
    }
    if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    // Error.message and Error.cause are non-enumerable in standard JavaScript.
    if (typeof value.message === "string") addStatus(value.message);
    if (value.cause !== undefined) visit(value.cause);
    for (const [key, child] of Object.entries(value)) {
      if (statusKeys.has(key)) addStatus(child, true);
      visit(child);
    }
  };
  visit(error);
  return statuses;
}`, "v23 Error message/cause status tokens");
}

function removeLegacyNativeBuilderPatches(text) {
  const helper = `function openConfigPrimaryAgentOverride(definition) {
  const route = openConfigModelsRoute(definition);
  if (!route.primary) return definition;
  const primaryEntry = route.entries?.[0];
  const primarySettings = typeof primaryEntry === "object" && primaryEntry !== null ? { ...primaryEntry } : {};
  if (primarySettings.reasoning !== undefined && primarySettings.reasoningEffort === undefined) {
    primarySettings.reasoningEffort = primarySettings.reasoning;
  }
  return {
    ...definition,
    ...primarySettings,
    model: route.primary,
    fallback_models: route.fallbackModels ?? definition?.fallback_models
  };
}
`;
  if (text.includes(helper)) text = text.replace(helper, "");
  text = text.replace(`  const nativeSisyphusJuniorOverride = openConfigPrimaryAgentOverride(override);
  override = nativeSisyphusJuniorOverride;
`, "");
  text = text.replace(`    maxTokens: override?.maxTokens ?? 64000,`, `    maxTokens: 64000,`);
  text = text.replace(`    let override = agentOverrides[agentName] ?? Object.entries(agentOverrides).find(([key]) => key.toLowerCase() === agentName.toLowerCase())?.[1];
    const nativeBuiltinOverride = openConfigPrimaryAgentOverride(override);
    override = nativeBuiltinOverride;
    const requirement = AGENT_MODEL_REQUIREMENTS[agentName];`, `    const override = agentOverrides[agentName] ?? Object.entries(agentOverrides).find(([key]) => key.toLowerCase() === agentName.toLowerCase())?.[1];
    const requirement = AGENT_MODEL_REQUIREMENTS[agentName];`);
  return text;
}

function applyCentralAgentOverrideModels(text) {
  const schemaAnchor = `// packages/omo-opencode/src/config/schema/agent-overrides.ts
var AgentOverrideConfigSchema = z14.object({`;
  if (!text.includes("function openConfigMaterializeAgentOverride(override)")) {
    text = replaceOnce(text, schemaAnchor, `// packages/omo-opencode/src/config/schema/agent-overrides.ts
function openConfigMaterializeAgentOverride(override) {
  if (!Array.isArray(override.models) || override.models.length === 0) return override;
  const [primary, ...fallbackModels] = override.models;
  const primarySettings = typeof primary === "object" && primary !== null ? primary : {};
  const model = typeof primary === "string" ? primary : primary?.model;
  if (typeof model !== "string" || model.length === 0) return override;
  return { ...override, ...primarySettings, model, fallback_models: fallbackModels };
}
function openConfigMaterializeAgentOverrides(overrides) {
  return Object.fromEntries(Object.entries(overrides).map(([name, override]) => [name, override === undefined ? override : openConfigMaterializeAgentOverride(override)]));
}
var AgentOverrideConfigSchema = z14.object({
`, "AgentOverrideConfigSchema central models helper");
  }
  if (!text.includes(`  models: z14.array(z14.union([z14.string(), FallbackModelObjectSchema])).optional(),`)) {
    text = replaceOnce(text, `  model: z14.string().optional(),
  fallback_models: FallbackModelsSchema.optional(),`, `  model: z14.string().optional(),
  models: z14.array(z14.union([z14.string(), FallbackModelObjectSchema])).optional(),
  fallback_models: FallbackModelsSchema.optional(),`, "AgentOverrideConfigSchema central models input");
  }
  if (!text.includes(`}).catchall(AgentOverrideConfigSchema.optional()).transform(openConfigMaterializeAgentOverrides);`)) {
    text = replaceOnce(text, `  atlas: AgentOverrideConfigSchema.optional()
}).catchall(AgentOverrideConfigSchema.optional());`, `  atlas: AgentOverrideConfigSchema.optional()
}).catchall(AgentOverrideConfigSchema.optional()).transform(openConfigMaterializeAgentOverrides);`, "AgentOverridesSchema central models transform");
  }
  if (!text.includes(`"description", "prompt", "model", "models", "variant", "reasoningEffort"`)) {
    text = replaceOnce(text, `    const fields = recordFields(definition, ["description", "prompt", "model", "variant", "reasoningEffort", "tools", "temperature", "disable"]);`, `    const fields = recordFields(definition, ["description", "prompt", "model", "models", "variant", "reasoningEffort", "tools", "temperature", "disable"]);`, "native agent registration models");
  }
  return text;
}

function applyDirectTaskAgentModels(text) {
  if (!text.includes("async function resolveSubagentModel(agentToUse, matchedAgent, executorCtx)")) return text;
  const routeHelper = `function openConfigModelsRoute(definition) {
  const entries = normalizeFallbackModels(definition?.models);
  if (!entries || entries.length === 0) {
    return {
      entries: normalizeFallbackModels([definition?.model, ...(definition?.fallback_models ?? [])]),
      primary: definition?.model,
      fallbackModels: definition?.fallback_models
    };
  }
  const [primaryEntry, ...fallbackEntries] = entries;
  return {
    entries,
    primary: typeof primaryEntry === "string" ? primaryEntry : primaryEntry?.model,
    fallbackModels: fallbackEntries.length > 0 ? fallbackEntries : definition?.fallback_models
  };
}
function openConfigEntryForResolvedModel(entries, resolvedModel) {
  if (!entries || !resolvedModel) return undefined;
  const model = typeof resolvedModel === "string" ? resolvedModel : \`\${resolvedModel.providerID}/\${resolvedModel.modelID}\`;
  return entries.find((entry) => (typeof entry === "string" ? entry : entry?.model) === model);
}
`;
  const legacyRouteHelper = `function openConfigModelsRoute(definition) {
  const entries = normalizeFallbackModels(definition?.models);
  if (!entries || entries.length === 0) return { primary: definition?.model, primaryEntry: undefined, fallbackModels: definition?.fallback_models };
  const [primaryEntry, ...fallbackEntries] = entries;
  return {
    primary: typeof primaryEntry === "string" ? primaryEntry : primaryEntry?.model,
    primaryEntry: typeof primaryEntry === "object" && primaryEntry !== null ? primaryEntry : undefined,
    fallbackModels: fallbackEntries.length > 0 ? fallbackEntries : definition?.fallback_models
  };
}
`;
  if (text.includes(legacyRouteHelper)) {
    text = text.replace(legacyRouteHelper, routeHelper);
  } else if (!text.includes("function openConfigModelsRoute(definition)")) {
    text = replaceOnce(text, "function findAgentOverride2(agentOverrides, agentConfigKey) {", `${routeHelper}function findAgentOverride2(agentOverrides, agentConfigKey) {`, "direct task canonical model route helper");
  }
  if (!text.includes("const agentModelRoute = openConfigModelsRoute(agentOverride);\n  const agentModel = agentModelRoute.primary")) {
    text = replaceOnce(text, `  const agentRequirement = AGENT_MODEL_REQUIREMENTS[agentConfigKey];
  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined;
  const agentCategoryModel = agentCategoryConfig?.model;
  const hasExplicitUserModel = Boolean(agentOverride?.model ?? agentCategoryModel);
  const normalizedAgentFallbackModels = normalizeFallbackModels(agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models);`, `  const agentRequirement = AGENT_MODEL_REQUIREMENTS[agentConfigKey];
  const agentModelRoute = openConfigModelsRoute(agentOverride);
  const agentModel = agentModelRoute.primary ?? agentOverride?.model;
  const canonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;
  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined;
  const agentCategoryModel = agentCategoryConfig?.model;
  const hasExplicitUserModel = Boolean(agentModel ?? agentCategoryModel);
  const normalizedAgentFallbackModels = normalizeFallbackModels(agentModelRoute.fallbackModels ?? agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models);`, "resolveSubagentModel canonical route");
    text = replaceOnce(text, `  if (agentOverride?.model || agentCategoryModel || agentRequirement || matchedAgent.model) {
    const resolution2 = resolveModelForDelegateTask2({
      userModel: agentOverride?.model ?? agentCategoryModel,`, `  if (agentModel || agentCategoryModel || agentRequirement || matchedAgent.model) {
    const resolution2 = resolveModelForDelegateTask2({
      userModel: agentModel ?? agentCategoryModel,`, "resolveSubagentModel canonical primary");
    text = replaceOnce(text, `    } else if (resolutionSkipped && (agentOverride?.model ?? agentCategoryModel)) {
      const explicitModel = agentOverride?.model ?? agentCategoryModel;`, `    } else if (resolutionSkipped && (agentModel ?? agentCategoryModel)) {
      const explicitModel = agentModel ?? agentCategoryModel;`, "resolveSubagentModel canonical cold cache");
    text = replaceOnce(text, `          model: agentOverride?.model ?? agentCategoryModel`, `          model: agentModel ?? agentCategoryModel`, "resolveSubagentModel canonical cold cache log");
  }
  if (!text.includes("const canonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;")) {
    text = replaceOnce(text, `  const agentModel = agentModelRoute.primary ?? agentOverride?.model;
  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined;`, `  const agentModel = agentModelRoute.primary ?? agentOverride?.model;
  const canonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;
  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined;`, "resolveSubagentModel canonical variant boundary");
  }
  text = text.replace(`const variantToUse = agentOverride?.variant ?? resolution2.variant ?? agentCategoryConfig?.variant;`, `const variantToUse = canonicalVariantOverride ?? resolution2.variant ?? agentCategoryConfig?.variant;`);
  text = text.replace(`const variantToUse = agentOverride?.variant ?? agentCategoryConfig?.variant;`, `const variantToUse = canonicalVariantOverride ?? agentCategoryConfig?.variant;`);
  const legacyPrimaryApplication = `    if (categoryModel && agentModelRoute.primaryEntry) {
      categoryModel = applyFallbackEntrySettings({
        categoryModel,
        effectiveEntry: agentModelRoute.primaryEntry,
        variantOverride: agentOverride?.variant
      });
    }
    if (categoryModel && effectiveEntry) {
      categoryModel = applyFallbackEntrySettings({
        categoryModel,
        effectiveEntry,
        variantOverride: agentOverride?.variant
      });
    }`;
  const canonicalEntryApplication = `    const selectedAgentModelEntry = effectiveEntry ?? openConfigEntryForResolvedModel(agentModelRoute.entries, categoryModel);
    if (categoryModel && selectedAgentModelEntry) {
      categoryModel = applyFallbackEntrySettings({
        categoryModel,
        effectiveEntry: selectedAgentModelEntry,
        variantOverride: canonicalVariantOverride
      });
    }`;
  if (text.includes(legacyPrimaryApplication)) {
    text = text.replace(legacyPrimaryApplication, canonicalEntryApplication);
  } else if (!text.includes("const selectedAgentModelEntry = effectiveEntry ?? openConfigEntryForResolvedModel(agentModelRoute.entries, categoryModel);")) {
    text = replaceOnce(text, `    if (categoryModel && effectiveEntry) {
      categoryModel = applyFallbackEntrySettings({
        categoryModel,
        effectiveEntry,
        variantOverride: agentOverride?.variant
      });
    }`, canonicalEntryApplication, "resolveSubagentModel canonical entry settings");
  }
  text = text.replace(`        variantOverride: agentOverride?.variant
      });
    }
  }
  if (!categoryModel && normalizedMatchedModel)`, `        variantOverride: canonicalVariantOverride
      });
    }
  }
  if (!categoryModel && normalizedMatchedModel)`);
  if (!text.includes("const callOmoAgentModelRoute = openConfigModelsRoute(agentOverride);")) {
    text = replaceOnce(text, `  const agentOverride = agentOverrides?.[agentConfigKey] ?? (agentOverrides ? Object.entries(agentOverrides).find(([key]) => key.toLowerCase() === agentConfigKey)?.[1] : undefined);
  const agentCategoryModel = agentOverride?.category ? userCategories?.[agentOverride.category]?.model : undefined;`, `  const agentOverride = agentOverrides?.[agentConfigKey] ?? (agentOverrides ? Object.entries(agentOverrides).find(([key]) => key.toLowerCase() === agentConfigKey)?.[1] : undefined);
  const callOmoAgentModelRoute = openConfigModelsRoute(agentOverride);
  const callOmoAgentModel = callOmoAgentModelRoute.primary ?? agentOverride?.model;
  const callOmoCanonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;
  const agentCategoryModel = agentOverride?.category ? userCategories?.[agentOverride.category]?.model : undefined;`, "call_omo_agent canonical route");
    text = replaceOnce(text, `  if (agentOverride?.model) {
    const normalized = parseModelString(agentOverride.model);`, `  if (callOmoAgentModel) {
    const normalized = parseModelString(callOmoAgentModel);`, "call_omo_agent canonical primary");
    text = replaceOnce(text, `        model: agentOverride.model,`, `        model: callOmoAgentModel,`, "call_omo_agent canonical primary log");
    text = replaceOnce(text, `  const normalizedFallbackModels = normalizeFallbackModels(agentOverride?.fallback_models ?? (agentOverride?.category ? userCategories?.[agentOverride.category]?.fallback_models : undefined));`, `  const primaryCallOmoAgentEntry = openConfigEntryForResolvedModel(callOmoAgentModelRoute.entries, model);
  if (model && primaryCallOmoAgentEntry) {
    model = applyFallbackEntrySettings({
      categoryModel: model,
      effectiveEntry: primaryCallOmoAgentEntry,
      variantOverride: callOmoCanonicalVariantOverride
    });
  }
  const normalizedFallbackModels = normalizeFallbackModels(callOmoAgentModelRoute.fallbackModels ?? agentOverride?.fallback_models ?? (agentOverride?.category ? userCategories?.[agentOverride.category]?.fallback_models : undefined));`, "call_omo_agent canonical entry settings");
  }
  if (!text.includes("const callOmoCanonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;")) {
    text = replaceOnce(text, `  const callOmoAgentModel = callOmoAgentModelRoute.primary ?? agentOverride?.model;
  const agentCategoryModel = agentOverride?.category ? userCategories?.[agentOverride.category]?.model : undefined;`, `  const callOmoAgentModel = callOmoAgentModelRoute.primary ?? agentOverride?.model;
  const callOmoCanonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;
  const agentCategoryModel = agentOverride?.category ? userCategories?.[agentOverride.category]?.model : undefined;`, "call_omo_agent canonical variant boundary");
  }
  text = text.replace(`model = agentOverride.variant ? { ...normalized, variant: agentOverride.variant } : normalized;`, `model = callOmoCanonicalVariantOverride ? { ...normalized, variant: callOmoCanonicalVariantOverride } : normalized;`);
  text = text.replace(`variant: agentOverride.variant`, `variant: callOmoCanonicalVariantOverride`);
  text = text.replace(`variantOverride: agentOverride?.variant
    });
  }
  const normalizedFallbackModels = normalizeFallbackModels(callOmoAgentModelRoute.fallbackModels`, `variantOverride: callOmoCanonicalVariantOverride
    });
  }
  const normalizedFallbackModels = normalizeFallbackModels(callOmoAgentModelRoute.fallbackModels`);
  return text;
}

function applyCategoryPreflightCanonicalPrimary(text) {
  if (!text.includes("function resolveCategoryExecution(args, executorCtx, inheritedModel, systemDefaultModel)")) return text;
  if (text.includes("const openConfigCanonicalCategoryPrimary = hasCanonicalModels ? configuredPrimaryModel : undefined;")) return text;
  text = replaceOnce(text, `  const overrideModel = sisyphusJuniorModel;
  const explicitCategoryModel = hasCanonicalModels ? configuredPrimaryModel : userCategories?.[args.category]?.model;
  if (!requirement) {`, `  const overrideModel = sisyphusJuniorModel;
  const explicitCategoryModel = hasCanonicalModels ? configuredPrimaryModel : userCategories?.[args.category]?.model;
  // A canonical category primary is an explicit dispatch choice. Provider-model
  // cache freshness must not promote a configured fallback before the primary
  // has made one runtime attempt (which retains the configured ZDR alias).
  const openConfigCanonicalCategoryPrimary = hasCanonicalModels ? configuredPrimaryModel : undefined;
  const openConfigCanonicalCategoryPrimaryParsed = openConfigCanonicalCategoryPrimary ? parseModelString(openConfigCanonicalCategoryPrimary) : undefined;
  if (!requirement) {`, "category canonical primary preflight setup");
  text = replaceOnce(text, `  } else {
    const resolution2 = resolveModelForDelegateTask2({`, `  } else if (openConfigCanonicalCategoryPrimaryParsed) {
    actualModel = openConfigCanonicalCategoryPrimary;
    isModelResolutionSkipped = true;
    const variantToUse = userCategories?.[args.category]?.variant ?? resolved.config.variant;
    categoryModel = applyCategoryParams({ ...openConfigCanonicalCategoryPrimaryParsed, variant: variantToUse ?? openConfigCanonicalCategoryPrimaryParsed.variant }, resolved.config);
    modelInfo = { model: actualModel, type: "user-defined", source: "override" };
    log2("[delegate-task] Canonical category primary preserved before provider-model cache preflight", {
      category: args.category,
      model: actualModel
    });
  } else {
    const resolution2 = resolveModelForDelegateTask2({`, "category canonical primary preflight");
  return text;
}

export function applyCanonicalAgentModels(original) {
  return applyCategoryPreflightCanonicalPrimary(applyDirectTaskAgentModels(applyCentralAgentOverrideModels(removeLegacyNativeBuilderPatches(original))));
}

function applyPerModelRetryAndDispatchBoundsV25(original) {
  if (original.includes("OpenConfig per-model retry and dispatch bounds v25")) return original;
  let text = original;
  text = replaceOnce(text, `function configuredPrimaryRetryLimit(config3) {
  if (Number.isFinite(Number(config3.same_model_retries_before_fallback)))
    return Math.max(0, Math.trunc(Number(config3.same_model_retries_before_fallback)));
  return openConfigRuntimeFallbackInteger("OPENCONFIG_OMO_SAME_MODEL_RETRIES_BEFORE_FALLBACK", 0);
}`, `function openConfigProfileName() {
  const profile = typeof process !== "undefined" ? process.env?.OPENCONFIG_RUNTIME_PROFILE : undefined;
  return profile === "pentest" ? "pentest" : profile === "normal-private" ? "normal-private" : "normal";
}

function configuredPrimaryRetryLimit(config3, state3) {
  // OPENCONFIG_OMO_SAME_MODEL_RETRIES_BEFORE_FALLBACK is intentionally not
  // consulted here: a current-model/rung policy is less ambiguous than env.
  const model = String(state3?.currentModel ?? "").toLowerCase();
  // Exact governed matrix. The decision is made from the current rung, not a
  // profile-wide environment default; Pro/Hermes/Kimi/Gemini Pro are zero.
  if (openConfigProfileName() === "pentest") return /deepseek-v4-flash-0731-zdr-throughput/.test(model) ? 3 : 0;
  if (/deepseek-v4-flash-0731(?:$|:|\\b)/.test(model)) return 2;
  if (/(?:z-ai\\/glm-5\\.3|gemini-3\\.7-flash|minimax\\/minimax-m3|subscription-gateway\\/)/.test(model)) return 1;
  return 0;
}
function openConfigMaxRecoveryDispatches() {
  // Initial prompt is outside this hook. Four recoveries prove max five
  // application dispatches for the one durable user turn.
  return 4;
}`, "v25 per-model matrix");
  text = replaceOnce(text, `function shouldRetryPrimaryBeforeFallback(state3, config3, options = {}) {
  const maxPrimaryRetries = configuredPrimaryRetryLimit(config3);
  if (!Number.isFinite(maxPrimaryRetries) || maxPrimaryRetries <= 0)
    return false;
  if (options.allowPrimaryRetry === false)
    return false;
  if (state3.currentModel !== state3.originalModel)
    return false;
  return (state3.primaryRetryCount ?? 0) < maxPrimaryRetries;
}`, `function shouldRetryPrimaryBeforeFallback(state3, config3, options = {}) {
  const maxPrimaryRetries = configuredPrimaryRetryLimit(config3, state3);
  if (!Number.isFinite(maxPrimaryRetries) || maxPrimaryRetries <= 0 || options.allowPrimaryRetry === false) return false;
  const used = state3.rungRetryModel === state3.currentModel ? state3.rungRetryCount ?? 0 : 0;
  return used < maxPrimaryRetries;
}`, "v25 rung retry counter");
  text = replaceOnce(text, `  return typeof process !== "undefined" && process.env?.OPENCONFIG_RUNTIME_PROFILE === "pentest" ? Math.min(limit, 1) : limit;`, `  return openConfigProfileName() === "pentest" ? Math.min(limit, 1) : Math.min(limit, 2);`, "v25 transition cap");
  text = replaceOnce(text, `  const failedModel = state3.currentModel;
  const now = Date.now();
  if (shouldRetryPrimaryBeforeFallback(state3, config3, options)) {`, `  const failedModel = state3.currentModel;
  const now = Date.now();
  if ((state3.recoveryDispatchCount ?? 0) >= openConfigMaxRecoveryDispatches()) {
    return { success: false, error: "Max application dispatches reached", maxDispatchesReached: true };
  }
  if (shouldRetryPrimaryBeforeFallback(state3, config3, options)) {`, "v25 dispatch bound");
  text = replaceOnce(text, `    state3.failedModels.set(failedModel, now);
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;
    state3.currentModel = state3.originalModel;
    state3.pendingFallbackModel = state3.originalModel;`, `    state3.failedModels.set(failedModel, now);
    state3.primaryRetryCount = (state3.primaryRetryCount ?? 0) + 1;
    state3.rungRetryModel = failedModel;
    state3.rungRetryCount = (state3.rungRetryCount ?? 0) + 1;
    state3.recoveryDispatchCount = (state3.recoveryDispatchCount ?? 0) + 1;
    state3.currentModel = failedModel;
    state3.pendingFallbackModel = failedModel;`, "v25 retry accounting");
  text = replaceOnce(text, `  state3.attemptCount++;
  state3.currentModel = nextModel;
  state3.pendingFallbackModel = nextModel;`, `  state3.attemptCount++;
  state3.currentModel = nextModel;
  state3.rungRetryModel = nextModel;
  state3.rungRetryCount = 0;
  state3.recoveryDispatchCount = (state3.recoveryDispatchCount ?? 0) + 1;
  state3.pendingFallbackModel = nextModel;`, "v25 transition accounting");
  text = replaceOnce(text, `    primaryRetryCount: state3.primaryRetryCount ?? 0,
    pendingFallbackModel: state3.pendingFallbackModel,`, `    primaryRetryCount: state3.primaryRetryCount ?? 0,
    rungRetryModel: state3.rungRetryModel,
    rungRetryCount: state3.rungRetryCount ?? 0,
    recoveryDispatchCount: state3.recoveryDispatchCount ?? 0,
    pendingFallbackModel: state3.pendingFallbackModel,`, "v25 snapshot counters");
  text = replaceOnce(text, `  state3.primaryRetryCount = snapshot.primaryRetryCount ?? 0;
  state3.pendingFallbackModel = snapshot.pendingFallbackModel;`, `  state3.primaryRetryCount = snapshot.primaryRetryCount ?? 0;
  state3.rungRetryModel = snapshot.rungRetryModel;
  state3.rungRetryCount = snapshot.rungRetryCount ?? 0;
  state3.recoveryDispatchCount = snapshot.recoveryDispatchCount ?? 0;
  state3.pendingFallbackModel = snapshot.pendingFallbackModel;`, "v25 restore counters");
  text = replaceOnce(text, `      openConfigObserveFallbackEvent(props, extractAutoRetrySignal);
      await messageUpdateHandler(props);`, `      if (props?.info?.role === "user") deps.sessionStates.delete(resolveMessageEventSessionID(props));
      openConfigObserveFallbackEvent(props, extractAutoRetrySignal);
      await messageUpdateHandler(props);`, "v25 durable-turn reset");
  return `${text}\n/* OpenConfig per-model retry and dispatch bounds v25 */\n`;
}

// A message.updated replay for the same durable user message must not erase
// the recovery counter: retries, duplicate events, and state restoration all
// share that state. Only a distinct durable user message starts a new turn.
function applyDurableUserTurnResetV26(original) {
  if (original.includes("OpenConfig durable user turn state reset v26")) return original;
  const legacy = `      if (props?.info?.role === "user") deps.sessionStates.delete(resolveMessageEventSessionID(props));
      openConfigObserveFallbackEvent(props, extractAutoRetrySignal);`;
  const replacement = `      const openConfigSessionID = resolveMessageEventSessionID(props);
      const openConfigUserTurnID = props?.info?.id ?? props?.info?.messageID;
      const openConfigPreviousUserTurnID = openConfigFallbackUserTurns.get(openConfigSessionID);
      if (props?.info?.role === "user" && openConfigUserTurnID && openConfigUserTurnID !== openConfigPreviousUserTurnID) {
        deps.sessionStates.delete(openConfigSessionID);
      }
      openConfigObserveFallbackEvent(props, extractAutoRetrySignal);`;
  if (original.includes(legacy)) return `${replaceOnce(original, legacy, replacement, "v26 distinct durable-turn reset")}\n/* OpenConfig durable user turn state reset v26 */\n`;
  if (original.includes(replacement)) return `${original}\n/* OpenConfig durable user turn state reset v26 */\n`;
  throw new Error("Patch anchor mismatch for v26 distinct durable-turn reset");
}

// The event guard and the state reset must agree on the exact same durable
// turn identity. Replaying user message A must preserve all latches; only B
// clears them and begins a new bounded session-turn.
function applyDurableUserTurnLatchV27(original) {
  if (original.includes("OpenConfig centralized durable user turn v27")) return original;
  const oldLatch = `function openConfigObserveFallbackEvent(props, extractAutoRetrySignalFn) {
  const sessionID = resolveMessageEventSessionID(props);
  const info = props?.info;
  if (!sessionID) return false;
  if (info?.role === "user") {
    openConfigClearFallbackReplay(sessionID);
    openConfigFallbackUserTurns.set(sessionID, info?.id ?? info?.messageID ?? "current-turn");
    return false;
  }
  const partEvent = openConfigPartEventAsAssistant(props, sessionID, extractAutoRetrySignalFn);
  if (partEvent?.provisionalRetryText) return openConfigVisibleAssistantOutputSessions.has(sessionID);
  const effectiveInfo = info ?? partEvent?.info;
  const parts = props?.parts ?? (props?.part ? [props.part] : partEvent?.parts ?? info?.parts);
  return openConfigShouldBlockFallbackReplay(sessionID, effectiveInfo, parts, extractAutoRetrySignalFn);
}`;
  const newLatch = `function openConfigDurableUserTurnID(info) {
  const value = info?.id ?? info?.messageID;
  return typeof value === "string" && value ? value : undefined;
}
function openConfigIsDistinctDurableUserTurn(sessionID, info) {
  const userTurnID = openConfigDurableUserTurnID(info);
  return Boolean(sessionID && userTurnID && userTurnID !== openConfigFallbackUserTurns.get(sessionID));
}
function openConfigObserveFallbackEvent(props, extractAutoRetrySignalFn) {
  const sessionID = resolveMessageEventSessionID(props);
  const info = props?.info;
  if (!sessionID) return false;
  if (info?.role === "user") {
    if (openConfigIsDistinctDurableUserTurn(sessionID, info)) openConfigClearFallbackReplay(sessionID);
    const userTurnID = openConfigDurableUserTurnID(info);
    if (userTurnID) openConfigFallbackUserTurns.set(sessionID, userTurnID);
    return false;
  }
  const partEvent = openConfigPartEventAsAssistant(props, sessionID, extractAutoRetrySignalFn);
  if (partEvent?.provisionalRetryText) return openConfigVisibleAssistantOutputSessions.has(sessionID);
  const effectiveInfo = info ?? partEvent?.info;
  const parts = props?.parts ?? (props?.part ? [props.part] : partEvent?.parts ?? info?.parts);
  return openConfigShouldBlockFallbackReplay(sessionID, effectiveInfo, parts, extractAutoRetrySignalFn);
}`;
  let text = original;
  if (text.includes(oldLatch)) text = replaceOnce(text, oldLatch, newLatch, "v27 centralized user-turn latch");
  else if (!text.includes(newLatch)) throw new Error("Patch anchor mismatch for v27 centralized user-turn latch");
  const oldReset = `      const openConfigSessionID = resolveMessageEventSessionID(props);
      const openConfigUserTurnID = props?.info?.id ?? props?.info?.messageID;
      const openConfigPreviousUserTurnID = openConfigFallbackUserTurns.get(openConfigSessionID);
      if (props?.info?.role === "user" && openConfigUserTurnID && openConfigUserTurnID !== openConfigPreviousUserTurnID) {
        deps.sessionStates.delete(openConfigSessionID);
      }
      openConfigObserveFallbackEvent(props, extractAutoRetrySignal);`;
  const newReset = `      const openConfigSessionID = resolveMessageEventSessionID(props);
      if (props?.info?.role === "user" && openConfigIsDistinctDurableUserTurn(openConfigSessionID, props.info)) {
        deps.sessionStates.delete(openConfigSessionID);
      }
      openConfigObserveFallbackEvent(props, extractAutoRetrySignal);`;
  if (text.includes(oldReset)) text = replaceOnce(text, oldReset, newReset, "v27 centralized user-turn reset");
  else if (!text.includes(newReset)) throw new Error("Patch anchor mismatch for v27 centralized user-turn reset");
  return `${text}\n/* OpenConfig centralized durable user turn v27 */\n`;
}

function applyExploreSecurityIntentRejection(original) {
  const helper = `function openConfigRejectRestrictedExploreTask(args) {
  if (typeof args?.subagent_type !== "string" || args.subagent_type.trim().toLowerCase() !== "explore" || typeof args?.prompt !== "string") return;
  const prompt = args.prompt.toLowerCase();
  const securityOrPentestIntent = /\\b(?:pentest|penetration\\s*test(?:ing)?|vulnerability\\s+(?:scan(?:ning)?|assessment|research|report)|find\\s+vulnerabilities|exploit(?:ation)?|recon(?:naissance)?|osint|forensic(?:s)?|security\\s+(?:audit|assessment|analysis|review|test(?:ing)?|research|scan(?:ning)?))\\b/.test(prompt);
  const sourceRecoveryIntent = /\\b(?:recover|retrieve|extract|restore|reconstruct|dump|clone|archive)\\s+(?:the\\s+)?(?:backend|server(?:[-\\s]side)?|source(?:\\s+code)?|application\\s+source)\\b|\\b(?:backend|server(?:[-\\s]side)?|source(?:\\s+code)?|application\\s+source)\\s+(?:recovery|retrieval|extraction|dump|archive|clone)\\b|\\bbackend\\s+source\\s+reconstruction\\b/.test(prompt);
  if (!securityOrPentestIntent && !sourceRecoveryIntent) return;
  throw new Error("Direct explore is limited to code-location tasks. Route security, pentest, or source-recovery work with category content-aware-fast or content-aware-deep.");
}
`;
  let text = original;
  const helperStart = text.indexOf("function openConfigRejectRestrictedExploreTask(args)");
  const createDelegateTaskStart = text.indexOf("function createDelegateTask(options) {", helperStart);
  if (helperStart >= 0) {
    if (createDelegateTaskStart < helperStart) throw new Error("Patch anchor mismatch for restricted explore helper boundary");
    text = text.slice(0, helperStart) + helper + text.slice(createDelegateTaskStart);
  } else {
    text = replaceOnce(text, "function createDelegateTask(options) {", `${helper}function createDelegateTask(options) {`, "restricted explore pre-dispatch helper");
  }
  const dispatchAnchor = `      const ctx = toolContext;
      const delegateTaskArgs = await prepareDelegateTaskArgs(args, ctx);`;
  const guardedDispatch = `      const ctx = toolContext;
      openConfigRejectRestrictedExploreTask(args);
      const delegateTaskArgs = await prepareDelegateTaskArgs(args, ctx);`;
  if (text.includes(dispatchAnchor)) text = replaceOnce(text, dispatchAnchor, guardedDispatch, "restricted explore pre-dispatch guard");
  else if (!text.includes(guardedDispatch)) throw new Error("Patch anchor mismatch for restricted explore pre-dispatch guard");
  return text;
}

function applyPentestThroughputAliasMigrationV30(original) {
  const start = original.indexOf("function configuredPrimaryRetryLimit(config3, state3) {");
  const end = original.indexOf("function openConfigMaxRecoveryDispatches() {", start);
  if (start < 0 || end < 0) return original;
  const governedMatrix = original.slice(start, end);
  const migratedMatrix = governedMatrix
    .replaceAll("deepseek-v4-flash-0731-zdr-floor", "deepseek-v4-flash-0731-zdr-throughput")
    .replaceAll("deepseek-v4-pro-0813-zdr-floor", "deepseek-v4-pro-0813-zdr-throughput");
  return migratedMatrix === governedMatrix
    ? original
    : original.slice(0, start) + migratedMatrix + original.slice(end);
}

function applyConfiguredAgentContextResolutionV32(original) {
  const helper = `function openConfigConfiguredAgentName(agent, pluginConfig) {
  if (typeof agent !== "string" || !pluginConfig?.agents) return;
  const normalized = agent.trim().toLowerCase();
  if (!normalized) return;
  return Object.keys(pluginConfig.agents).find((name) => name.toLowerCase() === normalized);
}

`;
  let text = original;
  if (!text.includes("function openConfigConfiguredAgentName(agent, pluginConfig)")) {
    text = replaceOnce(text, "function createAgentContextResolver(deps) {", `${helper}function createAgentContextResolver(deps) {`, "v32 configured agent helper");
  }
  const oldEventResolution = "  const { ctx } = deps;\n  return async (sessionID, eventAgent) => {\n    const resolved = resolveAgentForSession(sessionID, eventAgent);";
  const newEventResolution = "  const { ctx, pluginConfig } = deps;\n  return async (sessionID, eventAgent) => {\n    const resolved = openConfigConfiguredAgentName(eventAgent, pluginConfig) ?? resolveAgentForSession(sessionID, eventAgent);";
  if (text.includes(oldEventResolution)) text = replaceOnce(text, oldEventResolution, newEventResolution, "v32 configured event agent resolution");
  else if (!text.includes(newEventResolution)) throw new Error("Patch anchor mismatch for v32 configured event agent resolution");
  const oldMessageResolution = `        const infoAgent = typeof info?.agent === "string" ? info.agent : undefined;
        const normalized = normalizeAgentName(infoAgent);`;
  const newMessageResolution = `        const infoAgent = typeof info?.agent === "string" ? info.agent : undefined;
        const configured = openConfigConfiguredAgentName(infoAgent, pluginConfig);
        if (configured) return configured;
        const normalized = normalizeAgentName(infoAgent);`;
  if (text.includes(oldMessageResolution)) text = replaceOnce(text, oldMessageResolution, newMessageResolution, "v32 configured message agent resolution");
  else if (!text.includes(newMessageResolution)) throw new Error("Patch anchor mismatch for v32 configured message agent resolution");
  return text;
}

function applyFallbackBootstrapRaceFixV33(original) {
  const helper = `function openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel) {
  const existing = sessionStates.get(sessionID);
  if (existing) return existing;
  const created = createFallbackState(initialModel);
  sessionStates.set(sessionID, created);
  return created;
}
`;
  let text = original;
  if (!text.includes("function openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel)")) {
    text = replaceOnce(text, "function isModelInCooldown(model, state3, cooldownSeconds) {", `${helper}function isModelInCooldown(model, state3, cooldownSeconds) {`, "v33 atomic fallback bootstrap helper");
  }
  text = text.replaceAll("state3 = createFallbackState(initialModel);\n      sessionStates.set(sessionID, state3);", "state3 = openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel);");
  text = text.replaceAll("state3 = createFallbackState(initialModel);\n        sessionStates.set(sessionID, state3);", "state3 = openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel);");
  text = text.replaceAll("state3 = createFallbackState(initialModel);\n      deps.sessionStates.set(sessionID, state3);", "state3 = openConfigGetOrCreateFallbackState(deps.sessionStates, sessionID, initialModel);");
  text = text.replaceAll("maxPrimaryRetries: configuredPrimaryRetryLimit(config3),", "maxPrimaryRetries: configuredPrimaryRetryLimit(config3, state3),");
  return text;
}

function applyFallbackIdleTurnPreservationV34(original) {
  const oldCleanup = `    if (event.type === "session.idle" || event.type === "session.deleted") openConfigClearFallbackReplay(resolveSessionEventID(props));`;
  const newCleanup = `    if (event.type === "session.deleted") openConfigClearFallbackReplay(resolveSessionEventID(props));`;
  if (original.includes(oldCleanup)) return replaceOnce(original, oldCleanup, newCleanup, "v34 preserve durable turn across idle fallback replay");
  if (!original.includes(newCleanup)) throw new Error("Patch anchor mismatch for v34 idle fallback replay preservation");
  return original;
}

function applyNativeIdleTurnPreservationV35(original) {
  const oldIdle = `  const handleSessionIdle2 = (props) => {
    const sessionID = resolveSessionEventID(props);
    if (!sessionID)
      return;
    openConfigClearFallbackReplay(sessionID);
    if (cancelledSessions.has(sessionID)) {`;
  const newIdle = `  const handleSessionIdle2 = (props) => {
    const sessionID = resolveSessionEventID(props);
    if (!sessionID)
      return;
    if (cancelledSessions.has(sessionID)) {`;
  if (original.includes(oldIdle)) return replaceOnce(original, oldIdle, newIdle, "v35 native idle durable-turn preservation");
  if (!original.includes(newIdle)) throw new Error("Patch anchor mismatch for v35 native idle durable-turn preservation");
  return original;
}

function applyCurrentRuntimeFixes(original) {
  return applyNativeIdleTurnPreservationV35(applyFallbackIdleTurnPreservationV34(applyFallbackBootstrapRaceFixV33(applyConfiguredAgentContextResolutionV32(original))));
}

function assertNoUnsupportedOpenConfigRuntimePatchMarkers(text) {
  const openConfigMarkers = [...new Set(text.match(/OpenConfig runtime-fallback[^\n*]*patch v\d+/g) ?? [])];
  const unsupportedMarkers = openConfigMarkers.filter(marker => marker !== MARKER && !LEGACY_MARKERS.includes(marker));
  if (unsupportedMarkers.length > 0) {
    throw new Error(`Refusing unsupported OpenConfig OmO runtime patch marker(s): ${unsupportedMarkers.join(", ")}. Only fresh dist or deployed v1-v34 upgrades are supported.`);
  }
}

// Canonical route patch follows the existing runtime-fallback patch.
export function patchDist(original) {
  assertNoUnsupportedOpenConfigRuntimePatchMarkers(original);
  if (original.includes(MARKER)) return { text: original, changed: false };
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v34")) {
    const text = `${applyNativeIdleTurnPreservationV35(original)}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v33")) {
    const text = `${applyNativeIdleTurnPreservationV35(applyFallbackIdleTurnPreservationV34(original))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v32")) {
    const text = `${applyNativeIdleTurnPreservationV35(applyFallbackIdleTurnPreservationV34(applyFallbackBootstrapRaceFixV33(original)))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v31")) {
    const text = `${applyCurrentRuntimeFixes(original)}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v30")) {
    const text = `${applyCurrentRuntimeFixes(applyExploreSecurityIntentRejection(applyPentestThroughputAliasMigrationV30(original)))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v29")) {
    const text = `${applyCurrentRuntimeFixes(applyExploreSecurityIntentRejection(applyPentestThroughputAliasMigrationV30(original)))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v28")) {
    const text = `${applyCurrentRuntimeFixes(applyPentestThroughputAliasMigrationV30(applyExploreSecurityIntentRejection(original)))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v27")) {
    const text = `${applyCurrentRuntimeFixes(applyExploreSecurityIntentRejection(applyCanonicalAgentModels(original)))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  // v23 is the complete governed bundle deployed by this repository. Its
  // source anchors have already been consumed, so re-running the historical
  // string transforms would be both brittle and unsafe.
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v25")) {
    const text = `${applyCurrentRuntimeFixes(applyExploreSecurityIntentRejection(applyDurableUserTurnLatchV27(applyDurableUserTurnResetV26(original))))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v26")) {
    const text = `${applyCurrentRuntimeFixes(applyExploreSecurityIntentRejection(applyDurableUserTurnLatchV27(original)))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v24")) {
    const text = `${applyCurrentRuntimeFixes(applyExploreSecurityIntentRejection(applyDurableUserTurnLatchV27(applyDurableUserTurnResetV26(applyPerModelRetryAndDispatchBoundsV25(original)))))}\n/* ${MARKER} */\n`;
    assertPatched(text);
    return { text, changed: true };
  }
  if (original.includes("OpenConfig runtime-fallback and canonical agent-model patch v23")) {
    return patchDist(`${original}\n/* OpenConfig runtime-fallback and canonical agent-model patch v24 */\n`);
  }
  if (LEGACY_MARKERS.some(marker => original.includes(marker))) {
    let upgraded = applyEnvironmentRuntimeKnobs(original);
    upgraded = applyCanonicalAgentModels(upgraded);
    upgraded = applyExactPentestFallbackStateMachine(upgraded);
    upgraded = applyFinalPentestFallbackGuards(upgraded);
    upgraded = applyPrimaryRetryLogFix(upgraded);
    upgraded = applyPentestTransitionCapV12(upgraded);
    let guarded = applyPentestEventGuardsV12(upgraded);
    guarded = applyPentestEventGuardsV13(guarded);
    guarded = applyPentestEventGuardsV14(guarded);
    guarded = applyPentestEventGuardsV15(guarded);
    guarded = applyPentestEventGuardsV16(guarded);
    guarded = applyPentestEventGuardsV17(guarded);
    guarded = applyPentestEventGuardsV18(guarded);
    let text = applyStrictFallbackSafetyAllProfilesV19(guarded);
    text = applyStrictFallbackClassifierAndDedupV20(text);
    text = applyExplicitTextStatusSafetyV21(text);
    text = applyNestedTextStatusSafetyV22(text);
    text = applyErrorEnvelopeStatusSafetyV23(text);
    text = applyPerModelRetryAndDispatchBoundsV25(text);
    text = applyDurableUserTurnResetV26(text);
    text = applyDurableUserTurnLatchV27(text);
    text = applyCurrentRuntimeFixes(applyPentestThroughputAliasMigrationV30(applyExploreSecurityIntentRejection(text)));
    text = `${text}\n/* ${MARKER} */\n`;
    return { text, changed: true };
  }
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

  text = applyEnvironmentRuntimeKnobs(text);
  text = applyCanonicalAgentModels(text);
  text = applyExactPentestFallbackStateMachine(text);
  text = applyFinalPentestFallbackGuards(text);
  text = applyPrimaryRetryLogFix(text);
  text = applyPentestTransitionCapV12(text);
  text = applyPentestEventGuardsV12(text);
  text = applyPentestEventGuardsV13(text);
  text = applyPentestEventGuardsV14(text);
  text = applyPentestEventGuardsV15(text);
  text = applyPentestEventGuardsV16(text);
  text = applyPentestEventGuardsV17(text);
  text = applyPentestEventGuardsV18(text);
  text = applyStrictFallbackSafetyAllProfilesV19(text);
  text = applyStrictFallbackClassifierAndDedupV20(text);
  text = applyExplicitTextStatusSafetyV21(text);
  text = applyNestedTextStatusSafetyV22(text);
  text = applyErrorEnvelopeStatusSafetyV23(text);
  text = applyDurableUserTurnLatchV27(applyDurableUserTurnResetV26(applyPerModelRetryAndDispatchBoundsV25(text)));
  text = applyCurrentRuntimeFixes(applyExploreSecurityIntentRejection(text));
  text = `${text}\n/* ${MARKER} */\n`;
  return { text, changed: true };
}

export function assertPatched(text) {
  assertNoUnsupportedOpenConfigRuntimePatchMarkers(text);
  const required = [
    MARKER,
    "same_model_retries_before_fallback",
    "first_prompt_timeout_seconds",
    "function shouldRetryPrimaryBeforeFallback",
    "OPENCONFIG_OMO_SAME_MODEL_RETRIES_BEFORE_FALLBACK",
    "OPENCONFIG_OMO_FIRST_PROMPT_TIMEOUT_SECONDS",
    "primaryRetryCount",
    "allowPrimaryRetry",
    "firstPromptWatchdogMs",
    "function openConfigCanRetryFallbackError(error, retryOnErrors)",
    "function openConfigFallbackTransitionLimit(config3)",
    "function openConfigPentestFallbackActive()",
    "OpenConfig strict fallback classifier v20",
    "OpenConfig Error envelope status safety v23",
    "OpenConfig per-model retry and dispatch bounds v25",
    "OpenConfig durable user turn state reset v26",
    "OpenConfig centralized durable user turn v27",
    "function openConfigProfileName()",
    "function openConfigMaxRecoveryDispatches()",
    "deepseek-v4-flash-0731-zdr-throughput",
    "maxDispatchesReached: true",
    "rungRetryCount",
    "recoveryDispatchCount",
    "function openConfigShouldBlockFallbackReplay",
    "function openConfigPentestStatusCode(error)",
    "function openConfigCanRetrySessionStatus(retrySignal, retryMessage, retryOnErrors)",
    "function openConfigRejectRestrictedExploreTask(args)",
    "function openConfigConfiguredAgentName(agent, pluginConfig)",
    "function openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel)",
    "state3 = openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel);",
    "state3 = openConfigGetOrCreateFallbackState(deps.sessionStates, sessionID, initialModel);",
    "maxPrimaryRetries: configuredPrimaryRetryLimit(config3, state3),",
    `if (event.type === "session.deleted") openConfigClearFallbackReplay(resolveSessionEventID(props));`,
    "const { ctx, pluginConfig } = deps;",
    "openConfigConfiguredAgentName(eventAgent, pluginConfig) ?? resolveAgentForSession(sessionID, eventAgent)",
    "Direct explore is limited to code-location tasks. Route security, pentest, or source-recovery work with category content-aware-fast or content-aware-deep.",
    "Duplicate fallback signal skipped",
    "No durable human user message/messageID",
    "visibleNonTextPart",
    "session.status retry skipped after visible assistant output",
    "function openConfigMaterializeAgentOverride(override)",
    "if (!Array.isArray(override.models) || override.models.length === 0) return override",
    "models: z14.array(z14.union([z14.string(), FallbackModelObjectSchema])).optional()",
    "function openConfigMaterializeAgentOverrides(overrides)",
    "}).catchall(AgentOverrideConfigSchema.optional()).transform(openConfigMaterializeAgentOverrides);",
    "return { ...override, ...primarySettings, model, fallback_models: fallbackModels };",
    `"models", "variant", "reasoningEffort"`,
    "function openConfigModelsRoute(definition)",
    "function openConfigEntryForResolvedModel(entries, resolvedModel)",
    "const agentModelRoute = openConfigModelsRoute(agentOverride);",
    "const selectedAgentModelEntry = effectiveEntry ?? openConfigEntryForResolvedModel(agentModelRoute.entries, categoryModel);",
    "const callOmoAgentModelRoute = openConfigModelsRoute(agentOverride);",
    "const primaryCallOmoAgentEntry = openConfigEntryForResolvedModel(callOmoAgentModelRoute.entries, model);",
    "const canonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;",
    "const callOmoCanonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;",
    "const openConfigCanonicalCategoryPrimary = hasCanonicalModels ? configuredPrimaryModel : undefined;",
    "function openConfigRejectRestrictedExploreTask(args)",
    "} else if (openConfigCanonicalCategoryPrimaryParsed) {",
  ];
  const exploreHelperStart = text.indexOf("function openConfigRejectRestrictedExploreTask(args)");
  const exploreHelperEnd = text.indexOf("function createDelegateTask(options) {", exploreHelperStart);
  const exploreHelper = exploreHelperStart >= 0 && exploreHelperEnd > exploreHelperStart
    ? text.slice(exploreHelperStart, exploreHelperEnd)
    : "";
  const missingExploreSemantics = [
    "scan(?:ning)?",
    "find\\s+vulnerabilities",
    "security\\s+(?:audit|assessment|analysis",
    "backend\\s+source\\s+reconstruction",
  ].filter(marker => !exploreHelper.includes(marker));
  if (missingExploreSemantics.length > 0) throw new Error(`OmO governed runtime patch has restricted explore helper missing required semantics: ${missingExploreSemantics.join(", ")}`);
  const matrixStart = text.indexOf("function configuredPrimaryRetryLimit(config3, state3) {");
  const matrixEnd = text.indexOf("function openConfigMaxRecoveryDispatches() {", matrixStart);
  const stalePentestAliases = matrixStart >= 0 && matrixEnd > matrixStart
    ? ["deepseek-v4-flash-0731-zdr-floor", "deepseek-v4-pro-0813-zdr-floor"].filter(alias => text.slice(matrixStart, matrixEnd).includes(alias))
    : [];
  if (stalePentestAliases.length > 0) throw new Error(`OmO governed runtime patch contains stale pentest ZDR Floor alias(es): ${stalePentestAliases.join(", ")}`);
  const nativeIdleStart = text.indexOf("const handleSessionIdle2 = (props) => {");
  const nativeIdleEnd = text.indexOf("const handleSessionError = async (props) => {", nativeIdleStart);
  const nativeIdleHandler = nativeIdleStart >= 0 && nativeIdleEnd > nativeIdleStart ? text.slice(nativeIdleStart, nativeIdleEnd) : "";
  if (!nativeIdleHandler || nativeIdleHandler.includes("openConfigClearFallbackReplay(sessionID)")) {
    throw new Error("OmO governed runtime patch still clears the durable fallback turn inside handleSessionIdle2");
  }
  const missing = required.filter(value => !text.includes(value));
  if (missing.length > 0) throw new Error(`OmO governed runtime patch missing: ${missing.join(", ")}`);
  const forbidden = [
    "function openConfigPrimaryAgentOverride(",
    "nativeSisyphusJuniorOverride",
    "nativeBuiltinOverride",
    "maxTokens: override?.maxTokens ?? 64000,",
  ].filter(value => text.includes(value));
  if (forbidden.length > 0) throw new Error(`OmO governed runtime patch contains removed v5 native-builder patch: ${forbidden.join(", ")}`);
  const exactOnce = [
    "function openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel)",
    "function openConfigConfiguredAgentName(agent, pluginConfig)",
    "function openConfigMaterializeAgentOverride(override)",
    "function openConfigMaterializeAgentOverrides(overrides)",
    "}).catchall(AgentOverrideConfigSchema.optional()).transform(openConfigMaterializeAgentOverrides);",
    "function openConfigModelsRoute(definition)",
    "function openConfigEntryForResolvedModel(entries, resolvedModel)",
    "const agentModelRoute = openConfigModelsRoute(agentOverride);",
    "const callOmoAgentModelRoute = openConfigModelsRoute(agentOverride);",
    "const selectedAgentModelEntry = effectiveEntry ?? openConfigEntryForResolvedModel(agentModelRoute.entries, categoryModel);",
    "const primaryCallOmoAgentEntry = openConfigEntryForResolvedModel(callOmoAgentModelRoute.entries, model);",
    "const canonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;",
    "const callOmoCanonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;",
    "const openConfigCanonicalCategoryPrimary = hasCanonicalModels ? configuredPrimaryModel : undefined;",
  ];
  const duplicated = exactOnce.filter(value => text.split(value).length - 1 !== 1);
  if (duplicated.length > 0) throw new Error(`OmO governed runtime patch has non-unique canonical blocks: ${duplicated.join(", ")}`);
}

function main() {
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
    console.log(`OK|omo governed runtime patch present|${dist}`);
    return;
  }
  const { text, changed } = patchDist(original);
  assertPatched(text);
  if (changed) writeFileSync(dist, text);
  console.log(`${changed ? "PATCHED" : "OK"}|omo governed runtime patch|${dist}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
