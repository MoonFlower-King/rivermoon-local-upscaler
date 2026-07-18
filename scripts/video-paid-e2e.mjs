#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const confirmPhrase = "I_UNDERSTAND_THIS_SUBMITS_PAID_VIDEO_JOBS";
const videoBaseUrl = "https://video.rivermoon7.com";
const contractUrl = `${videoBaseUrl}/v1/video/contract`;
const retryDelaysMs = [3000, 8000];
const pollIntervalMs = 3500;
const maxPollTransientErrors = 5;
const defaultExecutionTimeoutMs = 45 * 60 * 1000;
const defaultRequestTimeoutMs = 120_000;
const defaultDownloadTimeoutMs = 5 * 60 * 1000;

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

const dryRun = args.has("--dry-run") || envFlag("RIVERMOON_PAID_VIDEO_E2E_DRY_RUN");

const protocolModulePath = path.join(root, "dist", "main", "cloud", "video-protocol.js");
const urlModulePath = path.join(root, "dist", "main", "cloud", "video-url.js");
const relayModulePath = path.join(root, "dist", "main", "cloud", "relay-protocol.js");

if (!fs.existsSync(protocolModulePath) || !fs.existsSync(urlModulePath) || !fs.existsSync(relayModulePath)) {
  console.error("[FAIL] dist video modules are missing. Run npm run build first.");
  process.exit(1);
}

const {
  buildVideoJobRequestPayload,
  parseUploadedVideoSource,
  parseVideoContract,
  parseVideoJobResponse,
  validateVideoParamsAgainstContract,
  validateVideoSourceFileContent,
  validateVideoSourceFileMeta
} = await importFresh(protocolModulePath);
const {
  extensionFromVideoResponse,
  isHttpsVideoGatewayUrl,
  redactVideoUrlForLog,
  resolveVideoDownloadPlan,
  validateVideoDownloadHeaders,
  validateVideoFileHeader,
  VIDEO_DOWNLOAD_MAX_BYTES
} = await importFresh(urlModulePath);
const { RelayError, classifyRelayError, isTransientRelayError } = await importFresh(relayModulePath);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[FAIL] ${redactForOutput(message)}`);
  process.exit(1);
}

async function main() {
  const key = readKey();
  const mode = readMode();
  const prompt = readPrompt();
  const outputDir = path.resolve(process.env.RIVERMOON_PAID_VIDEO_E2E_OUTPUT_DIR || path.join(root, "paid-e2e-output"));

  if (!dryRun) {
    if (!key) throw new Error("Missing RiverMoon key. Set RIVERMOON_API_KEY, RIVERMOON_RELAY_KEY, or RIVERMOON_KEY.");
    if (process.env.RIVERMOON_PAID_VIDEO_E2E_CONFIRM !== confirmPhrase) {
      throw new Error(`Paid E2E requires RIVERMOON_PAID_VIDEO_E2E_CONFIRM=${confirmPhrase}`);
    }
  }

  console.log(`RiverMoon paid video E2E ${dryRun ? "dry-run" : "PAID RUN"}: ${mode}`);
  if (!dryRun) {
    console.warn("[WARN] This run will submit a real video job and may charge the configured account.");
  }

  const contractPayload = await requestJson(contractUrl, null, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(Number(process.env.RIVERMOON_PAID_VIDEO_E2E_CONTRACT_TIMEOUT_MS || 15_000))
  });
  const contract = parseVideoContract(contractPayload, Date.now(), "https");
  if (!contract.ok) throw new Error(contract.error || "Video contract is not usable.");
  const model = chooseModel(contract, mode, readReferences(mode).paths.length);
  const referenceSelection = readReferences(mode);
  const params = buildParams(contract, model, mode, prompt, referenceSelection);
  const validation = validateVideoParamsAgainstContract(params, contract);
  if (!validation.ok) throw new Error(validation.error);
  params.requestEndpoint = validation.requestEndpoint;

  printPlan(contract, model, params, validation.estimatedCostUsd, outputDir);
  if (dryRun) {
    console.log(
      "[PASS] Dry-run validated contract and local parameters. No Key was required and no job was submitted."
    );
    return;
  }

  const abort = AbortSignal.timeout(
    Number(process.env.RIVERMOON_PAID_VIDEO_E2E_TIMEOUT_MS || defaultExecutionTimeoutMs)
  );
  const clientRequestId = `desktop-paid-e2e-${Date.now()}`;
  const sources = await uploadSources(params.referencePaths, params.referenceTypes, key, abort);
  const submitted = await submitJob(params, sources, clientRequestId, key, abort);
  if (!submitted.jobId) throw new Error("Video service did not return job_id.");
  console.log(
    `[INFO] Submitted remote job: job_id=${submitted.jobId} request_id=${submitted.requestId ?? "-"} client_request_id=${clientRequestId}`
  );
  const finalJob = await waitForJob(submitted.jobId, key, abort, submitted);
  const outputPath = await downloadCompletedVideo(finalJob, key, abort, outputDir);
  const stat = await fsp.stat(outputPath);
  console.log(`[PASS] Paid video job succeeded: job_id=${finalJob.jobId}`);
  console.log(`[PASS] Video downloaded: ${outputPath} (${stat.size} bytes)`);
  console.log(
    `[INFO] Billing flags: charged=${String(finalJob.charged)} refunded=${String(finalJob.refunded)} cost_usd=${finalJob.costUsd ?? "-"}`
  );
}

function printHelp() {
  console.log(`RiverMoon paid video E2E

This script is a manual release gate. It can submit real paid video jobs.
It is not part of npm run release:verify and never runs without an explicit confirmation phrase.

Non-billing dry-run:
  npm run build
  node scripts/video-paid-e2e.mjs --dry-run

Paid text-to-video:
  set RIVERMOON_API_KEY=sk-...
  set RIVERMOON_PAID_VIDEO_E2E_CONFIRM=${confirmPhrase}
  set RIVERMOON_PAID_VIDEO_E2E_MODE=text_to_video
  npm run video:paid-e2e

Paid image-to-video:
  set RIVERMOON_PAID_VIDEO_E2E_MODE=image_to_video
  set RIVERMOON_PAID_VIDEO_E2E_SOURCE_PATHS=C:\\path\\reference.png
  npm run video:paid-e2e

Paid multi-reference:
  set RIVERMOON_PAID_VIDEO_E2E_MODE=reference_to_video
  set RIVERMOON_PAID_VIDEO_E2E_SOURCE_PATHS=C:\\path\\character.png;C:\\path\\style.png
  set RIVERMOON_PAID_VIDEO_E2E_REFERENCE_TYPES=character,style
  npm run video:paid-e2e

Environment:
  RIVERMOON_API_KEY / RIVERMOON_RELAY_KEY / RIVERMOON_KEY
  RIVERMOON_PAID_VIDEO_E2E_CONFIRM=${confirmPhrase}
  RIVERMOON_PAID_VIDEO_E2E_MODE=text_to_video|image_to_video|reference_to_video|first_last_frame
  RIVERMOON_PAID_VIDEO_E2E_MODEL=optional model id
  RIVERMOON_PAID_VIDEO_E2E_PROMPT=optional prompt
  RIVERMOON_PAID_VIDEO_E2E_SOURCE_PATHS=semicolon-separated local image paths
  RIVERMOON_PAID_VIDEO_E2E_REFERENCE_TYPES=comma-separated reference types
  RIVERMOON_PAID_VIDEO_E2E_OUTPUT_DIR=optional output directory
`);
}

function readKey() {
  return (process.env.RIVERMOON_API_KEY || process.env.RIVERMOON_RELAY_KEY || process.env.RIVERMOON_KEY || "").trim();
}

function readMode() {
  const mode = (process.env.RIVERMOON_PAID_VIDEO_E2E_MODE || "text_to_video").trim();
  if (!["text_to_video", "image_to_video", "reference_to_video", "first_last_frame"].includes(mode)) {
    throw new Error(`Unsupported RIVERMOON_PAID_VIDEO_E2E_MODE: ${mode}`);
  }
  return mode;
}

function readPrompt() {
  return (
    process.env.RIVERMOON_PAID_VIDEO_E2E_PROMPT ||
    "A short cinematic shot of moonlight over a calm river, gentle camera movement, clean composition"
  )
    .trim()
    .slice(0, 8000);
}

function readReferences(mode) {
  if (mode === "text_to_video") return { paths: [], types: [] };
  const paths = (process.env.RIVERMOON_PAID_VIDEO_E2E_SOURCE_PATHS || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
  const types = (process.env.RIVERMOON_PAID_VIDEO_E2E_REFERENCE_TYPES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return { paths, types };
}

function buildParams(contract, model, mode, prompt, references) {
  const duration = Number(process.env.RIVERMOON_PAID_VIDEO_E2E_DURATION || model.defaultDuration || model.durations[0]);
  const referenceTypes = chooseReferenceTypes(model, mode, references.paths.length, references.types);
  return {
    model: model.id,
    prompt,
    endpoint: mode,
    requestEndpoint: model.requestEndpoints?.[mode] ?? mode,
    aspectRatio: process.env.RIVERMOON_PAID_VIDEO_E2E_ASPECT_RATIO || model.defaultAspectRatio || model.aspectRatios[0],
    duration,
    resolution: process.env.RIVERMOON_PAID_VIDEO_E2E_RESOLUTION || model.defaultResolution || model.resolutions[0],
    referencePaths: references.paths,
    referenceType: referenceTypes[0] ?? "ordinary",
    referenceTypes
  };
}

function chooseModel(contract, mode, referenceCount) {
  const requested = (process.env.RIVERMOON_PAID_VIDEO_E2E_MODEL || "").trim();
  const candidates = contract.models.filter((model) => model.enabled && model.endpoints.includes(mode));
  const model = requested
    ? candidates.find((item) => item.id === requested)
    : (candidates.find((item) => item.primary) ??
      candidates.find((item) => item.id === contract.defaultModelId) ??
      candidates[0]);
  if (!model) throw new Error(`No enabled production model supports ${mode}.`);
  if (referenceCount > model.maxReferences && mode !== "text_to_video") {
    throw new Error(`Selected model ${model.id} supports at most ${model.maxReferences} reference image(s).`);
  }
  return model;
}

function chooseReferenceTypes(model, mode, count, requestedTypes) {
  if (mode === "text_to_video" || count === 0) return [];
  if (mode === "first_last_frame") {
    return Array.from({ length: count }, (_, index) => {
      if (index === 0) return "first_frame";
      if (index === 1) return "last_frame";
      return requestedTypes[index] || model.referenceTypes[0] || "ordinary";
    });
  }
  return Array.from({ length: count }, (_, index) => {
    const requested = requestedTypes[index];
    if (requested && model.referenceTypes.includes(requested)) return requested;
    if (model.referenceTypes.includes("ordinary")) return "ordinary";
    return model.referenceTypes[0] || "ordinary";
  });
}

function printPlan(contract, model, params, estimatedCostUsd, outputDir) {
  console.log(`[INFO] Contract models=${contract.models.length} source=${contract.source}`);
  console.log(`[INFO] Mode=${params.endpoint} model=${model.id} request_endpoint=${params.requestEndpoint}`);
  console.log(`[INFO] Ratio=${params.aspectRatio} duration=${params.duration}s resolution=${params.resolution}`);
  console.log(`[INFO] Reference count=${params.referencePaths.length} types=${params.referenceTypes.join(",") || "-"}`);
  console.log(`[INFO] Estimated cost USD=${estimatedCostUsd ?? "-"}`);
  console.log(`[INFO] Output directory=${outputDir}`);
}

async function uploadSources(paths, types, key, signal) {
  const sources = [];
  for (const [index, sourcePath] of paths.entries()) {
    const source = await uploadSource(sourcePath, types[index] || "ordinary", key, signal);
    sources.push(source);
  }
  return sources;
}

async function uploadSource(sourcePath, referenceType, key, signal) {
  const stat = await fsp.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Reference image is not readable: ${path.basename(sourcePath)}`);
  const metaError = validateVideoSourceFileMeta(sourcePath, stat.size);
  if (metaError) throw new Error(metaError);
  const buffer = await fsp.readFile(sourcePath);
  const contentError = validateVideoSourceFileContent(sourcePath, buffer);
  if (contentError) throw new Error(contentError);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const body = new FormData();
      body.append(
        "file",
        new Blob([new Uint8Array(buffer)], { type: mimeFromPath(sourcePath) }),
        path.basename(sourcePath)
      );
      body.append("reference_type", referenceType);
      const payload = await requestJson(`${videoBaseUrl}/v1/video/source-cache`, key, {
        method: "POST",
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(defaultRequestTimeoutMs)])
      });
      const source = parseUploadedVideoSource(payload);
      if (!source.sourceId && !source.sourceUrl)
        throw new RelayError("bad-response", "Video source-cache returned no source id.");
      console.log(`[PASS] Uploaded reference ${indexLabel(attempt)}: ${path.basename(sourcePath)}`);
      return source;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || signal.aborted || !isTransientRelayError(error)) throw error;
      console.warn(`[WARN] Reference upload transient failure; retrying in ${delayMs / 1000}s.`);
      await delay(delayMs, signal);
    }
  }
}

async function submitJob(params, sources, clientRequestId, key, signal) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const payload = await requestJson(`${videoBaseUrl}/v1/video/jobs`, key, {
        method: "POST",
        body: JSON.stringify(buildVideoJobRequestPayload(params, sources, clientRequestId)),
        signal: AbortSignal.any([signal, AbortSignal.timeout(defaultRequestTimeoutMs)])
      });
      return parseVideoJobResponse(payload);
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || signal.aborted || !isTransientRelayError(error)) throw error;
      console.warn(`[WARN] Submit transient failure; retrying in ${delayMs / 1000}s.`);
      await delay(delayMs, signal);
    }
  }
}

async function waitForJob(jobId, key, signal, initial) {
  let current = initial;
  let transientErrors = 0;
  while (!["succeeded", "failed", "cancelled", "expired"].includes(current.status)) {
    await delay(pollIntervalMs, signal);
    try {
      const payload = await requestJson(`${videoBaseUrl}/v1/video/jobs/${encodeURIComponent(jobId)}`, key, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      });
      transientErrors = 0;
      current = parseVideoJobResponse(payload, current);
      console.log(
        `[INFO] Remote status=${current.status} progress=${current.progress ?? "-"} message=${shortMessage(current.message)}`
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (transientErrors < maxPollTransientErrors && isTransientRelayError(error)) {
        transientErrors += 1;
        console.warn(`[WARN] Poll transient failure (${transientErrors}/${maxPollTransientErrors}); continuing.`);
        continue;
      }
      throw error;
    }
  }
  if (current.status !== "succeeded") {
    throw new Error(`Remote job ended as ${current.status}: ${shortMessage(current.errorMessage || current.message)}`);
  }
  if (current.dryRun) throw new Error("Remote job reported dry_run and did not produce a downloadable video.");
  return current;
}

async function downloadCompletedVideo(job, key, signal, outputDir) {
  const plan = resolveVideoDownloadPlan(job.downloadUrl || job.contentUrl || job.outputUrl, job.jobId);
  if (!plan.ok) throw new Error(plan.error);
  let lastError = null;
  for (const request of plan.requests) {
    try {
      console.log(`[INFO] Download candidate: ${redactVideoUrlForLog(request.url)}`);
      return await downloadVideo(request.url, request.attachAuth ? key : null, signal, outputDir, job.jobId);
    } catch (error) {
      lastError = error;
      console.warn(
        `[WARN] Download candidate failed: ${redactForOutput(error instanceof Error ? error.message : String(error))}`
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Video download failed.");
}

async function downloadVideo(url, key, signal, outputDir, jobId) {
  const response = await request(url, key, {
    allowExternalRedirect: true,
    signal: AbortSignal.any([signal, AbortSignal.timeout(defaultDownloadTimeoutMs)])
  });
  const contentType = response.headers.get("Content-Type");
  const headerValidation = validateVideoDownloadHeaders(contentType, response.headers.get("Content-Length"));
  if (!headerValidation.ok) throw new Error(headerValidation.error);
  if (!response.body) throw new Error("Video response had no body.");
  await fsp.mkdir(outputDir, { recursive: true });
  const ext = extensionFromVideoResponse(url, contentType);
  const target = uniquePath(
    path.join(outputDir, `${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}_${safeName(jobId)}${ext}`)
  );
  const tmpPath = `${target}.download`;
  await fsp.rm(tmpPath, { force: true }).catch(() => {});
  const file = fs.createWriteStream(tmpPath);
  let received = 0;
  const header = [];
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const buffer = Buffer.from(chunk);
      if (header.length < 16) header.push(...buffer.subarray(0, 16 - header.length));
      received += buffer.length;
      if (received > VIDEO_DOWNLOAD_MAX_BYTES) throw new Error("Video exceeds 2GB.");
      await new Promise((resolve, reject) => file.write(buffer, (error) => (error ? reject(error) : resolve())));
    }
    await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
    if (received <= 0) throw new Error("Video download was empty.");
    const fileValidation = validateVideoFileHeader(Uint8Array.from(header), contentType);
    if (!fileValidation.ok) throw new Error(fileValidation.error);
    await fsp.rename(tmpPath, target);
    return target;
  } catch (error) {
    file.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function requestJson(url, key, init = {}) {
  const response = await request(url, key, init);
  try {
    return await response.json();
  } catch {
    throw new RelayError("bad-response", "Video service returned an unparsable JSON response.");
  }
}

async function request(url, key, init = {}, redirectCount = 0) {
  if (key && !isHttpsVideoGatewayUrl(url)) {
    throw new RelayError("auth", "Authenticated video requests must use the HTTPS RiverMoon video gateway.");
  }
  let response;
  try {
    response = await fetch(url, {
      ...withoutCustomInit(init),
      redirect: "manual",
      headers: headersFor(init, key)
    });
  } catch (error) {
    if (error instanceof DOMException) throw error;
    throw new RelayError("network", "Unable to connect to video service.");
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirectCount >= 3) throw new RelayError("bad-response", "Video service redirected too many times.");
    const nextUrl = redirectTarget(response.headers.get("Location"), url);
    const method = String(init.method || "GET").toUpperCase();
    if (!nextUrl || (method !== "GET" && method !== "HEAD")) {
      throw new RelayError("bad-response", "Video service returned an unsafe redirect.");
    }
    const nextIsGateway = isHttpsVideoGatewayUrl(nextUrl);
    if (key && !nextIsGateway && init.allowExternalRedirect !== true) {
      throw new RelayError("bad-response", "Video service returned an unsafe redirect.");
    }
    return request(nextUrl, key && nextIsGateway ? key : null, init, redirectCount + 1);
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw classifyRelayError(response.status, bodyText);
  }
  return response;
}

function withoutCustomInit(init) {
  const { allowExternalRedirect: _allowExternalRedirect, headers: _headers, ...rest } = init;
  return rest;
}

function headersFor(init, key) {
  const headers = { ...(init.headers || {}) };
  for (const header of Object.keys(headers)) {
    if (header.toLowerCase() === "authorization") delete headers[header];
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  if (
    typeof init.body === "string" &&
    !Object.keys(headers).some((header) => header.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function redirectTarget(location, currentUrl) {
  if (!location) return null;
  try {
    const url = new URL(location, currentUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const parsed = path.parse(target);
  for (let index = 2; ; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function safeName(value) {
  return String(value || "video")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .slice(0, 80);
}

function shortMessage(value) {
  if (!value) return "-";
  return redactForOutput(String(value)).slice(0, 120);
}

function redactForOutput(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._:-]+/gi, "Bearer [key]")
    .replace(/\bsk-[A-Za-z0-9._:-]{8,}/gi, "sk-***")
    .replace(/([?&](?:signature|token|key|X-Amz-Signature)=)[^&\s]+/gi, "$1...");
}

function envFlag(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function importFresh(filePath) {
  return import(`${pathToFileURL(filePath).href}?t=${Date.now()}`);
}

function indexLabel(index) {
  return index === 0 ? "initial attempt" : `retry ${index}`;
}
