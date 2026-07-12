#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolModulePath = path.join(root, "dist", "main", "cloud", "video-protocol.js");
const contractUrl = new URL(
  process.env.RIVERMOON_VIDEO_CONTRACT_URL ?? "https://video.rivermoon7.com/v1/video/contract"
);
const timeoutMs = Number(process.env.RIVERMOON_VIDEO_CONTRACT_TIMEOUT_MS ?? 15_000);

const passes = [];
const warnings = [];
const failures = [];

function pass(message) {
  passes.push(message);
}

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringArray(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list.map((item) => String(item).trim()).filter(Boolean);
}

function modelId(raw) {
  const record = asRecord(raw) ?? {};
  return [record.model, record.public_name, record.internal_name, record.id, record.name].find(
    (value) => typeof value === "string" && value.trim()
  );
}

function rawModels(payload) {
  const rootRecord = asRecord(payload) ?? {};
  if (Array.isArray(rootRecord.models)) return rootRecord.models.filter((item) => asRecord(item));
  if (Array.isArray(rootRecord.video_models)) return rootRecord.video_models.filter((item) => asRecord(item));
  if (Array.isArray(rootRecord.data)) return rootRecord.data.filter((item) => asRecord(item));
  if (asRecord(rootRecord.families)) {
    return Object.values(rootRecord.families).flatMap((family) => {
      const familyRecord = asRecord(family);
      if (Array.isArray(family)) return family.filter((item) => asRecord(item));
      if (Array.isArray(familyRecord?.models)) return familyRecord.models.filter((item) => asRecord(item));
      return [];
    });
  }
  return [];
}

function endpointCounts(models) {
  return models.reduce(
    (acc, model) => {
      for (const endpoint of model.endpoints) acc[endpoint] = (acc[endpoint] ?? 0) + 1;
      return acc;
    },
    { text_to_video: 0, image_to_video: 0, reference_to_video: 0, first_last_frame: 0 }
  );
}

function unique(values) {
  return Array.from(new Set(values));
}

function chooseValidationModel(models, endpoint, minReferences = 0) {
  return models.find(
    (model) => model.endpoints.includes(endpoint) && model.maxReferences >= minReferences && model.aspectRatios[0]
  );
}

function sampleParams(model, endpoint, referencePaths = [], referenceTypes = []) {
  return {
    model: model.id,
    prompt: "contract smoke test prompt, no job submission",
    endpoint,
    requestEndpoint: model.requestEndpoints?.[endpoint] ?? endpoint,
    aspectRatio: model.defaultAspectRatio ?? model.aspectRatios[0],
    duration: model.defaultDuration ?? model.durations[0],
    resolution: model.defaultResolution ?? model.resolutions[0],
    referencePaths,
    referenceType: referenceTypes[0] ?? "ordinary",
    referenceTypes
  };
}

function validateSample(label, validateVideoParamsAgainstContract, params, contract) {
  const result = validateVideoParamsAgainstContract(params, contract);
  assert(result.ok, `${label} params validate against production contract`);
  if (result.ok && params.requestEndpoint && result.requestEndpoint !== params.requestEndpoint) {
    fail(
      `${label} request endpoint changed unexpectedly: expected ${params.requestEndpoint}, got ${result.requestEndpoint}`
    );
  }
}

function topLevelReferenceTypes(payload) {
  const rootRecord = asRecord(payload) ?? {};
  const raw = rootRecord.reference_types ?? rootRecord.supported_reference_types;
  const list = Array.isArray(raw) ? raw : [];
  return unique(
    list
      .map((item) => {
        const record = asRecord(item);
        return record ? record.id : item;
      })
      .filter((value) => typeof value === "string" && value.trim())
  );
}

async function main() {
  if (!fs.existsSync(protocolModulePath)) {
    fail("dist/main/cloud/video-protocol.js is missing; run npm run build before this smoke test.");
  }
  if (contractUrl.protocol !== "https:") {
    fail("video contract smoke requires HTTPS.");
  }
  if (contractUrl.username || contractUrl.password || contractUrl.search) {
    fail("video contract smoke URL must not contain credentials or query parameters.");
  }
  if (failures.length > 0) return;

  const { parseVideoContract, validateVideoParamsAgainstContract } = await import(
    `${pathToFileUrl(protocolModulePath).href}?t=${Date.now()}`
  );

  console.log(`RiverMoon video contract smoke: ${contractUrl.origin}${contractUrl.pathname}`);
  const response = await fetch(contractUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  assert(response.ok, `public contract returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    pass("public contract response is JSON");
  } else {
    warn(`public contract content-type is ${contentType || "missing"}; JSON parsing will still be attempted.`);
  }

  const payload = await response.json();
  const contract = parseVideoContract(payload, Date.now());
  const enabledModels = contract.models.filter((model) => model.enabled);
  const counts = endpointCounts(enabledModels);
  const refs = topLevelReferenceTypes(payload);
  const version = asRecord(payload)?.contract_version ?? "unknown";

  assert(contract.ok, "parsed contract is usable");
  assert(contract.models.length > 0, `parsed contract includes models (${contract.models.length})`);
  assert(enabledModels.length > 0, `parsed contract includes enabled models (${enabledModels.length})`);
  assert(counts.text_to_video > 0, `enabled text_to_video models exist (${counts.text_to_video})`);
  assert(counts.image_to_video > 0, `enabled image_to_video models exist (${counts.image_to_video})`);
  assert(counts.reference_to_video > 0, `enabled reference_to_video models exist (${counts.reference_to_video})`);
  if (counts.first_last_frame > 0) {
    pass(`enabled first_last_frame models exist (${counts.first_last_frame})`);
  } else {
    warn("production contract currently exposes no first_last_frame endpoint; UI must keep this mode contract-gated.");
  }

  for (const requiredReferenceType of ["ordinary", "first_frame", "last_frame", "character", "style"]) {
    if (refs.includes(requiredReferenceType)) {
      pass(`top-level reference type exists: ${requiredReferenceType}`);
    } else {
      warn(`top-level reference type missing: ${requiredReferenceType}`);
    }
  }

  const rawMultiReferenceIds = new Set(
    rawModels(payload)
      .filter((raw) => stringArray(asRecord(raw)?.endpoints ?? asRecord(raw)?.modes).includes("multi_reference"))
      .map(modelId)
      .filter(Boolean)
  );
  const preservedMultiReferenceIds = enabledModels
    .filter((model) => rawMultiReferenceIds.has(model.id))
    .filter((model) => model.requestEndpoints.reference_to_video === "multi_reference")
    .map((model) => model.id);
  if (rawMultiReferenceIds.size > 0) {
    assert(
      preservedMultiReferenceIds.length > 0,
      `multi_reference raw endpoint is preserved (${preservedMultiReferenceIds.length})`
    );
  } else {
    warn("production contract currently has no raw multi_reference endpoint to verify.");
  }

  const textModel = chooseValidationModel(enabledModels, "text_to_video", 0);
  if (textModel) {
    validateSample(
      `text_to_video model ${textModel.id}`,
      validateVideoParamsAgainstContract,
      sampleParams(textModel, "text_to_video"),
      contract
    );
  }

  const imageModel = chooseValidationModel(enabledModels, "image_to_video", 1);
  if (imageModel) {
    const imageReferenceType = imageModel.referenceTypes.includes("ordinary")
      ? "ordinary"
      : imageModel.referenceTypes[0];
    validateSample(
      `image_to_video model ${imageModel.id}`,
      validateVideoParamsAgainstContract,
      sampleParams(imageModel, "image_to_video", ["C:/contract-smoke/reference.png"], [imageReferenceType]),
      contract
    );
  }

  const referenceModel = chooseValidationModel(enabledModels, "reference_to_video", 2);
  if (referenceModel) {
    const referenceTypes = ["ordinary", "style"].map((type) =>
      referenceModel.referenceTypes.includes(type) ? type : referenceModel.referenceTypes[0]
    );
    validateSample(
      `reference_to_video model ${referenceModel.id}`,
      validateVideoParamsAgainstContract,
      sampleParams(
        referenceModel,
        "reference_to_video",
        ["C:/contract-smoke/reference-a.png", "C:/contract-smoke/reference-b.png"],
        referenceTypes
      ),
      contract
    );
  }

  const firstLastModel = chooseValidationModel(enabledModels, "first_last_frame", 2);
  if (firstLastModel) {
    validateSample(
      `first_last_frame model ${firstLastModel.id}`,
      validateVideoParamsAgainstContract,
      sampleParams(
        firstLastModel,
        "first_last_frame",
        ["C:/contract-smoke/first.png", "C:/contract-smoke/last.png"],
        ["first_frame", "last_frame"]
      ),
      contract
    );
  }

  console.log(
    JSON.stringify(
      {
        contract_version: version,
        models: contract.models.length,
        enabled_models: enabledModels.length,
        endpoint_counts: counts,
        top_level_reference_types: refs,
        multi_reference_alias_models: preservedMultiReferenceIds
      },
      null,
      2
    )
  );
}

function pathToFileUrl(filePath) {
  const url = new URL("file:///");
  url.pathname = path.resolve(filePath).replace(/\\/g, "/");
  return url;
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

for (const message of passes) console.log(`[PASS] ${message}`);
for (const message of warnings) console.warn(`[WARN] ${message}`);
for (const message of failures) console.error(`[FAIL] ${message}`);

if (failures.length > 0) {
  console.error(`Video contract smoke failed: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`Video contract smoke passed: ${passes.length} pass(es), ${warnings.length} warning(s).`);
