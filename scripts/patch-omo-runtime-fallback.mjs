#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "OpenConfig runtime-fallback and canonical agent-model patch v7";
const LEGACY_MARKERS = [
  "OpenConfig runtime-fallback primary retry patch v1",
  "OpenConfig runtime-fallback primary retry patch v2",
  "OpenConfig runtime-fallback and canonical agent-model patch v3",
];
const EXPECTED_OMO_VERSION = "4.19.4";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage: node scripts/patch-omo-runtime-fallback.mjs [--check|--apply] [--repo PATH]

Applies OpenConfig's governed runtime patch to the pinned OmO package cache.
The patch adds same-primary retries before model fallback, makes the first
subagent prompt watchdog configurable from OpenConfig-owned environment knobs,
and makes canonical agents.*.models drive task(subagent_type) resolution.
Accepts a fresh pinned dist or upgrades deployed markers v1-v3 only; unknown
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

  if (!text.includes(`      maxPrimaryRetries,`)) {
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

export function applyCanonicalAgentModels(original) {
  return applyDirectTaskAgentModels(applyCentralAgentOverrideModels(removeLegacyNativeBuilderPatches(original)));
}

function assertNoUnsupportedOpenConfigRuntimePatchMarkers(text) {
  const openConfigMarkers = [...new Set(text.match(/OpenConfig runtime-fallback[^\n*]*patch v\d+/g) ?? [])];
  const unsupportedMarkers = openConfigMarkers.filter(marker => marker !== MARKER && !LEGACY_MARKERS.includes(marker));
  if (unsupportedMarkers.length > 0) {
    throw new Error(`Refusing unsupported OpenConfig OmO runtime patch marker(s): ${unsupportedMarkers.join(", ")}. Only fresh dist or deployed v1-v3 upgrades are supported.`);
  }
}

// Canonical route patch follows the existing runtime-fallback patch.
export function patchDist(original) {
  assertNoUnsupportedOpenConfigRuntimePatchMarkers(original);
  if (original.includes(MARKER)) return { text: original, changed: false };
  if (LEGACY_MARKERS.some(marker => original.includes(marker))) {
    const text = `${applyCanonicalAgentModels(applyEnvironmentRuntimeKnobs(original))}\n/* ${MARKER} */\n`;
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

  text = applyCanonicalAgentModels(applyEnvironmentRuntimeKnobs(text));
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
  ];
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
