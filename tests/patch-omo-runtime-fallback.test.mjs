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
}
function createDelegateTask(options) {
  return tool({
    async execute(args, toolContext) {
      const ctx = toolContext;
      const delegateTaskArgs = await prepareDelegateTaskArgs(args, ctx);
      return delegateTaskArgs;
    }
  });
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
  "function createDelegateTask(options) {",
  "const delegateTaskArgs = await prepareDelegateTaskArgs(args, ctx);",
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

function restrictedExploreBundle(patched) {
  const start = patched.indexOf("function openConfigRejectRestrictedExploreTask(args)");
  const end = patched.indexOf("function createDelegateTask(options) {", start);
  assert.ok(start >= 0 && end > start, "restricted explore pre-dispatch helper is present");
  const context = { Error };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.reject = openConfigRejectRestrictedExploreTask;`, context);
  return context.reject;
}

function entrySettingsBundle(patched) {
  const start = patched.indexOf("function applyFallbackEntrySettings(input)");
  const end = patched.indexOf("\n}\n", start) + 2;
  assert.ok(start >= 0 && end > start, "real fallback-entry settings helper is present");
  const context = {};
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.apply = applyFallbackEntrySettings;`, context);
  return context.apply;
}

function categoryPreflightBundle(patched, availableModels) {
  const start = patched.indexOf("function getConfiguredModel(entry)");
  const end = patched.indexOf("// packages/omo-opencode/src/tools/delegate-task/subagent-resolver.ts", start);
  assert.ok(start >= 0 && end > start, "category preflight resolver is present");
  let resolverCalls = 0;
  const context = {
    CATEGORY_MODEL_REQUIREMENTS: { quick: { fallbackChain: ["builtin/fallback"] } },
    BUILTIN_CATEGORY_REQUIRES_MODEL: {},
    CATEGORY_PROMPT_APPEND_RESOLVERS: {},
    SISYPHUS_JUNIOR_AGENT2: "sisyphus-junior",
    log2() {},
    mergeCategories: categories => categories,
    getAvailableModelsForDelegateTask: async () => new Set(availableModels),
    resolveCategoryConfig: (_category, { userCategories }) => ({
      config: userCategories.quick,
      model: userCategories.quick.models[0].model,
      isUserConfiguredModel: true,
    }),
    normalizeFallbackModels: value => Array.isArray(value) ? value.filter(entry => entry !== undefined) : undefined,
    flattenToFallbackModelStrings: entries => (entries ?? []).map(entry => typeof entry === "string" ? entry : entry.model),
    resolveModelForDelegateTask2: ({ userModel, userFallbackModels, availableModels: cache }) => {
      resolverCalls += 1;
      if (cache.has(userModel)) return { model: userModel };
      const fallback = userFallbackModels.find(model => cache.has(model));
      return fallback ? { model: fallback, matchedFallback: true } : { skipped: true };
    },
    parseModelString: model => {
      if (typeof model !== "string") return undefined;
      const slash = model.indexOf("/");
      return slash > 0 && slash < model.length - 1 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : undefined;
    },
    applyCategoryParams: (model, config) => ({ ...model, reasoning: config.reasoning }),
    resolveCategoryPromptAppendForModel: () => undefined,
    buildFallbackChainFromModels: models => models,
    findMostSpecificFallbackEntry: (providerID, modelID, chain) => chain.find(entry => (typeof entry === "string" ? entry : entry.model) === `${providerID}/${modelID}`),
    applyFallbackEntrySettings: ({ categoryModel, effectiveEntry }) => ({ ...categoryModel, reasoning: effectiveEntry.reasoning ?? categoryModel.reasoning }),
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.resolve = resolveCategoryExecution;`, context);
  return {
    resolve: args => context.resolve(args, {
      client: {},
      userCategories: {
        quick: {
          models: [
            { model: "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput", reasoning: "low" },
            { model: "openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput", reasoning: "high" },
          ],
        },
      },
      sisyphusJuniorModel: undefined,
    }, undefined, undefined),
    get resolverCalls() { return resolverCalls; },
  };
}

function fallbackStateMachineBundle(patched, profile = "pentest") {
  const start = patched.indexOf("function createFallbackState(originalModel)");
  const end = patched.indexOf("function snapshotFallbackState", start);
  assert.ok(start >= 0 && end > start, "patched fallback state machine is present");
  const context = {
    stringifyRuntimeModel: value => typeof value === "string" ? value : `${value.providerID}/${value.modelID}`,
    HOOK_NAME13: "runtime-fallback",
    log2() {},
    areRuntimeFallbackModelsEquivalent: (left, right) => left === right,
    process: { env: { OPENCONFIG_RUNTIME_PROFILE: profile } },
    openConfigPentestFallbackActive: () => profile === "pentest",
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.createState = createFallbackState; globalThis.prepare = prepareFallback;`, context);
  return context;
}

function retryabilityBundle(patched, profile = "pentest") {
  const start = patched.indexOf("function openConfigPentestStatusCode(error)");
  const end = patched.indexOf("// packages/omo-opencode/src/hooks/runtime-fallback/fallback-bootstrap-model.ts", start);
  assert.ok(start >= 0 && end > start, "patched retryability classifier is present");
  const nested = (value, keys) => {
    if (!value || typeof value !== "object") return undefined;
    for (const key of keys) {
      if (typeof value[key] === "number") return value[key];
    }
    for (const child of Object.values(value)) {
      const found = nested(child, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const context = {
    extractStatusCode: error => nested(error, ["statusCode", "status"]),
    classifyErrorType: error => {
      const value = JSON.stringify(error);
      if (/abort/i.test(value)) return "abort";
      if (/context[ _-]?overflow/i.test(value)) return "context_overflow";
      if (/model[ _-]?not[ _-]?found/i.test(value)) return "model_not_found";
      if (/missing[ _-]?api[ _-]?key/i.test(value)) return "missing_api_key";
      if (/invalid[ _-]?api[ _-]?key/i.test(value)) return "invalid_api_key";
      if (/quota[ _-]?exceeded/i.test(value)) return "quota_exceeded";
      return undefined;
    },
    isRetryableError: error => /retryable/i.test(JSON.stringify(error)),
    openConfigPentestFallbackActive: () => profile === "pentest",
    RETRYABLE_ERROR_PATTERNS: [/retrying/i, /endpoint unavailable/i],
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.canRetry = openConfigCanRetryFallbackError; globalThis.canRetryStatus = openConfigCanRetrySessionStatus;`, context);
  return context;
}

function visibleOutputBundle(patched) {
  const start = patched.indexOf("const openConfigVisibleAssistantOutputSessions = new Map;");
  const end = patched.indexOf("// packages/omo-opencode/src/hooks/runtime-fallback/message-update-handler.ts", start);
  assert.ok(start >= 0 && end > start, "patched visible-output event guard is present");
  const context = {
    Set,
    Error,
    getAssistantText(parts) {
      return (parts ?? []).filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n").trim();
    },
    extractSessionMessages(response) { return response?.data ?? response; },
    getLastUserMessageIndex(messages) { return messages.findLastIndex((message) => message?.info?.role === "user"); },
    resolveMessageEventSessionID(props) { return props?.sessionID ?? props?.info?.sessionID ?? props?.part?.sessionID; },
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.visible = hasVisibleAssistantResponse; globalThis.observe = openConfigObserveFallbackEvent; globalThis.clear = openConfigClearFallbackReplay;`, context);
  return context;
}

function runtimeEventHandlerBundle(patched) {
  const helperStart = patched.indexOf("const openConfigVisibleAssistantOutputSessions = new Map;");
  const helperEnd = patched.indexOf("// packages/omo-opencode/src/hooks/runtime-fallback/message-update-handler.ts", helperStart);
  const setup = patched.indexOf("const baseEventHandler = factories.createEventHandler(deps, helpers);");
  const start = patched.indexOf("  const eventHandler = async ({ event }) => {", setup);
  const end = patched.indexOf("  const dispose = () => {", start);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && start >= 0 && end > start, "real runtime event handler is present");
  const calls = [];
  const eventDeps = { sessionStates: new Map() };
  const context = {
    Map, Set, Error,
    getAssistantText(parts) { return (parts ?? []).filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n").trim(); },
    extractSessionMessages(response) { return response?.data ?? response; },
    getLastUserMessageIndex(messages) { return messages.findLastIndex((message) => message?.info?.role === "user"); },
    resolveMessageEventSessionID(props) { return props?.sessionID ?? props?.info?.sessionID ?? props?.part?.sessionID; },
    resolveSessionEventID(props) { return props?.sessionID ?? props?.info?.id; },
    extractAutoRetrySignal: ({ message }) => /retrying|endpoint (?:is )?unavailable/i.test(message ?? "") ? { signal: "retrying" } : undefined,
    ensureInterval() { calls.push("interval"); },
    config3: { enabled: true },
    observeEventForWatchdog() {}, firstPromptWatchdog: {},
    messageUpdateHandler: async () => calls.push("message.updated"),
    baseEventHandler: async ({ event }) => calls.push(event.type),
    deps: eventDeps,
  };
  vm.runInNewContext(`${patched.slice(helperStart, helperEnd)}\n${patched.slice(start, end)}\nglobalThis.eventHandler = eventHandler; globalThis.visible = hasVisibleAssistantResponse; globalThis.latches = openConfigVisibleAssistantOutputSessions;`, context);
  return { eventHandler: context.eventHandler, calls, visible: context.visible, latches: context.latches, context, eventDeps };
}

function messageUpdateHandlerBundle(patched, profile) {
  const start = patched.indexOf("function createMessageUpdateHandler(deps, helpers)");
  const end = patched.indexOf("\n// packages/", start + 10);
  assert.ok(start >= 0 && end > start, "real message.updated handler is present");
  const calls = [];
  const sessionID = "ses_duplicate";
  const deps = {
    ctx: { directory: "/tmp" },
    config: { timeout_seconds: 20, retry_on_errors: [408, 425, 429, 500, 502, 503, 504] },
    pluginConfig: {},
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set([sessionID]),
    sessionAwaitingFallbackResult: new Set(),
    sessionStatusRetryKeys: new Set(),
  };
  const helpers = {
    abortSessionRequest: async (...args) => calls.push(["abort", ...args]),
    clearSessionFallbackTimeout: () => calls.push(["clear-timeout"]),
    resolveAgentForSessionFromContext: async () => "sisyphus",
  };
  const context = {
    Map, Set, Error,
    hasVisibleAssistantResponse: () => async () => false,
    extractAutoRetrySignal: value => /retrying|endpoint (?:is )?unavailable/i.test(value?.message ?? value?.status ?? "") ? { signal: "retrying" } : undefined,
    resolveMessageEventSessionID: props => props?.sessionID ?? props?.info?.sessionID,
    containsErrorContent: () => ({ hasError: false }),
    normalizeModelToCanonicalString: value => value,
    log2() {},
    HOOK_NAME13: "runtime-fallback",
    process: { env: { OPENCONFIG_RUNTIME_PROFILE: profile } },
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.create = createMessageUpdateHandler;`, context);
  return { handler: context.create(deps, helpers), calls, deps, sessionID };
}

function configuredAgentContextBundle(patched, messages = []) {
  const start = patched.indexOf("function openConfigConfiguredAgentName(agent, pluginConfig)");
  const end = patched.indexOf("// packages/omo-opencode/src/hooks/runtime-fallback/auto-retry-dispatch.ts", start);
  assert.ok(start >= 0 && end > start, "configured agent context resolver is present");
  const context = {
    resolveAgentForSession: (_sessionID, eventAgent) => eventAgent === "Sisyphus" ? "sisyphus" : undefined,
    extractSessionMessages: response => response?.data ?? response,
    normalizeAgentName: agent => agent === "Sisyphus" ? "sisyphus" : undefined,
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.create = createAgentContextResolver;`, context);
  const deps = {
    pluginConfig: { agents: { "codex-router": {}, "Security-Router": {}, sisyphus: {} } },
    ctx: { directory: "/tmp", client: { session: { messages: async () => ({ data: messages }) } } },
  };
  return context.create(deps);
}

function fallbackBootstrapBundle(patched) {
  const start = patched.indexOf("function createFallbackState(originalModel)");
  const end = patched.indexOf("function isModelInCooldown(model, state3, cooldownSeconds)", start);
  assert.ok(start >= 0 && end > start, "atomic fallback bootstrap helper is present");
  const context = {
    stringifyRuntimeModel: value => typeof value === "string" ? value : `${value.providerID}/${value.modelID}`,
  };
  vm.runInNewContext(`${patched.slice(start, end)}; globalThis.createOrGet = openConfigGetOrCreateFallbackState;`, context);
  return context.createOrGet;
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

function deployedV29StalePentestAliasFixture() {
  let text = patchDist(cleanOmo4194Source()).text;
  text = replaceExactlyOnce(
    text,
    "OpenConfig runtime-fallback and canonical agent-model patch v35",
    "OpenConfig runtime-fallback and canonical agent-model patch v29",
    "v29 marker",
  );
  return replaceExactlyOnce(
    text,
    "/deepseek-v4-flash-0731-zdr-throughput/.test(model)",
    "/deepseek-v4-flash-0731-zdr-floor/.test(model)",
    "v29 stale pentest Flash alias",
  );
}

function deployedV30StaleExploreHelperFixture() {
  let text = patchDist(cleanOmo4194Source()).text;
  text = replaceExactlyOnce(
    text,
    "OpenConfig runtime-fallback and canonical agent-model patch v35",
    "OpenConfig runtime-fallback and canonical agent-model patch v30",
    "v30 marker",
  );
  return replaceExactlyOnce(
    text,
    "vulnerability\\s+(?:scan(?:ning)?|assessment|research|report)|find\\s+vulnerabilities|exploit(?:ation)?|recon(?:naissance)?|osint|forensic(?:s)?|security\\s+(?:audit|assessment|analysis|review|test(?:ing)?|research|scan(?:ning)?)",
    "vulnerability\\s+(?:scan|assessment|research|report)|exploit(?:ation)?|recon(?:naissance)?|osint|forensic(?:s)?|security\\s+(?:audit|assessment|review|test(?:ing)?|research|scan)",
    "v30 stale security intent regex",
  );
}

function deployedV31RestrictedAgentResolverFixture() {
  let text = patchDist(cleanOmo4194Source()).text;
  text = replaceExactlyOnce(text, "OpenConfig runtime-fallback and canonical agent-model patch v35", "OpenConfig runtime-fallback and canonical agent-model patch v31", "v31 marker");
  text = replaceExactlyOnce(text, `function openConfigConfiguredAgentName(agent, pluginConfig) {
  if (typeof agent !== "string" || !pluginConfig?.agents) return;
  const normalized = agent.trim().toLowerCase();
  if (!normalized) return;
  return Object.keys(pluginConfig.agents).find((name) => name.toLowerCase() === normalized);
}

`, "", "v31 configured agent helper");
  text = replaceExactlyOnce(text, "  const { ctx, pluginConfig } = deps;\n  return async (sessionID, eventAgent) => {\n    const resolved = openConfigConfiguredAgentName(eventAgent, pluginConfig) ?? resolveAgentForSession(sessionID, eventAgent);", "  const { ctx } = deps;\n  return async (sessionID, eventAgent) => {\n    const resolved = resolveAgentForSession(sessionID, eventAgent);", "v31 event agent resolver");
  return replaceExactlyOnce(text, `        const infoAgent = typeof info?.agent === "string" ? info.agent : undefined;
        const configured = openConfigConfiguredAgentName(infoAgent, pluginConfig);
        if (configured) return configured;
        const normalized = normalizeAgentName(infoAgent);`, `        const infoAgent = typeof info?.agent === "string" ? info.agent : undefined;
        const normalized = normalizeAgentName(infoAgent);`, "v31 message agent resolver");
}

function deployedV32RacyFallbackBootstrapFixture() {
  let text = patchDist(cleanOmo4194Source()).text;
  text = replaceExactlyOnce(text, "OpenConfig runtime-fallback and canonical agent-model patch v35", "OpenConfig runtime-fallback and canonical agent-model patch v32", "v32 marker");
  text = replaceExactlyOnce(text, `function openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel) {
  const existing = sessionStates.get(sessionID);
  if (existing) return existing;
  const created = createFallbackState(initialModel);
  sessionStates.set(sessionID, created);
  return created;
}
`, "", "v32 atomic bootstrap helper");
  text = text.replaceAll("state3 = openConfigGetOrCreateFallbackState(sessionStates, sessionID, initialModel);", "state3 = createFallbackState(initialModel);\n      sessionStates.set(sessionID, state3);");
  text = text.replaceAll("state3 = openConfigGetOrCreateFallbackState(deps.sessionStates, sessionID, initialModel);", "state3 = createFallbackState(initialModel);\n      deps.sessionStates.set(sessionID, state3);");
  return text.replaceAll("maxPrimaryRetries: configuredPrimaryRetryLimit(config3, state3),", "maxPrimaryRetries: configuredPrimaryRetryLimit(config3),");
}

function deployedV33IdleCleanupFixture() {
  let text = patchDist(cleanOmo4194Source()).text;
  text = replaceExactlyOnce(text, "OpenConfig runtime-fallback and canonical agent-model patch v35", "OpenConfig runtime-fallback and canonical agent-model patch v33", "v33 marker");
  return replaceExactlyOnce(text, `    if (event.type === "session.deleted") openConfigClearFallbackReplay(resolveSessionEventID(props));`, `    if (event.type === "session.idle" || event.type === "session.deleted") openConfigClearFallbackReplay(resolveSessionEventID(props));`, "v33 idle cleanup");
}

function deployedV34NativeIdleCleanupFixture() {
  let text = patchDist(cleanOmo4194Source()).text;
  text = replaceExactlyOnce(text, "OpenConfig runtime-fallback and canonical agent-model patch v35", "OpenConfig runtime-fallback and canonical agent-model patch v34", "v34 marker");
  const preserved = `  const handleSessionIdle2 = (props) => {
    const sessionID = resolveSessionEventID(props);
    if (!sessionID)
      return;
    if (cancelledSessions.has(sessionID)) {`;
  const stale = `  const handleSessionIdle2 = (props) => {
    const sessionID = resolveSessionEventID(props);
    if (!sessionID)
      return;
    openConfigClearFallbackReplay(sessionID);
    if (cancelledSessions.has(sessionID)) {`;
  return replaceExactlyOnce(text, preserved, stale, "v34 native idle cleanup");
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

test("runtime fallback resolves configured root and custom agents outside OmO's builtin allowlist", async () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  const direct = configuredAgentContextBundle(patched);
  assert.equal(await direct("ses_root", "codex-router"), "codex-router");
  assert.equal(await direct("ses_custom", "security-router"), "Security-Router");
  assert.equal(await direct("ses_builtin", "Sisyphus"), "sisyphus");
  const recovered = configuredAgentContextBundle(patched, [{ info: { agent: "codex-router" } }]);
  assert.equal(await recovered("ses_missing_event_agent"), "codex-router");
});

test("v31 upgrade adds configured-agent recovery for codex-router fallback", () => {
  const staleV31 = deployedV31RestrictedAgentResolverFixture();
  assert.throws(() => assertPatched(staleV31), /openConfigConfiguredAgentName/, "v31 hard-coded agent resolver fails closed");
  const upgraded = patchDist(staleV31);
  assert.equal(upgraded.changed, true);
  assert.match(upgraded.text, /patch v35/);
  assertPatched(upgraded.text);
  assert.equal(patchDist(upgraded.text).changed, false, "v35 resolver upgrade is idempotent");
});

test("fallback bootstrap is atomic across concurrent message.updated and session.error handlers", () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  const createOrGet = fallbackBootstrapBundle(patched);
  const states = new Map();
  const first = createOrGet(states, "ses_race", "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput");
  first.primaryRetryCount = 2;
  const concurrent = createOrGet(states, "ses_race", "openrouter/other-model");
  assert.equal(concurrent, first, "a racing handler reuses the established state object");
  assert.equal(concurrent.primaryRetryCount, 2, "a racing handler cannot reset the retry counter");
  assert.equal(patched.split("openConfigGetOrCreateFallbackState(").length - 1, 5, "one helper and four bootstrap call sites are governed");
});

test("v32 upgrade removes the fallback-state bootstrap race", () => {
  const staleV32 = deployedV32RacyFallbackBootstrapFixture();
  assert.throws(() => assertPatched(staleV32), /openConfigGetOrCreateFallbackState/, "v32 racy bootstrap fails closed");
  const upgraded = patchDist(staleV32);
  assert.equal(upgraded.changed, true);
  assert.match(upgraded.text, /patch v35/);
  assertPatched(upgraded.text);
  assert.equal(patchDist(upgraded.text).changed, false, "v35 bootstrap upgrade is idempotent");
});

test("idle preserves the durable turn latch while deletion clears it", async () => {
  const { eventHandler, latches } = runtimeEventHandlerBundle(patchDist(cleanOmo4194Source()).text);
  const sessionID = "ses_idle_replay";
  await eventHandler({ event: { type: "message.updated", properties: { sessionID, info: { role: "user", id: "usr_turn" } } } });
  await eventHandler({ event: { type: "message.updated", properties: { sessionID, info: { role: "assistant", id: "asst_turn", parts: [{ type: "text", text: "semantic output" }] } } } });
  assert.equal(latches.has(sessionID), true);
  await eventHandler({ event: { type: "session.idle", properties: { sessionID } } });
  assert.equal(latches.has(sessionID), true, "idle cannot erase an in-progress fallback turn");
  await eventHandler({ event: { type: "session.deleted", properties: { sessionID } } });
  assert.equal(latches.has(sessionID), false, "session deletion performs terminal cleanup");
});

test("v33 upgrade preserves fallback state across session.idle", () => {
  const staleV33 = deployedV33IdleCleanupFixture();
  assert.throws(() => assertPatched(staleV33), /session\.deleted/, "v33 idle cleanup fails closed");
  const upgraded = patchDist(staleV33);
  assert.equal(upgraded.changed, true);
  assert.match(upgraded.text, /patch v35/);
  assertPatched(upgraded.text);
  assert.equal(patchDist(upgraded.text).changed, false, "v35 idle upgrade is idempotent");
});

test("v34 upgrade removes the native idle cleanup path", () => {
  const staleV34 = deployedV34NativeIdleCleanupFixture();
  assert.throws(() => assertPatched(staleV34), /handleSessionIdle2/, "v34 native idle cleanup fails closed");
  const upgraded = patchDist(staleV34);
  assert.equal(upgraded.changed, true);
  assert.match(upgraded.text, /patch v35/);
  assertPatched(upgraded.text);
  assert.equal(patchDist(upgraded.text).changed, false, "v35 native idle upgrade is idempotent");
});

test("direct explore rejects clear security and source-recovery work before dispatch", () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  const reject = restrictedExploreBundle(patched);
  for (const prompt of [
    "Locate TrellisTech pentest artifacts",
    "Conduct a security audit of the exposed service",
    "Recover the backend source from the archived deployment",
    "Source recovery for the server-side application",
    "Run vulnerability scanning against the API",
    "Find vulnerabilities in the deployed service",
    "Perform security analysis of the login flow",
    "Backend source reconstruction from the build artifact",
  ]) {
    assert.throws(() => reject({ subagent_type: "explore", prompt }), /content-aware-fast or content-aware-deep/, prompt);
  }
  assert.throws(() => reject({ subagent_type: " Explore ", prompt: "Locate TrellisTech pentest artifacts" }), /content-aware-fast or content-aware-deep/, "explore aliases cannot bypass the pre-dispatch guard");
  assert.doesNotThrow(() => reject({ subagent_type: "explore", prompt: "Where is function X defined?" }), "pure code-location work remains allowed");
  assert.doesNotThrow(() => reject({ subagent_type: "explore", prompt: "Locate the security configuration function" }), "security vocabulary without clear assessment intent remains allowed");
  assert.doesNotThrow(() => reject({ subagent_type: "content-aware-fast", prompt: "Locate TrellisTech pentest artifacts" }), "category routing is not rewritten or rejected");
  const executeStart = patched.indexOf("async execute(args, toolContext) {");
  const guard = patched.indexOf("openConfigRejectRestrictedExploreTask(args);", executeStart);
  const preparation = patched.indexOf("const delegateTaskArgs = await prepareDelegateTaskArgs(args, ctx);", executeStart);
  assert.ok(executeStart >= 0 && guard > executeStart && preparation > guard, "guard runs before argument preparation and dispatch");
});

test("v29 upgrade migrates stale governed pentest aliases to throughput and retains three Flash retries", () => {
  const staleV29 = deployedV29StalePentestAliasFixture();
  assert.throws(() => assertPatched(staleV29), /stale pentest ZDR Floor alias/, "stale aliases inside the governed retry matrix fail closed");
  const upgraded = patchDist(staleV29);
  assert.equal(upgraded.changed, true);
  assert.match(upgraded.text, /patch v35/);
  assert.doesNotMatch(upgraded.text.slice(
    upgraded.text.indexOf("function configuredPrimaryRetryLimit(config3, state3) {"),
    upgraded.text.indexOf("function openConfigMaxRecoveryDispatches() {"),
  ), /deepseek-v4-(?:flash-0731|pro-0813)-zdr-floor/);
  assertPatched(upgraded.text);
  const { createState, prepare } = fallbackStateMachineBundle(upgraded.text, "pentest");
  const flash = "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput";
  const state = createState(flash);
  const config = { max_fallback_attempts: 3, cooldown_seconds: 0 };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(prepare("ses_v29_upgrade", state, ["openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput"], config).sameModelRetry, true, `Flash retry ${attempt}`);
    state.pendingFallbackModel = undefined;
  }
  assert.equal(prepare("ses_v29_upgrade", state, ["openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput"], config).newModel, "openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput");
  assert.equal(patchDist(upgraded.text).changed, false, "v35 output is idempotent");
});

test("v30 upgrade replaces the restricted explore helper with expanded semantics", () => {
  const staleV30 = deployedV30StaleExploreHelperFixture();
  assert.throws(() => assertPatched(staleV30), /restricted explore helper missing required semantics/, "v30 helper semantics fail closed before migration");
  const upgraded = patchDist(staleV30);
  assert.equal(upgraded.changed, true);
  assert.match(upgraded.text, /patch v35/);
  assert.equal(upgraded.text.split("function openConfigRejectRestrictedExploreTask(args)").length - 1, 1, "helper is replaced rather than duplicated");
  const reject = restrictedExploreBundle(upgraded.text);
  for (const prompt of [
    "Locate TrellisTech pentest artifacts",
    "Run vulnerability scanning against the API",
    "Find vulnerabilities in the deployed service",
    "Perform security analysis of the login flow",
    "Backend source reconstruction from the build artifact",
  ]) assert.throws(() => reject({ subagent_type: "explore", prompt }), /content-aware-fast or content-aware-deep/, prompt);
  for (const prompt of ["Where is function X defined?", "Locate the security configuration function"]) {
    assert.doesNotThrow(() => reject({ subagent_type: "explore", prompt }), prompt);
  }
  assertPatched(upgraded.text);
  assert.equal(patchDist(upgraded.text).changed, false, "v32 helper upgrade is idempotent");
});

test("category preflight preserves a syntactically valid canonical ZDR primary before cache fallback selection", async () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  const flash = "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput";
  const pro = "openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput";
  const nonZdrFlash = "openrouter/deepseek/deepseek-v4-flash-0731-floor";
  for (const [name, cachedModels] of [
    ["mismatched cache", [nonZdrFlash, pro]],
    ["exact cache", [flash, pro]],
    ["fallback-only cache", [pro]],
  ]) {
    const bundle = categoryPreflightBundle(patched, cachedModels);
    const resolved = await bundle.resolve({ category: "quick" });
    assert.equal(resolved.actualModel, flash, `${name}: the canonical Flash ZDR alias remains the dispatch model`);
    assert.deepEqual(JSON.parse(JSON.stringify(resolved.categoryModel)), {
      providerID: "openrouter",
      modelID: "deepseek/deepseek-v4-flash-0731-zdr-throughput",
      reasoning: "low",
    }, `${name}: no fallback child is selected during preflight`);
    assert.deepEqual(JSON.parse(JSON.stringify(resolved.fallbackChain)), [{ model: pro, reasoning: "high" }], `${name}: Pro remains available only as the configured runtime fallback`);
    assert.equal(bundle.resolverCalls, 0, `${name}: cache resolution cannot promote Pro before Flash dispatch`);
  }
});

test("fault-injected root and delegated-child pentest fallback is Flash plus three retries, one Pro, then terminal", () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  assertPatched(patched);
  const { createState, prepare } = fallbackStateMachineBundle(patched);
  const flash = "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput";
  const pro = "openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput";
  const config = { same_model_retries_before_fallback: 3, max_fallback_attempts: 3, cooldown_seconds: 0 };
  for (const sessionID of ["ses_root", "ses_delegated_child"]) {
    const state = createState(flash);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const next = prepare(sessionID, state, [pro], config, { allowPrimaryRetry: true });
      assert.deepEqual(JSON.parse(JSON.stringify(next)), { success: true, newModel: flash, sameModelRetry: true }, `${sessionID} Flash retry ${attempt}`);
      assert.equal(state.attemptCount, 0, "same-model retries never consume a model transition");
      assert.equal(state.primaryRetryCount, attempt);
      state.pendingFallbackModel = undefined;
    }
    const proAttempt = prepare(sessionID, state, [pro], config, { allowPrimaryRetry: true });
    assert.deepEqual(JSON.parse(JSON.stringify(proAttempt)), { success: true, newModel: pro });
    assert.equal(state.attemptCount, 1, "only Flash → Pro counts as a model transition");
    assert.equal(state.primaryRetryCount, 3);
    state.pendingFallbackModel = undefined;
    const terminal = prepare(sessionID, state, [pro], config, { allowPrimaryRetry: true });
    assert.equal(terminal.success, false);
    assert.equal(terminal.maxDispatchesReached, true, "initial plus three Flash retries plus Pro is the five-dispatch ceiling");
  }

  const duplicate = createState(flash);
  prepare("ses_duplicate", duplicate, [pro], config, { allowPrimaryRetry: true });
  const repeatedSignal = prepare("ses_duplicate", duplicate, [pro], config, { allowPrimaryRetry: true });
  assert.equal(repeatedSignal.duplicate, true, "one upstream error reported twice cannot transition twice");
  assert.equal(duplicate.primaryRetryCount, 1);
  assert.equal(duplicate.attemptCount, 0);
});

test("pentest preserves its one-transition cap while normal keeps its configured transition budget", () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  const flash = "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput";
  const pro = "openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput";
  const config = { same_model_retries_before_fallback: 0, max_fallback_attempts: 3, cooldown_seconds: 0 };
  const pentest = fallbackStateMachineBundle(patched, "pentest");
  const pentestState = pentest.createState(flash);
  for (let retry = 0; retry < 3; retry += 1) {
    assert.equal(pentest.prepare("ses_pentest", pentestState, [pro], config).newModel, flash);
    pentestState.pendingFallbackModel = undefined;
  }
  assert.equal(pentest.prepare("ses_pentest", pentestState, [pro], config).newModel, pro);
  pentestState.pendingFallbackModel = undefined;
  assert.equal(pentest.prepare("ses_pentest", pentestState, [pro], config).maxDispatchesReached, true);

  const normal = fallbackStateMachineBundle(patched, "normal");
  const normalState = normal.createState("openrouter/deepseek/deepseek-v4-pro-0813");
  assert.equal(normal.prepare("ses_normal", normalState, [pro, "openrouter/z-ai/glm-5.3", "openrouter/minimax/minimax-m3"], config).newModel, pro);
  normalState.pendingFallbackModel = undefined;
  assert.equal(normal.prepare("ses_normal", normalState, [pro, "openrouter/z-ai/glm-5.3", "openrouter/minimax/minimax-m3"], config).newModel, "openrouter/z-ai/glm-5.3");
});

test("fault-injected retry signals accept transient 429/503 but reject unsafe failures", () => {
  const { canRetry } = retryabilityBundle(patchDist(cleanOmo4194Source()).text);
  const retryOn = [408, 429, 500, 502, 503, 504];
  for (const error of [
    { error: { data: { statusCode: 429, message: "nested rate limit" } } },
    { data: { error: { statusCode: 503, message: "nested unavailable" } } },
    { data: { message: "[503] request queue is full" } },
    { error: { message: "Endpoint is unavailable" } },
  ]) assert.equal(canRetry(error, retryOn), true, JSON.stringify(error));
  for (const error of [
    { data: { statusCode: 400, message: "Endpoint is unavailable" } },
    { statusCode: 401, message: "retryable" },
    { error: { statusCode: 403, message: "[503] request queue is full" } },
    { status: "HTTP 400", message: "Endpoint is unavailable; retrying" },
    { error: { statusCode: "401", message: "retryable endpoint unavailable" } },
    { statusCode: 503, cause: { statusCode: "401" }, message: "Endpoint is unavailable" },
    { name: "ProviderModelNotFoundError", message: "model not found" },
    { name: "MissingApiKeyError", message: "Endpoint is unavailable" },
    { name: "QuotaExceededError", message: "[503] request queue is full" },
  ]) assert.equal(canRetry(error, retryOn), false, JSON.stringify(error));
});

test("per-model rung retries and recovery dispatches stay isolated per root or delegated session", () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  const cases = [
    ["normal", "openrouter/deepseek/deepseek-v4-flash-0731", 2],
    ["normal-private", "openrouter/z-ai/glm-5.3", 1],
    ["normal", "openrouter/google/gemini-3.7-flash", 1],
    ["normal", "openrouter/minimax/minimax-m3", 1],
    ["normal", "subscription-gateway/gpt-5.6-sol", 1],
    ["normal", "openrouter/moonshotai/kimi-k2.7-code", 0],
    ["normal", "openrouter/google/gemini-3.1-pro-preview", 0],
    ["normal", "openrouter/nousresearch/hermes-4-405b", 0],
    ["normal", "openrouter/deepseek/deepseek-v4-pro-0813", 0],
    ["pentest", "openrouter/deepseek/deepseek-v4-flash-0731-zdr-throughput", 3],
    ["pentest", "openrouter/deepseek/deepseek-v4-pro-0813-zdr-throughput", 0],
  ];
  for (const [profile, model, retries] of cases) {
    const { createState, prepare } = fallbackStateMachineBundle(patched, profile);
    for (const sessionID of ["ses_root", "ses_child"]) {
      const state = createState(model);
      for (let index = 0; index < retries; index += 1) {
        assert.equal(prepare(sessionID, state, ["openrouter/deepseek/deepseek-v4-pro-0813"], { max_fallback_attempts: 3, cooldown_seconds: 0 }).sameModelRetry, true, `${profile} ${model} retry ${index + 1}`);
        state.pendingFallbackModel = undefined;
      }
      const next = prepare(sessionID, state, ["openrouter/deepseek/deepseek-v4-pro-0813"], { max_fallback_attempts: 3, cooldown_seconds: 0 });
      assert.notEqual(next.sameModelRetry, true, `${profile} ${model} stops at exact retry limit`);
      assert.ok((state.recoveryDispatchCount ?? 0) <= 4, `${sessionID} never exceeds four recoveries / five total dispatches`);
    }
  }
  const { createState, prepare } = fallbackStateMachineBundle(patched, "normal");
  const bounded = createState("openrouter/deepseek/deepseek-v4-flash-0731");
  for (let index = 0; index < 2; index += 1) { prepare("ses_bound", bounded, ["openrouter/z-ai/glm-5.3"], { max_fallback_attempts: 3, cooldown_seconds: 0 }); bounded.pendingFallbackModel = undefined; }
  prepare("ses_bound", bounded, ["openrouter/z-ai/glm-5.3"], { max_fallback_attempts: 3, cooldown_seconds: 0 }); bounded.pendingFallbackModel = undefined;
  assert.equal(prepare("ses_bound", bounded, ["openrouter/z-ai/glm-5.3"], { max_fallback_attempts: 3, cooldown_seconds: 0 }).sameModelRetry, true);
  bounded.pendingFallbackModel = undefined;
  assert.equal(prepare("ses_bound", bounded, ["openrouter/z-ai/glm-5.3"], { max_fallback_attempts: 3, cooldown_seconds: 0 }).maxDispatchesReached, true);
});

test("every profile rejects fatal nested errors before retrying or transitioning", () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  const normal = retryabilityBundle(patched, "normal");
  const pentest = retryabilityBundle(patched, "pentest");
  for (const policy of [normal, pentest]) {
    assert.equal(policy.canRetryStatus(true, "HTTP 403 endpoint unavailable", [429, 503]), false, "403 takes absolute precedence over a retry signal");
    assert.equal(policy.canRetry({ error: { statusCode: 403, message: "[503] queue full" } }, [429, 503]), false, "nested 403 cannot become retryable through a nested 503 string");
    assert.equal(policy.canRetry({ error: { statusCode: 402, message: "max price exceeded" }, cause: { statusCode: 503 } }, [429, 503]), false, "nested 402 max-price failure dominates a nested 503");
    assert.equal(policy.canRetry({ error: { statusCode: 404, message: "no provider available" }, cause: { statusCode: 503 } }, [429, 503]), false, "nested 404 no-provider failure dominates a nested 503");
    assert.equal(policy.canRetry({ error: { statusCode: 401, message: "retryable" } }, [429, 503]), false, "nested auth failure is terminal");
    assert.equal(policy.canRetry({ name: "MissingApiKeyError", message: "endpoint unavailable" }, [429, 503]), false, "fatal provider configuration errors are terminal");
    assert.equal(policy.canRetry({ name: "AbortError", message: "retryable" }, [429, 503]), false, "abort is terminal");
    assert.equal(policy.canRetry({ name: "ContextOverflowError", message: "retryable" }, [429, 503]), false, "context overflow is terminal");
    for (const status of [400, 401, 403, 404]) {
      assert.equal(policy.canRetry(`HTTP ${status} endpoint unavailable [503] queue full`, [429, 503]), false, `raw HTTP ${status} dominates a bracketed 503`);
      assert.equal(policy.canRetry({ message: `HTTP ${status} endpoint unavailable [503] queue full` }, [429, 503]), false, `message-only HTTP ${status} dominates a bracketed 503`);
      assert.equal(policy.canRetry({ error: `HTTP ${status} endpoint unavailable [503] queue full` }, [429, 503]), false, `nested error string HTTP ${status} dominates a bracketed 503`);
      assert.equal(policy.canRetry({ cause: `HTTP ${status} endpoint unavailable [503] queue full` }, [429, 503]), false, `nested cause string HTTP ${status} dominates a bracketed 503`);
    }
    assert.equal(policy.canRetry({ error: "provider [503] queue full" }, [429, 503]), true, "mid-message bracketed transient status remains retryable");
    assert.equal(policy.canRetry(new Error("HTTP 403 endpoint unavailable"), [429, 503]), false, "non-enumerable Error.message fatal status is terminal");
    assert.equal(policy.canRetry(new Error("HTTP 503 endpoint unavailable"), [429, 503]), true, "non-enumerable Error.message transient status retries");
    assert.equal(policy.canRetry(new Error("wrapper", { cause: new Error("HTTP 404 no provider") }), [429, 503]), false, "non-enumerable Error.cause fatal status is terminal");
    for (const status of [500, 502, 504]) {
      assert.equal(policy.canRetry({ error: { code: status, message: "provider transient" } }, [408, 425, 429, 500, 502, 503, 504]), true, `nested code ${status} remains retryable after fatal-status priority`);
    }
  }
  assert.equal(normal.canRetry({ error: { statusCode: 503, message: "Endpoint unavailable" } }, [429, 503]), true, "transient 503 remains retryable");
});

test("normal uses the same durable replay and output guards as pentest", () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  assert.match(patched, /OpenConfig strict fallback classifier v20/);
  assert.equal(patched.includes("if (!openConfigPentestFallbackActive()) return isRetryableError(error, retryOnErrors);"), false, "normal cannot bypass strict nested-error classification");
  assert.equal(patched.includes("if (!openConfigPentestFallbackActive()) {\n        const fetchedParts = originalRetryMetadata.parts"), false, "normal cannot synthesize a replay without a durable user message");
  assert.equal(patched.includes("openConfigPentestFallbackActive() && await"), false, "visible assistant output blocks replay in normal too");
  const normal = fallbackStateMachineBundle(patched, "normal");
  const state = normal.createState("openrouter/deepseek/deepseek-v4-flash-0731");
  const config = { same_model_retries_before_fallback: 3, max_fallback_attempts: 3, cooldown_seconds: 0 };
  assert.equal(normal.prepare("ses_normal", state, ["openrouter/fallback"], config, { allowPrimaryRetry: true }).sameModelRetry, true);
  assert.equal(normal.prepare("ses_normal", state, ["openrouter/fallback"], config, { allowPrimaryRetry: true }).duplicate, true, "a pending normal retry cannot be duplicated");
});

test("real message.updated handler never aborts or clears an in-flight retry signal in either profile", async () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  for (const profile of ["normal", "pentest"]) {
    const { handler, calls, deps, sessionID } = messageUpdateHandlerBundle(patched, profile);
    await handler({
      sessionID,
      info: {
        role: "assistant",
        model: "openrouter/primary",
        error: { statusCode: 503, message: "Endpoint is unavailable; retrying" },
      },
    });
    assert.deepEqual(calls, [], `${profile}: duplicate retry signal causes no abort/timeout mutation`);
    assert.equal(deps.sessionRetryInFlight.has(sessionID), true, `${profile}: in-flight retry remains latched`);
  }
});

test("event-driven root and delegated assistant errors block every replay path after semantic output", async () => {
  const patched = patchDist(cleanOmo4194Source()).text;
  const { visible, observe, clear } = visibleOutputBundle(patched);
  const retrySignal = ({ message }) => /retrying|endpoint (?:is )?unavailable/i.test(message ?? "") ? { signal: "retrying" } : undefined;
  const calls = [];
  const ctx = {
    directory: "/tmp",
    client: { session: { messages: async ({ path }) => {
      calls.push(path.id);
      return [{ info: { role: "user" } }];
    } } },
  };
  const check = visible(retrySignal);
  const semanticError = { role: "assistant", error: { statusCode: 503 }, parts: [{ type: "text", text: "I found a real authorization boundary issue." }] };
  assert.equal(await check(ctx, "ses_root", semanticError, semanticError.parts), true, "message.updated root semantic error blocks replay without a stale refetch");
  assert.equal(calls.length, 0);
  assert.equal(await check(ctx, "ses_root"), true, "session.timeout sees the root event's durable semantic-output guard");

  const toolError = { role: "assistant", error: { statusCode: 503 }, parts: [{ type: "tool-call", tool: "bash" }] };
  assert.equal(observe({ sessionID: "ses_delegated_child", info: toolError, part: { sessionID: "ses_delegated_child", type: "tool-call", tool: "bash" } }, retrySignal), true, "message.part.delta latches delegated tool output before persistence");
  assert.equal(await check(ctx, "ses_delegated_child", toolError, toolError.parts), true, "session.error blocks delegated replay from current event parts");
  assert.equal(await check(ctx, "ses_delegated_child"), true, "timeout blocks delegated replay after the emitted tool delta");

  const pureRetry = { role: "assistant", error: { statusCode: 503 }, parts: [{ type: "text", text: "Endpoint is unavailable; retrying" }] };
  assert.equal(await check(ctx, "ses_pure_retry", pureRetry, pureRetry.parts), false, "pure retry-signal text is not semantic output");
  const mixedRetry = { role: "assistant", error: { statusCode: 503 }, parts: [{ type: "text", text: "I found a real authorization flaw. Service unavailable; try again." }] };
  assert.equal(await check(ctx, "ses_mixed_retry", mixedRetry, mixedRetry.parts), true, "semantic text plus retry wording blocks replay");

  observe({ sessionID: "ses_root", info: { role: "user", id: "usr_second_turn" } }, retrySignal);
  assert.equal(await check(ctx, "ses_root"), false, "a new durable user turn resets the root latch");
  clear("ses_delegated_child");
  assert.equal(await check(ctx, "ses_delegated_child"), false, "session cleanup clears the delegated latch");
});

test("actual runtime event handler latches part deltas before the error and timeout races", async () => {
  const { eventHandler, calls, visible } = runtimeEventHandlerBundle(patchDist(cleanOmo4194Source()).text);
  const ctx = { directory: "/tmp", client: { session: { messages: async () => [{ info: { role: "user" } }] } } };
  const checker = visible(({ message }) => /retrying|endpoint (?:is )?unavailable/i.test(message ?? "") ? { signal: "retrying" } : undefined);
  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID: "ses_root", messageID: "asst_root", field: "text", delta: "Authorization flaw confirmed" },
  } });
  assert.equal(await checker(ctx, "ses_root"), true, "part delta wins before unpersisted session.error");
  await eventHandler({ event: { type: "session.error", properties: { sessionID: "ses_root" } } });
  assert.ok(calls.includes("session.error"));
  assert.equal(await checker(ctx, "ses_root"), true, "timeout callback still sees the latched root turn");

  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID: "ses_split_retry", messageID: "asst_split_retry", field: "text", delta: "Endpoint is " },
  } });
  assert.equal(await checker(ctx, "ses_split_retry"), false, "a retry-signal prefix remains provisional until its text is complete");
  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID: "ses_split_retry", messageID: "asst_split_retry", field: "text", delta: "unavailable; retrying" },
  } });
  assert.equal(await checker(ctx, "ses_split_retry"), false, "split exact pure retry signal never creates a semantic-output latch");

  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID: "ses_split_mixed", messageID: "asst_split_mixed", field: "text", delta: "Endpoint is " },
  } });
  assert.equal(await checker(ctx, "ses_split_mixed"), false, "mixed text remains provisional while it is still a retry-only prefix");
  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID: "ses_split_mixed", messageID: "asst_split_mixed", field: "text", delta: "unavailable; retrying. Authorization flaw confirmed" },
  } });
  assert.equal(await checker(ctx, "ses_split_mixed"), true, "mixed split text latches as soon as the completed buffer is no longer pure retry output");

  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID: "ses_completed_part", messageID: "asst_completed_part", partID: "prt_completed_text", field: "text", delta: "Endpoint is " },
  } });
  await eventHandler({ event: {
    type: "message.part.updated",
    properties: { part: { id: "prt_completed_text", sessionID: "ses_completed_part", messageID: "asst_completed_part", type: "text", text: "Endpoint is unavailable; retrying" } },
  } });
  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID: "ses_completed_part", messageID: "asst_completed_part", partID: "prt_completed_text", field: "text", delta: "Endpoint is " },
  } });
  assert.equal(await checker(ctx, "ses_completed_part"), false, "matching top-level delta partID and completed part.id discard stale buffered text");

  await eventHandler({ event: {
    type: "message.part.updated",
    properties: { part: { sessionID: "ses_child", messageID: "asst_child", type: "text", text: "Endpoint is unavailable; retrying" } },
  } });
  assert.equal(await checker(ctx, "ses_child"), false, "pure retry-only child delta does not latch");
  await eventHandler({ event: {
    type: "message.part.updated",
    properties: { part: { sessionID: "ses_child", messageID: "asst_child_tool", type: "tool-call" } },
  } });
  assert.equal(await checker(ctx, "ses_child"), true, "tool update without info.role latches");
  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID: "ses_reasoning", messageID: "asst_reasoning", field: "reasoning", delta: "I verified the bypass." },
  } });
  assert.equal(await checker(ctx, "ses_reasoning"), true, "reasoning delta without info.role latches");
});

test("replayed durable user events preserve recovery state and output latch until a distinct turn resets both", async () => {
  const { eventHandler, eventDeps, visible } = runtimeEventHandlerBundle(patchDist(cleanOmo4194Source()).text);
  const sessionID = "ses_replayed_user_turn";
  const recoveryState = { recoveryDispatchCount: 4, rungRetryCount: 2 };
  const ctx = { directory: "/tmp", client: { session: { messages: async () => [{ info: { role: "user" } }] } } };
  const checker = visible(({ message }) => /retrying|endpoint (?:is )?unavailable/i.test(message ?? "") ? { signal: "retrying" } : undefined);
  eventDeps.sessionStates.set(sessionID, recoveryState);
  const userEvent = messageID => eventHandler({ event: {
    type: "message.updated",
    properties: { sessionID, info: { role: "user", id: messageID } },
  } });

  await userEvent("usr_durable_1");
  // A new durable turn intentionally starts clean; restore the state as the
  // message handler would after the initial dispatch, then replay that event.
  eventDeps.sessionStates.set(sessionID, recoveryState);
  await eventHandler({ event: {
    type: "message.part.delta",
    properties: { sessionID, messageID: "asst_semantic", field: "text", delta: "A semantic finding was produced." },
  } });
  assert.equal(await checker(ctx, sessionID), true, "semantic output latches the durable user turn");
  await userEvent("usr_durable_1");
  assert.equal(eventDeps.sessionStates.get(sessionID), recoveryState, "same message.updated replay keeps the bounded recovery counter");
  assert.equal(eventDeps.sessionStates.get(sessionID).recoveryDispatchCount, 4, "replay cannot reopen a fifth recovery / sixth dispatch");
  assert.equal(await checker(ctx, sessionID), true, "same durable user replay preserves strict visible-output and dedup latches");

  await userEvent("usr_durable_2");
  assert.equal(eventDeps.sessionStates.has(sessionID), false, "only a distinct durable user message starts a new session-turn state");
  assert.equal(await checker(ctx, sessionID), false, "distinct durable user turn clears the semantic-output latch");
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
