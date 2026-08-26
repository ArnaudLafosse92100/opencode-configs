import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { applyCanonicalAgentModels, assertPatched, patchDist } from "../scripts/patch-omo-runtime-fallback.mjs";

const FIXTURE = `
// packages/omo-opencode/src/config/schema/agent-overrides.ts
var AgentOverrideConfigSchema = z14.object({
  model: z14.string().optional(),
  fallback_models: FallbackModelsSchema.optional(),
  reasoning: OmoReasoningSchema.optional(),
  variant: z14.string().optional(),
  category: z14.string().optional(),
  temperature: z14.number().optional(),
  top_p: z14.number().optional(),
  maxTokens: z14.number().optional(),
  reasoningEffort: z14.string().optional(),
  thinking: z14.any().optional(),
  compaction: z14.object({
    model: z14.string().optional(),
    reasoning: OmoReasoningSchema.optional(),
    variant: z14.string().optional()
  }).optional()
});
var AgentOverridesSchema = z14.object({
  sisyphus: AgentOverrideConfigSchema.optional(),
  hephaestus: AgentOverrideConfigSchema.extend({ allow_non_gpt_model: z14.boolean().optional() }).optional(),
  prometheus: AgentOverrideConfigSchema.optional(),
  atlas: AgentOverrideConfigSchema.optional()
}).catchall(AgentOverrideConfigSchema.optional());
function modelInput(view) {
  const agents = isPlainRecord(view.agents) ? Object.fromEntries(Object.entries(view.agents).flatMap(([name, definition]) => {
    const fields = recordFields(definition, ["description", "prompt", "model", "variant", "reasoningEffort", "tools", "temperature", "disable"]);
    return fields === undefined ? [] : [[name, fields]];
  })) : undefined;
}`;

// Immutable relevant-region fixture from the clean Bun package cache below. Every
// fresh patch anchor is represented exactly once; the patch tests deliberately do
// not derive it by undoing any OpenConfig patch.
//
// The clean Bun package is selected at runtime only by this SHA-256.
const FRESH_PATCH_FIXTURE = `${FIXTURE}
var RuntimeFallbackConfigSchema = z38.object({
  enabled: z38.boolean().optional(),
  retry_on_errors: z38.array(z38.number()).optional(),
  max_fallback_attempts: z38.number().min(1).max(20).optional(),
  cooldown_seconds: z38.number().min(0).optional(),
  timeout_seconds: z38.number().min(0).optional(),
  notify_on_fallback: z38.boolean().optional(),
  restore_primary_after_cooldown: z38.boolean().optional()
});
var DEFAULT_CONFIG2 = {
  enabled: false,
  retry_on_errors: [429, 500, 502, 503, 504],
  max_fallback_attempts: 3,
  cooldown_seconds: 60,
  timeout_seconds: 30,
  notify_on_fallback: true,
  restore_primary_after_cooldown: false
};
function createFallbackState(originalModel) {
  const model = stringifyRuntimeModel(originalModel) ?? String(originalModel);
  return {
    originalModel: model,
    currentModel: model,
    fallbackIndex: -1,
    failedModels: new Map,
    attemptCount: 0,
    pendingFallbackModel: undefined
  };
}
function prepareFallback(sessionID, state3, fallbackModels, config3) {
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
}
    attemptCount: state3.attemptCount,
    pendingFallbackModel: state3.pendingFallbackModel,
  state3.attemptCount = snapshot.attemptCount;
  state3.pendingFallbackModel = snapshot.pendingFallbackModel;
  const snapshot = snapshotFallbackState(options.state);
  const result = prepareFallback(options.sessionID, options.state, options.fallbackModels, deps.config);
      resolvedAgent,
      source: "session.status"
    });
    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state: state3,
      fallbackModels,
      resolvedAgent,
      source: SOURCE
    });
      if (classifyErrorType(error) === "quota_exceeded") {
        await helpers.abortSessionRequest(sessionID, "message.updated.quota-fallback");
        sessionRetryInFlight.delete(sessionID);
      }
      await dispatchFallbackRetry(deps, helpers, {
        sessionID,
        state: state3,
        fallbackModels,
        resolvedAgent,
        source: "message.updated"
      });
  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers);
function applyFallbackEntrySettings(input) {
  const { categoryModel, effectiveEntry, variantOverride } = input;
  return {
    ...categoryModel,
    variant: variantOverride ?? effectiveEntry.variant ?? categoryModel.variant,
    reasoning: effectiveEntry.reasoning ?? categoryModel.reasoning,
    reasoningEffort: effectiveEntry.reasoning === undefined && categoryModel.reasoning === undefined ? effectiveEntry.reasoningEffort ?? categoryModel.reasoningEffort : categoryModel.reasoningEffort,
    temperature: effectiveEntry.temperature ?? categoryModel.temperature,
    top_p: effectiveEntry.top_p ?? categoryModel.top_p,
    maxTokens: effectiveEntry.maxTokens ?? categoryModel.maxTokens,
    thinking: effectiveEntry.thinking ?? categoryModel.thinking
  };
}
function findAgentOverride2(agentOverrides, agentConfigKey) {
  return agentOverrides?.[agentConfigKey] ?? Object.entries(agentOverrides ?? {}).find(([key]) => key.toLowerCase() === agentConfigKey)?.[1];
}
async function resolveSubagentModel(agentToUse, matchedAgent, executorCtx) {
  let categoryModel = undefined;
  let fallbackChain = undefined;
  const agentConfigKey = getAgentConfigKey(agentToUse);
  const agentOverride = findAgentOverride2(executorCtx.agentOverrides, agentConfigKey);
  const agentRequirement = AGENT_MODEL_REQUIREMENTS[agentConfigKey];
  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined;
  const agentCategoryModel = agentCategoryConfig?.model;
  const hasExplicitUserModel = Boolean(agentOverride?.model ?? agentCategoryModel);
  const normalizedAgentFallbackModels = normalizeFallbackModels(agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models);
  const availableModels = await getAvailableModelsForDelegateTask(executorCtx.client);
  const normalizedMatchedModel = matchedAgent.model ? normalizeModelFormat(matchedAgent.model) : undefined;
  const matchedAgentModelStr = normalizedMatchedModel ? \`\${normalizedMatchedModel.providerID}/\${normalizedMatchedModel.modelID}\` : undefined;
  if (agentOverride?.model || agentCategoryModel || agentRequirement || matchedAgent.model) {
    const resolution2 = resolveModelForDelegateTask2({
      userModel: agentOverride?.model ?? agentCategoryModel,
      userFallbackModels: flattenToFallbackModelStrings(normalizedAgentFallbackModels),
      categoryDefaultModel: matchedAgentModelStr,
      fallbackChain: agentRequirement?.fallbackChain,
      availableModels,
      systemDefaultModel: undefined
    });
    const resolutionSkipped = resolution2 && "skipped" in resolution2;
    if (resolution2 && !resolutionSkipped) {
      const normalized = normalizeModelFormat(resolution2.model);
      if (normalized) {
        const variantToUse = agentOverride?.variant ?? resolution2.variant ?? agentCategoryConfig?.variant;
        const resolvedModel = variantToUse ? { ...normalized, variant: variantToUse } : normalized;
        categoryModel = applyCategoryParams(resolvedModel, agentCategoryConfig);
      }
    } else if (resolutionSkipped && (agentOverride?.model ?? agentCategoryModel)) {
      const explicitModel = agentOverride?.model ?? agentCategoryModel;
      const normalized = explicitModel ? normalizeModelFormat(explicitModel) : undefined;
      if (normalized) {
        const variantToUse = agentOverride?.variant ?? agentCategoryConfig?.variant;
        const resolvedModel = variantToUse ? { ...normalized, variant: variantToUse } : normalized;
        categoryModel = applyCategoryParams(resolvedModel, agentCategoryConfig);
        log2("[delegate-task] Cold cache: using explicit user override for subagent", {
          agent: agentToUse,
          model: agentOverride?.model ?? agentCategoryModel
        });
      }
    }
    const defaultProviderID = categoryModel?.providerID ?? normalizedMatchedModel?.providerID ?? "opencode";
    const configuredFallbackChain = buildFallbackChainFromModels(normalizedAgentFallbackModels, defaultProviderID);
    fallbackChain = configuredFallbackChain ?? (resolutionSkipped || hasExplicitUserModel ? undefined : agentRequirement?.fallbackChain);
    const effectiveEntry = resolveEffectiveFallbackEntry({
      categoryModel,
      configuredFallbackChain,
      resolution: resolution2
    });
    if (categoryModel && effectiveEntry) {
      categoryModel = applyFallbackEntrySettings({
        categoryModel,
        effectiveEntry,
        variantOverride: agentOverride?.variant
      });
    }
  }
}
function resolveModelAndFallbackChain(args) {
  const { subagentType, agentOverrides, userCategories } = args;
  const agentConfigKey = getAgentConfigKey(subagentType);
  const agentRequirement = AGENT_MODEL_REQUIREMENTS[agentConfigKey];
  const agentOverride = agentOverrides?.[agentConfigKey] ?? (agentOverrides ? Object.entries(agentOverrides).find(([key]) => key.toLowerCase() === agentConfigKey)?.[1] : undefined);
  const agentCategoryModel = agentOverride?.category ? userCategories?.[agentOverride.category]?.model : undefined;
  const agentCategoryVariant = agentOverride?.category ? userCategories?.[agentOverride.category]?.variant : undefined;
  let model;
  if (agentOverride?.model) {
    const normalized = parseModelString(agentOverride.model);
    if (normalized) {
      model = agentOverride.variant ? { ...normalized, variant: agentOverride.variant } : normalized;
      log2("[call_omo_agent] Resolved model override from agent config", {
        agent: subagentType,
        model: agentOverride.model,
        variant: agentOverride.variant
      });
    }
  }
  const normalizedFallbackModels = normalizeFallbackModels(agentOverride?.fallback_models ?? (agentOverride?.category ? userCategories?.[agentOverride.category]?.fallback_models : undefined));
}`;

const CLEAN_OMO_4194_SHA256 = "e522d513a08d0a6871129dbf3d9c3a79e4871693997fbf34190c4d3fa3d6b4b5";
const FRESH_FIXTURE_ANCHORS = [
  "var RuntimeFallbackConfigSchema = z38.object({",
  "var DEFAULT_CONFIG2 = {",
  "function createFallbackState(originalModel) {",
  "function prepareFallback(sessionID, state3, fallbackModels, config3) {",
  "function applyFallbackEntrySettings(input) {",
  "function findAgentOverride2(agentOverrides, agentConfigKey) {",
  "async function resolveSubagentModel(agentToUse, matchedAgent, executorCtx) {",
  "function resolveModelAndFallbackChain(args) {",
];

function bunCacheRoots(env = process.env, home = homedir()) {
  const xdgCache = env.XDG_CACHE_HOME || join(home, ".cache");
  return [...new Set([
    env.BUN_INSTALL_CACHE_DIR,
    join(xdgCache, ".bun", "install", "cache"),
    join(home, ".bun", "install", "cache"),
  ].filter(value => typeof value === "string" && value.length > 0))];
}

function chooseCleanOmo4194Candidate(candidates) {
  return candidates
    .filter(candidate => candidate.sha256 === CLEAN_OMO_4194_SHA256 && !candidate.hasOpenConfigMarker)
    .sort((left, right) => left.path.localeCompare(right.path))[0];
}

function cleanOmo4194Source() {
  const roots = bunCacheRoots();
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      candidates.push({ path: `${root} (unreadable: ${error.code ?? error.message})` });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("oh-my-openagent@4.19.4")) continue;
      const path = join(root, entry.name, "dist", "index.js");
      try {
        const source = readFileSync(path);
        candidates.push({
          path,
          source,
          sha256: createHash("sha256").update(source).digest("hex"),
          hasOpenConfigMarker: source.includes("OpenConfig runtime-fallback"),
        });
      } catch (error) {
        candidates.push({ path: `${path} (unreadable: ${error.code ?? error.message})` });
      }
    }
  }
  const candidate = chooseCleanOmo4194Candidate(candidates);
  if (!candidate) {
    const inspected = candidates.length === 0
      ? "none"
      : candidates.map(value => `${value.path}${value.sha256 ? ` sha256=${value.sha256} marker=${value.hasOpenConfigMarker}` : ""}`).join("; ");
    throw new Error(`Clean OmO 4.19.4 source not found (expected sha256=${CLEAN_OMO_4194_SHA256}, no OpenConfig marker). Bun roots: ${roots.join(", ") || "none"}. Candidates: ${inspected}`);
  }
  return candidate.source.toString("utf8");
}

function schemaBundle(patched) {
  const start = patched.indexOf("function openConfigMaterializeAgentOverride(override)");
  const end = [
    patched.indexOf("\n// packages/omo-opencode/src/config/schema/babysitting.ts", start),
    patched.indexOf("\nfunction modelInput", start),
  ].find((index) => index > start);
  assert.ok(start >= 0 && end > start, "central AgentOverridesSchema transform is present");
  const require = createRequire(import.meta.url);
  const z14 = require(join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "packages", "oh-my-openagent@4.19.4", "node_modules", "zod"));
  const context = {
    z14,
    FallbackModelsSchema: z14.any(),
    FallbackModelObjectSchema: z14.any(),
    OmoReasoningSchema: z14.any(),
    AgentPermissionSchema: z14.any(),
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.schema = AgentOverrideConfigSchema; globalThis.overridesSchema = AgentOverridesSchema;`, context);
  return context;
}

function canonicalModels() {
  return [
    { model: "openrouter/primary", reasoning: "high", temperature: 0.2, top_p: 0.8, maxTokens: 12345, variant: "nitro" },
    { model: "subscription/fallback", reasoningEffort: "low", variant: "low" },
  ];
}

function legacyRoute(override) {
  return {
    model: override?.model,
    fallback_models: override?.fallback_models,
    reasoning: override?.reasoning,
    reasoningEffort: override?.reasoningEffort,
    temperature: override?.temperature,
    top_p: override?.top_p,
    maxTokens: override?.maxTokens,
    variant: override?.variant,
  };
}

function routeBundle(patched) {
  const start = patched.indexOf("function openConfigModelsRoute(definition)");
  const end = patched.indexOf("function findAgentOverride2", start);
  assert.ok(start >= 0 && end > start, "direct task model route helper is present");
  const context = {
    normalizeFallbackModels(value) {
      return Array.isArray(value) ? value.filter((entry) => entry !== undefined) : undefined;
    },
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.route = openConfigModelsRoute; globalThis.entry = openConfigEntryForResolvedModel;`, context);
  return context;
}

function entrySettingsBundle(patched) {
  const start = patched.indexOf("function applyFallbackEntrySettings(input)");
  const end = patched.indexOf("\n}\n", start) + 2;
  assert.ok(start >= 0 && end > start, "real fallback-entry settings helper is present");
  const context = {};
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.apply = applyFallbackEntrySettings;`, context);
  return context.apply;
}

function replaceExactlyOnce(text, from, to, label) {
  assert.equal(text.split(from).length - 1, 1, `${label} fixture anchor is unique`);
  return text.replace(from, to);
}

function deployedV3Fixture() {
  // This is a forward reconstruction, never an inverse of v7. The v2 runtime
  // regions come from committed patcher e53e03c; the v3 route regions come from
  // the recorded 2026-08-26 rollout (session 01a03d2c-3b17-7dd1-9ca3-4956cbb122c8,
  // ordinal 22). Both are applied to the full hash-validated clean source.
  let text = cleanOmo4194Source();
  text = replaceExactlyOnce(text, `  restore_primary_after_cooldown: z38.boolean().optional()\n});`, `  restore_primary_after_cooldown: z38.boolean().optional(),
  same_model_retries_before_fallback: z38.number().int().min(0).max(10).optional(),
  first_prompt_timeout_seconds: z38.number().min(1).optional()
});`, "v2 RuntimeFallbackConfigSchema");
  text = replaceExactlyOnce(text, `  restore_primary_after_cooldown: false\n};`, `  restore_primary_after_cooldown: false,
  same_model_retries_before_fallback: 0,
  first_prompt_timeout_seconds: 90
};`, "v2 DEFAULT_CONFIG2");
  text = replaceExactlyOnce(text, `    attemptCount: 0,
    pendingFallbackModel: undefined`, `    attemptCount: 0,
    primaryRetryCount: 0,
    pendingFallbackModel: undefined`, "v2 createFallbackState");
  text = replaceExactlyOnce(text, `function prepareFallback(sessionID, state3, fallbackModels, config3) {
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
  const now = Date.now();`, `function shouldRetryPrimaryBeforeFallback(state3, config3, options = {}) {
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
  });`, "v2 prepareFallback");
  text = replaceExactlyOnce(text, `    attemptCount: state3.attemptCount,
    pendingFallbackModel: state3.pendingFallbackModel,`, `    attemptCount: state3.attemptCount,
    primaryRetryCount: state3.primaryRetryCount ?? 0,
    pendingFallbackModel: state3.pendingFallbackModel,`, "v2 snapshotFallbackState");
  text = replaceExactlyOnce(text, `  state3.attemptCount = snapshot.attemptCount;
  state3.pendingFallbackModel = snapshot.pendingFallbackModel;`, `  state3.attemptCount = snapshot.attemptCount;
  state3.primaryRetryCount = snapshot.primaryRetryCount ?? 0;
  state3.pendingFallbackModel = snapshot.pendingFallbackModel;`, "v2 restoreFallbackState");
  text = replaceExactlyOnce(text, `const result = prepareFallback(options.sessionID, options.state, options.fallbackModels, deps.config);`, `const result = prepareFallback(options.sessionID, options.state, options.fallbackModels, deps.config, options);`, "v2 dispatchFallbackRetry");
  text = replaceExactlyOnce(text, `      source: "session.status"
    });`, `      source: "session.status",
      allowPrimaryRetry: true
    });`, "v2 session.status");
  text = replaceExactlyOnce(text, `      source: SOURCE
    });`, `      source: SOURCE,
      allowPrimaryRetry: true
    });`, "v2 firstPromptWatchdog");
  text = replaceExactlyOnce(text, `      await dispatchFallbackRetry(deps, helpers, {
        sessionID,
        state: state3,
        fallbackModels,
        resolvedAgent,
        source: "message.updated"
      });`, `      const errorTypeForPrimaryRetry = classifyErrorType(error);
      const statusCodeForPrimaryRetry = extractStatusCode(error, config3.retry_on_errors);
      const allowPrimaryRetry = Boolean(retrySignal) || (!["abort", "context_overflow", "missing_api_key", "invalid_api_key", "model_not_found", "quota_exceeded"].includes(errorTypeForPrimaryRetry ?? "") && (statusCodeForPrimaryRetry === undefined || statusCodeForPrimaryRetry >= 500 || statusCodeForPrimaryRetry === 408 || statusCodeForPrimaryRetry === 425 || statusCodeForPrimaryRetry === 429));
      await dispatchFallbackRetry(deps, helpers, {
        sessionID,
        state: state3,
        fallbackModels,
        resolvedAgent,
        source: "message.updated",
        allowPrimaryRetry
      });`, "v2 message.updated");
  text = replaceExactlyOnce(text, `  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers);`, `  const firstPromptWatchdogMs = Math.max(1000, Number(config3.first_prompt_timeout_seconds ?? DEFAULT_FIRST_PROMPT_WATCHDOG_MS / 1000) * 1000);
  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers, firstPromptWatchdogMs);`, "v2 firstPromptWatchdog.config");
  // v2's environment compatibility follow-up, also from e53e03c.
  text = replaceExactlyOnce(text, `function shouldRetryPrimaryBeforeFallback(state3, config3, options = {}) {
  const maxPrimaryRetries = Number(config3.same_model_retries_before_fallback ?? 0);`, `function openConfigRuntimeFallbackInteger(name, fallback) {
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
  const maxPrimaryRetries = configuredPrimaryRetryLimit(config3);`, "v2 environment helper");
  text = replaceExactlyOnce(text, `      maxPrimaryRetries: config3.same_model_retries_before_fallback,`, `      maxPrimaryRetries,`, "v2 retry log");
  text = replaceExactlyOnce(text, `  const firstPromptWatchdogMs = Math.max(1000, Number(config3.first_prompt_timeout_seconds ?? DEFAULT_FIRST_PROMPT_WATCHDOG_MS / 1000) * 1000);
  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers, firstPromptWatchdogMs);`, `  const firstPromptWatchdogMs = configuredFirstPromptWatchdogMs(config3);
  const firstPromptWatchdog = factories.createFirstPromptWatchdog(deps, helpers, firstPromptWatchdogMs);`, "v2 watchdog environment");

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
  text = replaceExactlyOnce(text, "function findAgentOverride2(agentOverrides, agentConfigKey) {", `${legacyRouteHelper}function findAgentOverride2(agentOverrides, agentConfigKey) {`, "v3 route helper");
  text = replaceExactlyOnce(text, `  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined;
  const agentCategoryModel = agentCategoryConfig?.model;
  const hasExplicitUserModel = Boolean(agentOverride?.model ?? agentCategoryModel);
  const normalizedAgentFallbackModels = normalizeFallbackModels(agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models);`, `  const agentModelRoute = openConfigModelsRoute(agentOverride);
  const agentModel = agentModelRoute.primary ?? agentOverride?.model;
  const agentCategoryConfig = agentOverride?.category ? executorCtx.userCategories?.[agentOverride.category] : undefined;
  const agentCategoryModel = agentCategoryConfig?.model;
  const hasExplicitUserModel = Boolean(agentModel ?? agentCategoryModel);
  const normalizedAgentFallbackModels = normalizeFallbackModels(agentModelRoute.fallbackModels ?? agentOverride?.fallback_models ?? agentCategoryConfig?.fallback_models);`, "v3 resolver setup");
  text = replaceExactlyOnce(text, `  if (agentOverride?.model || agentCategoryModel || agentRequirement || matchedAgent.model) {
    const resolution2 = resolveModelForDelegateTask2({
      userModel: agentOverride?.model ?? agentCategoryModel,`, `  if (agentModel || agentCategoryModel || agentRequirement || matchedAgent.model) {
    const resolution2 = resolveModelForDelegateTask2({
      userModel: agentModel ?? agentCategoryModel,`, "v3 resolver primary");
  text = replaceExactlyOnce(text, `    } else if (resolutionSkipped && (agentOverride?.model ?? agentCategoryModel)) {
      const explicitModel = agentOverride?.model ?? agentCategoryModel;`, `    } else if (resolutionSkipped && (agentModel ?? agentCategoryModel)) {
      const explicitModel = agentModel ?? agentCategoryModel;`, "v3 resolver cold cache");
  text = replaceExactlyOnce(text, `          model: agentOverride?.model ?? agentCategoryModel`, `          model: agentModel ?? agentCategoryModel`, "v3 resolver cold cache log");
  text = replaceExactlyOnce(text, `    if (categoryModel && effectiveEntry) {`, `    if (categoryModel && agentModelRoute.primaryEntry) {
      categoryModel = applyFallbackEntrySettings({
        categoryModel,
        effectiveEntry: agentModelRoute.primaryEntry,
        variantOverride: agentOverride?.variant
      });
    }
    if (categoryModel && effectiveEntry) {`, "v3 resolver settings");
  text = replaceExactlyOnce(text, '"description", "prompt", "model", "variant", "reasoningEffort"', '"description", "prompt", "model", "models", "variant", "reasoningEffort"', "v3 native registration");
  return `${text}
/* OpenConfig runtime-fallback primary retry patch v1 */

/* OpenConfig runtime-fallback primary retry patch v2 */

/* OpenConfig runtime-fallback and canonical agent-model patch v3 */`;
}

test("central AgentOverridesSchema transform materializes canonical models without losing them", () => {
  const patched = applyCanonicalAgentModels(FIXTURE);
  const { overridesSchema } = schemaBundle(patched);
  const parsed = overridesSchema.parse({ hephaestus: { models: canonicalModels(), allow_non_gpt_model: true } }).hephaestus;
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    models: canonicalModels(),
    allow_non_gpt_model: true,
    model: "openrouter/primary",
    fallback_models: [{ model: "subscription/fallback", reasoningEffort: "low", variant: "low" }],
    reasoning: "high",
    temperature: 0.2,
    top_p: 0.8,
    maxTokens: 12345,
    variant: "nitro",
  });
  assert.equal(applyCanonicalAgentModels(patched), patched, "central transform patch is idempotent");
});

test("fresh relevant-region fixture is grounded in the checked clean OmO 4.19.4 source", () => {
  const text = cleanOmo4194Source();
  for (const anchor of FRESH_FIXTURE_ANCHORS) {
    assert.ok(FRESH_PATCH_FIXTURE.includes(anchor), `immutable fixture carries ${anchor}`);
    assert.ok(text.includes(anchor), `clean package carries ${anchor}`);
  }
});

test("clean OmO resolver chooses only the expected unpatched hash deterministically", () => {
  const selected = chooseCleanOmo4194Candidate([
    { path: "/cache/z/dist/index.js", sha256: CLEAN_OMO_4194_SHA256, hasOpenConfigMarker: true },
    { path: "/cache/c/dist/index.js", sha256: "wrong", hasOpenConfigMarker: false },
    { path: "/cache/b/dist/index.js", sha256: CLEAN_OMO_4194_SHA256, hasOpenConfigMarker: false },
    { path: "/cache/a/dist/index.js", sha256: CLEAN_OMO_4194_SHA256, hasOpenConfigMarker: false },
  ]);
  assert.equal(selected.path, "/cache/a/dist/index.js");
  assert.equal(chooseCleanOmo4194Candidate([{ path: "/cache/patched", sha256: CLEAN_OMO_4194_SHA256, hasOpenConfigMarker: true }]), undefined);
  assert.deepEqual(bunCacheRoots({ BUN_INSTALL_CACHE_DIR: "/custom/bun-cache", XDG_CACHE_HOME: "/custom/xdg" }, "/home/test"), [
    "/custom/bun-cache",
    "/custom/xdg/.bun/install/cache",
    "/home/test/.bun/install/cache",
  ]);
});

test("all legacy builtin and fallback consumers receive the centrally materialized route", () => {
  const dist = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "packages", "oh-my-openagent@4.19.4", "node_modules", "oh-my-openagent", "dist", "index.js");
  const result = patchDist(readFileSync(dist, "utf8"));
  assertPatched(result.text);
  assert.doesNotMatch(result.text, /openConfigPrimaryAgentOverride|nativeSisyphusJuniorOverride|nativeBuiltinOverride/,
    "v5 per-builder patches are absent from the centralized output");
  for (const consumer of [
    "function createSisyphusAgent(",
    "function createHephaestusAgent(",
    "function createAtlasAgent(",
    "async function buildPrometheusAgentConfig(",
    "function createSisyphusJuniorAgentWithOverrides(",
    "function collectPendingBuiltinAgents(",
    "function getRawFallbackModelsForSession(",
  ]) assert.ok(result.text.includes(consumer), `pinned OmO consumer remains present: ${consumer}`);
  const { overridesSchema } = schemaBundle(result.text);
  const overrides = overridesSchema.parse(Object.fromEntries([
    "sisyphus", "hephaestus", "atlas", "prometheus", "sisyphus-junior", "explore",
  ].map((name) => [name, { models: canonicalModels() }])));
  for (const name of Object.keys(overrides)) {
    assert.deepEqual(JSON.parse(JSON.stringify(legacyRoute(overrides[name]))), {
      model: "openrouter/primary",
      fallback_models: [{ model: "subscription/fallback", reasoningEffort: "low", variant: "low" }],
      reasoning: "high",
      temperature: 0.2,
      top_p: 0.8,
      maxTokens: 12345,
      variant: "nitro",
    }, `${name} receives the legacy values its real consumer reads`);
  }
  assert.match(result.text, /const overrideModel = override\?\.model;/, "Junior still uses its native legacy model field");
  assert.match(result.text, /isGptModel\(model\).*reasoningEffort/s, "Junior applies reasoningEffort only for GPT models");
});

test("fresh and active v3 routes converge on the same direct primary and fallback settings", () => {
  const freshSource = cleanOmo4194Source();
  const freshV7 = patchDist(freshSource).text;
  assertPatched(freshV7);
  const activeV3 = deployedV3Fixture();
  assert.match(activeV3, /patch v1 \*\/\n\n\/\* OpenConfig runtime-fallback primary retry patch v2 \*\/\n\n\/\* OpenConfig runtime-fallback and canonical agent-model patch v3/, "historical v3 fixture retains the deployed v1→v2→v3 marker chain");
  assert.match(activeV3, /primaryEntry: typeof primaryEntry/, "historical v3 fixture retains its direct-route helper");
  assert.doesNotMatch(activeV3, /openConfigMaterializeAgentOverride/, "historical v3 fixture predates central materialization");
  assert.doesNotMatch(activeV3, /callOmoAgentModelRoute/, "historical v3 fixture predates call_omo_agent canonical routing");
  assert.doesNotMatch(activeV3, /openConfigEntryForResolvedModel/, "historical v3 fixture predates resolved-entry lookup");
  assert.doesNotMatch(activeV3, /canonicalVariantOverride/, "historical v3 fixture predates canonical-entry variant isolation");
  assert.doesNotMatch(activeV3, /models: z14\.array\(z14\.union/, "historical v3 fixture predates central schema support");
  assert.doesNotMatch(activeV3, /patch v7/, "historical v3 fixture has no v7 marker");
  for (const v2Symbol of ["primaryRetryCount", "openConfigRuntimeFallbackInteger", "configuredFirstPromptWatchdogMs", "allowPrimaryRetry"]) {
    assert.match(activeV3, new RegExp(v2Symbol), `historical v3 retains its deployed v2 runtime region: ${v2Symbol}`);
  }
  const v3 = patchDist(activeV3).text;
  assertPatched(v3);
  const brokenFreshAnchor = freshSource.replace("max_fallback_attempts: 3,", "max_fallback_attempts: 4,");
  assert.throws(() => patchDist(brokenFreshAnchor), /DEFAULT_CONFIG2/, "fresh fixture exercises the raw runtime patch anchors");
  const brokenV3Anchor = activeV3.replace("const agentModelRoute = openConfigModelsRoute(agentOverride);", "const v3RouteAnchorWasBroken = agentOverride;");
  assert.throws(() => patchDist(brokenV3Anchor), /resolveSubagentModel canonical route/, "v3 fixture exercises the historical direct-route upgrade anchor");
  const candidates = { fresh: freshV7, activeV3: v3 };
  for (const [name, patched] of Object.entries(candidates)) {
    assert.match(patched, /const selectedAgentModelEntry = effectiveEntry \?\? openConfigEntryForResolvedModel\(agentModelRoute\.entries, categoryModel\);/, `${name} applies resolved entry settings once`);
    assert.match(patched, /const primaryCallOmoAgentEntry = openConfigEntryForResolvedModel\(callOmoAgentModelRoute\.entries, model\);/, `${name} applies call_omo_agent primary settings`);
    assert.match(patched, /const canonicalVariantOverride = Array\.isArray\(agentOverride\?\.models\) \? undefined : agentOverride\?\.variant;/, `${name} separates canonical entry variants from legacy overrides`);
    assert.match(patched, /variantOverride: canonicalVariantOverride/, `${name} applies the selected resolver entry without primary variant leakage`);
    assert.match(patched, /variantOverride: callOmoCanonicalVariantOverride/, `${name} applies the selected call_omo entry without primary variant leakage`);
    assert.equal(applyCanonicalAgentModels(patched), patched, `${name} canonical patch is byte-idempotent`);
    const { route, entry } = routeBundle(patched);
    const routed = route({ models: canonicalModels() });
    assert.equal(routed.primary, "openrouter/primary", `${name} routes canonical primary`);
    assert.deepEqual(JSON.parse(JSON.stringify(routed.fallbackModels)), [{ model: "subscription/fallback", reasoningEffort: "low", variant: "low" }], `${name} routes canonical fallback`);
    const primaryEntry = entry(routed.entries, { providerID: "openrouter", modelID: "primary" });
    assert.deepEqual(JSON.parse(JSON.stringify(primaryEntry)), canonicalModels()[0], `${name} finds the primary settings entry`);
    const applied = entrySettingsBundle(patched)({ categoryModel: { providerID: "openrouter", modelID: "primary" }, effectiveEntry: primaryEntry });
    assert.deepEqual(JSON.parse(JSON.stringify(applied)), {
      providerID: "openrouter", modelID: "primary", variant: "nitro", reasoning: "high", temperature: 0.2, top_p: 0.8, maxTokens: 12345,
    }, `${name} applies the primary entry settings through OmO's real helper`);
    const fallbackEntry = entry(routed.entries, "subscription/fallback");
    assert.deepEqual(JSON.parse(JSON.stringify(entrySettingsBundle(patched)({ categoryModel: { providerID: "subscription", modelID: "fallback" }, effectiveEntry: fallbackEntry }))), {
      providerID: "subscription", modelID: "fallback", variant: "low", reasoningEffort: "low",
    }, `${name} keeps the fallback entry variant instead of leaking the primary variant`);
  }
  assert.equal(patchDist(v3).text, v3, "v3 upgrade to v7 is byte-idempotent");
  assert.equal(patchDist(freshV7).text, freshV7, "fresh patch output is byte-idempotent");
});

test("patchDist refuses unsupported intermediate or unknown OpenConfig markers", () => {
  const dist = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "packages", "oh-my-openagent@4.19.4", "node_modules", "oh-my-openagent", "dist", "index.js");
  const activeV3 = readFileSync(dist, "utf8");
  const v7 = patchDist(activeV3).text;
  assertPatched(v7);
  assert.equal(patchDist(v7).text, v7, "v7 alone remains accepted and idempotent");
  for (const version of [4, 5, 6, 99]) {
    const unsupported = activeV3.replace("OpenConfig runtime-fallback and canonical agent-model patch v3", `OpenConfig runtime-fallback and canonical agent-model patch v${version}`);
    assert.throws(() => patchDist(unsupported), /Refusing unsupported OpenConfig OmO runtime patch marker/, `v${version}`);
    const contaminatedV7 = `${v7}\n/* OpenConfig runtime-fallback and canonical agent-model patch v${version} */`;
    assert.throws(() => patchDist(contaminatedV7), /Refusing unsupported OpenConfig OmO runtime patch marker/, `patchDist v7 + v${version}`);
    assert.throws(() => assertPatched(contaminatedV7), /Refusing unsupported OpenConfig OmO runtime patch marker/, `assertPatched v7 + v${version}`);
  }
});

test("assertPatched rejects v5 contamination and duplicated canonical blocks", () => {
  const dist = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "packages", "oh-my-openagent@4.19.4", "node_modules", "oh-my-openagent", "dist", "index.js");
  const patched = patchDist(readFileSync(dist, "utf8")).text;
  assertPatched(patched);
  for (const contamination of [
    "function openConfigPrimaryAgentOverride(",
    "nativeSisyphusJuniorOverride",
    "nativeBuiltinOverride",
    "maxTokens: override?.maxTokens ?? 64000,",
  ]) {
    assert.throws(() => assertPatched(`${patched}\n${contamination}`), /removed v5 native-builder patch/, contamination);
  }
  for (const canonicalBlock of [
    "function openConfigMaterializeAgentOverride(override)",
    "function openConfigModelsRoute(definition)",
    "const callOmoAgentModelRoute = openConfigModelsRoute(agentOverride);",
    "const selectedAgentModelEntry = effectiveEntry ?? openConfigEntryForResolvedModel(agentModelRoute.entries, categoryModel);",
    "const callOmoCanonicalVariantOverride = Array.isArray(agentOverride?.models) ? undefined : agentOverride?.variant;",
  ]) {
    assert.throws(() => assertPatched(`${patched}\n${canonicalBlock}`), /non-unique canonical blocks/, canonicalBlock);
  }
});
