#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractUrl = "https://img.rivermoon7.com/v1/image/contract";
const protocolModulePath = path.join(root, "dist", "main", "cloud", "image-protocol.js");

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

if (!fs.existsSync(protocolModulePath)) {
  console.error("[FAIL] dist image protocol module is missing. Run npm run build first.");
  process.exit(1);
}

const { parseImageContract, validateImageParamsAgainstContract } = await import(
  `${pathToFileURL(protocolModulePath).href}?t=${Date.now()}`
);

console.log(`RiverMoon image contract smoke: ${contractUrl}`);

let response;
try {
  response = await fetch(contractUrl, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  assert(response.status === 200, `public image contract returned HTTP ${response.status}`);
} catch (error) {
  fail(`public image contract request failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (response?.ok) {
  const contentType = response.headers.get("Content-Type") || "";
  assert(contentType.includes("application/json"), "public image contract response is JSON");
  const payload = await response.json();
  const contract = parseImageContract(payload, Date.now());
  const gptImage = contract.models.find((model) => model.publicName === "gpt-image-2");
  const visibleModels = contract.models.filter((model) => model.visible);
  console.log(
    JSON.stringify(
      {
        contract_version: contract.contractVersion,
        models: contract.models.length,
        visible_models: visibleModels.length,
        default_model: contract.defaultModelId,
        gpt_image_2: gptImage
          ? {
              sizes: gptImage.sizes,
              qualities: gptImage.qualities,
              output_formats: gptImage.outputFormats,
              endpoints: gptImage.endpoints,
              max_reference_images: gptImage.maxReferences,
              size_modes: gptImage.sizeModes
            }
          : null
      },
      null,
      2
    )
  );
  assert(contract.ok, "parsed image contract is usable");
  assert(contract.models.length >= 1, `parsed contract includes models (${contract.models.length})`);
  assert(visibleModels.length >= 1, `parsed contract includes visible models (${visibleModels.length})`);
  assert(Boolean(gptImage), "gpt-image-2 exists in image contract");
  if (gptImage) {
    assert(gptImage.sizes.includes("3840x2160"), "gpt-image-2 supports 3840x2160");
    assert(gptImage.sizes.includes("2160x3840"), "gpt-image-2 supports 2160x3840");
    assert(gptImage.qualities.includes("high"), "gpt-image-2 supports high quality");
    assert(gptImage.outputFormats.includes("png"), "gpt-image-2 supports PNG output");
    assert(gptImage.outputFormats.includes("jpeg"), "gpt-image-2 supports JPEG output");
    assert(gptImage.endpoints.includes("generation"), "gpt-image-2 supports generation");
    assert(
      gptImage.endpoints.includes("edit") || gptImage.endpoints.includes("reference_edit"),
      "gpt-image-2 supports reference edit"
    );
    assert(gptImage.maxReferences >= 1, `gpt-image-2 supports reference images (${gptImage.maxReferences})`);
    assert(gptImage.sizeModes.includes("native"), "gpt-image-2 supports native size mode");
    const validation = validateImageParamsAgainstContract(
      {
        model: "gpt-image-2",
        prompt: "contract smoke",
        size: "3840x2160",
        count: 1,
        quality: "high",
        outputFormat: "png",
        fitMode: "contain",
        sizeMode: "postprocess",
        referencePaths: []
      },
      contract
    );
    assert(validation.ok, "gpt-image-2 3840x2160 high PNG params validate against production image contract");
  }
  if (!contract.contractVersion) warn("image contract has no contract_version field");
}

for (const message of passes) console.log(`[PASS] ${message}`);
for (const message of warnings) console.warn(`[WARN] ${message}`);
for (const message of failures) console.error(`[FAIL] ${message}`);

if (failures.length > 0) {
  console.error(`Image contract smoke failed: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`Image contract smoke passed: ${passes.length} pass(es), ${warnings.length} warning(s).`);
