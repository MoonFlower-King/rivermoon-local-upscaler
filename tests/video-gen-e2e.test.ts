import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFreshHttpsVideoContract, resumeVideoGeneration, runVideoGeneration } from "../src/main/cloud/video-gen";
import { validateVideoParamsAgainstContract } from "../src/main/cloud/video-protocol";
import type { VideoGenParams } from "../src/main/types";

let testUserData = "";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected app path ${name}`);
      return testUserData;
    }
  }
}));

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const mp4Bytes = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00
]);

async function listFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const children = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) return listFiles(entryPath);
        return [entryPath];
      })
    );
    return children.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("video gateway non-billing e2e", () => {
  beforeEach(async () => {
    testUserData = await fs.mkdtemp(path.join(os.tmpdir(), "rivermoon-video-e2e-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await fs.rm(testUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    testUserData = "";
  });

  it("从 HTTPS 合同到参考图上传、任务提交、视频下载可完整串联", async () => {
    const sourcePath = path.join(testUserData, "reference.png");
    await fs.writeFile(sourcePath, pngBytes);

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "videos_stable_fast" },
            models: [
              {
                model: "videos_stable_fast",
                label: "Stable Fast",
                family: "stable",
                enabled: true,
                endpoints: ["text_to_video", "multi_reference"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 2,
                reference_types: ["ordinary", "style"],
                estimated_price_usd: 0.12
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/source-cache") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(init?.body).toBeInstanceOf(FormData);
          return jsonResponse({ source_id: "src_1" });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(typeof init?.body).toBe("string");
          expect(JSON.parse(init?.body as string)).toMatchObject({
            model: "videos_stable_fast",
            prompt: "camera orbit around the product",
            endpoint: "multi_reference",
            mode: "multi_reference",
            aspect_ratio: "16:9",
            duration: 5,
            resolution: "720p",
            quality: "720p",
            source_ids: ["src_1"],
            source_urls: [],
            reference_type: "style",
            reference_types: { "1": "style" },
            dry_run: false,
            client_request_id: "client_1"
          });
          return jsonResponse({
            job_id: "vjob_1",
            request_id: "req_1",
            client_request_id: "client_1",
            status: "succeeded",
            progress: 100,
            model: "videos_stable_fast",
            endpoint: "multi_reference",
            download_url: "/v1/video/jobs/vjob_1/download",
            cost_usd: 0.12,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "videos_stable_fast",
      prompt: "camera orbit around the product",
      endpoint: "reference_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [sourcePath],
      referenceType: "style",
      referenceTypes: ["style"]
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.12, requestEndpoint: "multi_reference" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const updates: string[] = [];
    const result = await runVideoGeneration(params, "client_1", "test-key", new AbortController().signal, (job) => {
      updates.push(job.status);
    });

    expect(updates).toEqual(["succeeded"]);
    expect(result.job.jobId).toBe("vjob_1");
    expect(result.job.costUsd).toBe(0.12);
    expect(result.job.charged).toBe(true);
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    expect(path.basename(result.outputPath)).toMatch(/vjob_1\.mp4$/);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    await expect(fs.stat(`${result.outputPath}.download`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/source-cache",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download"
    ]);
  });

  it("多参考图视频会保持参考图上传顺序和类型映射", async () => {
    const characterPath = path.join(testUserData, "character.png");
    const stylePath = path.join(testUserData, "style.png");
    await fs.writeFile(characterPath, pngBytes);
    await fs.writeFile(stylePath, pngBytes);

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let uploadCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "reference-video-pro" },
            models: [
              {
                model: "reference-video-pro",
                label: "Reference Video Pro",
                family: "reference",
                enabled: true,
                endpoints: ["multi_reference"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["1080p"],
                max_reference_images: 2,
                reference_types: ["character", "style"],
                estimated_price_usd: 0.2
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/source-cache") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(init?.body).toBeInstanceOf(FormData);
          uploadCount += 1;
          return jsonResponse({ source_id: uploadCount === 1 ? "src_character" : "src_style" });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(uploadCount).toBe(2);
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(JSON.parse(init?.body as string)).toMatchObject({
            model: "reference-video-pro",
            prompt: "combine the character pose with the visual style",
            endpoint: "multi_reference",
            mode: "multi_reference",
            aspect_ratio: "16:9",
            duration: 5,
            resolution: "1080p",
            quality: "1080p",
            source_ids: ["src_character", "src_style"],
            source_urls: [],
            reference_type: "character",
            reference_types: { "1": "character", "2": "style" },
            dry_run: false,
            client_request_id: "client_multi_reference"
          });
          return jsonResponse({
            job_id: "vjob_multi_reference",
            request_id: "req_multi_reference",
            client_request_id: "client_multi_reference",
            status: "succeeded",
            progress: 100,
            model: "reference-video-pro",
            endpoint: "multi_reference",
            download_url: "/v1/video/jobs/vjob_multi_reference/download",
            cost_usd: 0.2,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_multi_reference/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "reference-video-pro",
      prompt: "combine the character pose with the visual style",
      endpoint: "reference_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "1080p",
      referencePaths: [characterPath, stylePath],
      referenceType: "character",
      referenceTypes: ["character", "style"]
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.2, requestEndpoint: "multi_reference" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const result = await runVideoGeneration(params, "client_multi_reference", "test-key", new AbortController().signal);

    expect(result.job.jobId).toBe("vjob_multi_reference");
    expect(result.job.costUsd).toBe(0.2);
    expect(result.job.charged).toBe(true);
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    expect(path.basename(result.outputPath)).toMatch(/vjob_multi_reference\.mp4$/);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/source-cache",
      "https://video.rivermoon7.com/v1/video/source-cache",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_multi_reference/download"
    ]);
  });

  it("图生视频会上传单张参考图并按 image_to_video 提交", async () => {
    const sourcePath = path.join(testUserData, "image-reference.png");
    await fs.writeFile(sourcePath, pngBytes);

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "image-video-fast" },
            models: [
              {
                model: "image-video-fast",
                label: "Image Video Fast",
                family: "image",
                enabled: true,
                endpoints: ["image_to_video"],
                aspect_ratios: ["9:16"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 1,
                reference_types: ["ordinary"],
                estimated_price_usd: 0.14
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/source-cache") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(init?.body).toBeInstanceOf(FormData);
          return jsonResponse({ source_id: "src_image_1" });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(JSON.parse(init?.body as string)).toMatchObject({
            model: "image-video-fast",
            prompt: "animate the product photo with subtle camera motion",
            endpoint: "image_to_video",
            mode: "image_to_video",
            aspect_ratio: "9:16",
            duration: 5,
            resolution: "720p",
            quality: "720p",
            source_ids: ["src_image_1"],
            source_urls: [],
            reference_type: "ordinary",
            reference_types: { "1": "ordinary" },
            dry_run: false,
            client_request_id: "client_image"
          });
          return jsonResponse({
            job_id: "vjob_image",
            request_id: "req_image",
            client_request_id: "client_image",
            status: "succeeded",
            progress: 100,
            model: "image-video-fast",
            endpoint: "image_to_video",
            download_url: "/v1/video/jobs/vjob_image/download",
            cost_usd: 0.14,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_image/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "image-video-fast",
      prompt: "animate the product photo with subtle camera motion",
      endpoint: "image_to_video",
      aspectRatio: "9:16",
      duration: 5,
      resolution: "720p",
      referencePaths: [sourcePath],
      referenceType: "ordinary",
      referenceTypes: ["ordinary"]
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.14, requestEndpoint: "image_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const updates: string[] = [];
    const result = await runVideoGeneration(params, "client_image", "test-key", new AbortController().signal, (job) => {
      updates.push(job.status);
    });

    expect(updates).toEqual(["succeeded"]);
    expect(result.job.jobId).toBe("vjob_image");
    expect(result.job.costUsd).toBe(0.14);
    expect(result.job.charged).toBe(true);
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    expect(path.basename(result.outputPath)).toMatch(/vjob_image\.mp4$/);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/source-cache",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_image/download"
    ]);
  });

  it("参考图上传遇到瞬时错误时会重试后继续提交任务", async () => {
    vi.useFakeTimers();

    const sourcePath = path.join(testUserData, "retry-reference.png");
    await fs.writeFile(sourcePath, pngBytes);

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let uploadCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "image-video-fast" },
            models: [
              {
                model: "image-video-fast",
                label: "Image Video Fast",
                family: "image",
                enabled: true,
                endpoints: ["image_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 1,
                reference_types: ["ordinary"],
                estimated_price_usd: 0.14
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/source-cache") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(init?.body).toBeInstanceOf(FormData);
          uploadCount += 1;
          if (uploadCount === 1) return jsonResponse({ error: "temporary gateway overload" }, 503);
          return jsonResponse({ source_id: "src_retry_1" });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(uploadCount).toBe(2);
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(JSON.parse(init?.body as string)).toMatchObject({
            model: "image-video-fast",
            prompt: "retry source upload before creating the video",
            endpoint: "image_to_video",
            source_ids: ["src_retry_1"],
            client_request_id: "client_upload_retry"
          });
          return jsonResponse({
            job_id: "vjob_upload_retry",
            request_id: "req_upload_retry",
            client_request_id: "client_upload_retry",
            status: "succeeded",
            progress: 100,
            download_url: "/v1/video/jobs/vjob_upload_retry/download",
            cost_usd: 0.14,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_upload_retry/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "image-video-fast",
      prompt: "retry source upload before creating the video",
      endpoint: "image_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [sourcePath],
      referenceType: "ordinary",
      referenceTypes: ["ordinary"]
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.14, requestEndpoint: "image_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const generation = runVideoGeneration(params, "client_upload_retry", "test-key", new AbortController().signal);

    await vi.waitFor(() => expect(uploadCount).toBe(1));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(uploadCount).toBe(2));
    const result = await generation;

    expect(result.job.jobId).toBe("vjob_upload_retry");
    expect(result.job.costUsd).toBe(0.14);
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/source-cache",
      "https://video.rivermoon7.com/v1/video/source-cache",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_upload_retry/download"
    ]);
  });

  it("参考图上传返回无效缓存结果时不会重试也不会提交任务", async () => {
    const sourcePath = path.join(testUserData, "invalid-source-response.png");
    await fs.writeFile(sourcePath, pngBytes);

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "image-video-fast" },
            models: [
              {
                model: "image-video-fast",
                label: "Image Video Fast",
                family: "image",
                enabled: true,
                endpoints: ["image_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 1,
                reference_types: ["ordinary"],
                estimated_price_usd: 0.14
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/source-cache") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(init?.body).toBeInstanceOf(FormData);
          return jsonResponse({ ok: true });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "image-video-fast",
      prompt: "invalid source response should not create a video job",
      endpoint: "image_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [sourcePath],
      referenceType: "ordinary",
      referenceTypes: ["ordinary"]
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.14, requestEndpoint: "image_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    await expect(
      runVideoGeneration(params, "client_invalid_source", "test-key", new AbortController().signal)
    ).rejects.toMatchObject({
      message: "视频服务没有返回参考图缓存地址。"
    });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/source-cache"
    ]);
  });

  it("文生视频会轮询远端状态，并且外部签名下载地址不携带 Key", async () => {
    vi.useFakeTimers();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let pollCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          expect(JSON.parse(init?.body as string)).toMatchObject({
            model: "video-text-fast",
            prompt: "wide shot of a moonlit river",
            endpoint: "text_to_video",
            mode: "text_to_video",
            source_ids: [],
            source_urls: [],
            reference_types: {},
            client_request_id: "client_text"
          });
          return jsonResponse({
            job_id: "vjob_text",
            request_id: "req_text",
            client_request_id: "client_text",
            status: "queued",
            progress: 0
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_text") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          pollCount += 1;
          if (pollCount === 1) {
            return jsonResponse({
              job_id: "vjob_text",
              status: "running",
              progress: "48%",
              message: "progress 48"
            });
          }
          return jsonResponse({
            job_id: "vjob_text",
            status: "succeeded",
            progress: 100,
            download_url: "https://cdn.example.com/out/vjob_text.mp4?signature=abc",
            cost_usd: 0.08,
            charged: true
          });
        }

        if (url === "https://cdn.example.com/out/vjob_text.mp4?signature=abc") {
          expect(headersOf(init).Authorization).toBeUndefined();
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "wide shot of a moonlit river",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const updates: string[] = [];
    const generation = runVideoGeneration(params, "client_text", "test-key", new AbortController().signal, (job) => {
      updates.push(`${job.status}:${job.progress ?? "null"}`);
    });

    await vi.advanceTimersByTimeAsync(3500);
    await vi.advanceTimersByTimeAsync(3500);
    const result = await generation;

    expect(updates).toEqual(["queued:0", "running:48", "succeeded:100"]);
    expect(pollCount).toBe(2);
    expect(result.job.jobId).toBe("vjob_text");
    expect(result.job.costUsd).toBe(0.08);
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_text",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_text",
      "https://cdn.example.com/out/vjob_text.mp4?signature=abc"
    ]);
  });

  it("任务提交遇到瞬时错误时会重试后继续轮询和下载", async () => {
    vi.useFakeTimers();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let submitCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          submitCount += 1;
          if (submitCount === 1) return jsonResponse({ error: "rate limited" }, 429);
          expect(JSON.parse(init?.body as string)).toMatchObject({
            model: "video-text-fast",
            prompt: "retry transient submit before polling",
            endpoint: "text_to_video",
            client_request_id: "client_submit_retry"
          });
          return jsonResponse({
            job_id: "vjob_submit_retry",
            request_id: "req_submit_retry",
            client_request_id: "client_submit_retry",
            status: "succeeded",
            progress: 100,
            download_url: "/v1/video/jobs/vjob_submit_retry/download",
            cost_usd: 0.08,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_submit_retry/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "retry transient submit before polling",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const generation = runVideoGeneration(params, "client_submit_retry", "test-key", new AbortController().signal);

    await vi.waitFor(() => expect(submitCount).toBe(1));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(submitCount).toBe(2));
    const result = await generation;

    expect(result.job.jobId).toBe("vjob_submit_retry");
    expect(result.job.costUsd).toBe(0.08);
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_submit_retry/download"
    ]);
  });

  it("任务提交被参数拒绝时不会重试也不会轮询下载", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({ error: { message: "invalid prompt for upstream model" } }, 400);
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "submit rejected by upstream validation",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    await expect(
      runVideoGeneration(params, "client_submit_rejected", "test-key", new AbortController().signal)
    ).rejects.toMatchObject({
      message: "请求被拒绝：invalid prompt [prompt]"
    });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs"
    ]);
  });

  it("远端状态轮询遇到瞬时错误时会继续等待并下载成功结果", async () => {
    vi.useFakeTimers();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let pollCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_poll_retry",
            request_id: "req_poll_retry",
            client_request_id: "client_poll_retry",
            status: "queued",
            progress: 0
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_poll_retry") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          pollCount += 1;
          if (pollCount === 1) return jsonResponse({ error: "temporary status outage" }, 503);
          return jsonResponse({
            job_id: "vjob_poll_retry",
            status: "succeeded",
            progress: 100,
            download_url: "/v1/video/jobs/vjob_poll_retry/download",
            cost_usd: 0.08,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_poll_retry/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "poll retry should survive a transient status outage",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const updates: string[] = [];
    const generation = runVideoGeneration(
      params,
      "client_poll_retry",
      "test-key",
      new AbortController().signal,
      (job) => {
        updates.push(`${job.status}:${job.progress ?? "null"}`);
      }
    );

    await vi.advanceTimersByTimeAsync(3500);
    await vi.waitFor(() => expect(pollCount).toBe(1));
    await vi.advanceTimersByTimeAsync(3500);
    await vi.waitFor(() => expect(pollCount).toBe(2));
    const result = await generation;

    expect(updates).toEqual(["queued:0", "succeeded:100"]);
    expect(result.job.jobId).toBe("vjob_poll_retry");
    expect(result.job.costUsd).toBe(0.08);
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_poll_retry",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_poll_retry",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_poll_retry/download"
    ]);
  });

  it("远端状态轮询遇到不可重试错误时会停止且不下载", async () => {
    vi.useFakeTimers();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_poll_rejected",
            request_id: "req_poll_rejected",
            client_request_id: "client_poll_rejected",
            status: "queued",
            progress: 0
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_poll_rejected") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({ error: { message: "invalid status request" } }, 400);
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "poll rejected should not download",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const generation = runVideoGeneration(params, "client_poll_rejected", "test-key", new AbortController().signal);
    const rejection = expect(generation).rejects.toMatchObject({
      message: "请求被拒绝：invalid status request"
    });

    await vi.advanceTimersByTimeAsync(3500);
    await rejection;

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_poll_rejected"
    ]);
  });

  it("外部签名下载失败时会回退视频网关下载", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_fallback",
            request_id: "req_fallback",
            client_request_id: "client_fallback",
            status: "succeeded",
            progress: 100,
            download_url: "https://cdn.example.com/out/vjob_fallback.mp4?signature=expired",
            cost_usd: 0.08,
            charged: true
          });
        }

        if (url === "https://cdn.example.com/out/vjob_fallback.mp4?signature=expired") {
          expect(headersOf(init).Authorization).toBeUndefined();
          return jsonResponse({ error: "signed url expired" });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_fallback/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "steady tripod shot of a product reveal",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const result = await runVideoGeneration(params, "client_fallback", "test-key", new AbortController().signal);

    expect(result.job.jobId).toBe("vjob_fallback");
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://cdn.example.com/out/vjob_fallback.mp4?signature=expired",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_fallback/download"
    ]);
  });

  it("恢复已有远端任务时只轮询和下载，不重新提交付费任务", async () => {
    vi.useFakeTimers();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let pollCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_resume") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          pollCount += 1;
          if (pollCount === 1) {
            return jsonResponse({
              job_id: "vjob_resume",
              status: "running",
              progress: 72,
              message: "rendering"
            });
          }
          return jsonResponse({
            job_id: "vjob_resume",
            request_id: "req_resume",
            status: "succeeded",
            progress: 100,
            cost_usd: 0.08,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_resume/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const updates: string[] = [];
    const generation = resumeVideoGeneration("vjob_resume", "test-key", new AbortController().signal, (job) => {
      updates.push(`${job.status}:${job.progress ?? "null"}`);
    });

    await vi.advanceTimersByTimeAsync(3500);
    await vi.advanceTimersByTimeAsync(3500);
    const result = await generation;

    expect(updates).toEqual(["running:null", "running:72", "succeeded:100"]);
    expect(result.job.jobId).toBe("vjob_resume");
    expect(result.job.requestId).toBe("req_resume");
    expect(result.job.costUsd).toBe(0.08);
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/jobs/vjob_resume",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_resume",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_resume/download"
    ]);
    expect(fetchCalls.some((call) => call.url === "https://video.rivermoon7.com/v1/video/source-cache")).toBe(false);
    expect(fetchCalls.some((call) => call.url === "https://video.rivermoon7.com/v1/video/jobs")).toBe(false);
  });

  it("远端任务失败时不下载也不落盘为成功视频", async () => {
    vi.useFakeTimers();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_failed",
            request_id: "req_failed",
            client_request_id: "client_failed",
            status: "queued",
            progress: 0
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_failed") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_failed",
            request_id: "req_failed",
            status: "failed",
            progress: 64,
            error_message: "upstream safety blocked"
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "wide shot that the upstream rejects",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const updates: string[] = [];
    const generation = runVideoGeneration(params, "client_failed", "test-key", new AbortController().signal, (job) => {
      updates.push(`${job.status}:${job.progress ?? "null"}`);
    });
    const rejection = expect(generation).rejects.toMatchObject({ message: "upstream safety blocked" });

    await vi.advanceTimersByTimeAsync(3500);
    await rejection;

    expect(updates).toEqual(["queued:0", "failed:64"]);
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_failed"
    ]);
    await expect(fs.stat(path.join(testUserData, "assets", "videos"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("下载返回伪装二进制的错误体时不落盘且清理临时文件", async () => {
    const badDownloadBytes = new TextEncoder().encode('{"error":"video not ready"}');
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_bad_body",
            request_id: "req_bad_body",
            client_request_id: "client_bad_body",
            status: "succeeded",
            progress: 100,
            download_url: "/v1/video/jobs/vjob_bad_body/download"
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_bad_body/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(badDownloadBytes, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(badDownloadBytes.byteLength)
            }
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_bad_body/content") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(badDownloadBytes, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(badDownloadBytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "bad download body should not become a local video",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    await expect(
      runVideoGeneration(params, "client_bad_body", "test-key", new AbortController().signal)
    ).rejects.toMatchObject({
      message: "视频下载内容是错误响应，不是可保存的视频文件，请稍后恢复同步。"
    });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_bad_body/download",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_bad_body/content"
    ]);
    await expect(listFiles(path.join(testUserData, "assets", "videos"))).resolves.toEqual([]);
  });

  it("视频网关下载重定向到外部 CDN 时不会把 Key 带到外部域名", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_redirect",
            request_id: "req_redirect",
            client_request_id: "client_redirect",
            status: "succeeded",
            progress: 100,
            download_url: "/v1/video/jobs/vjob_redirect/download",
            cost_usd: 0.08,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_redirect/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.example.com/out/vjob_redirect.mp4?signature=redirect" }
          });
        }

        if (url === "https://cdn.example.com/out/vjob_redirect.mp4?signature=redirect") {
          expect(headersOf(init).Authorization).toBeUndefined();
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "clean packshot dolly move",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const result = await runVideoGeneration(params, "client_redirect", "test-key", new AbortController().signal);

    expect(result.job.jobId).toBe("vjob_redirect");
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_redirect/download",
      "https://cdn.example.com/out/vjob_redirect.mp4?signature=redirect"
    ]);
  });

  it("视频网关下载返回不安全重定向时会继续尝试 content fallback", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_bad_redirect",
            request_id: "req_bad_redirect",
            client_request_id: "client_bad_redirect",
            status: "succeeded",
            progress: 100,
            download_url: "/v1/video/jobs/vjob_bad_redirect/download",
            cost_usd: 0.08,
            charged: true
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_bad_redirect/download") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(null, {
            status: 302,
            headers: { Location: "http://cdn.example.com/out/vjob_bad_redirect.mp4?signature=insecure" }
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_bad_redirect/content") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(mp4Bytes, {
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(mp4Bytes.byteLength)
            }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "tracking shot with safe fallback download",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const result = await runVideoGeneration(params, "client_bad_redirect", "test-key", new AbortController().signal);

    expect(result.job.jobId).toBe("vjob_bad_redirect");
    expect(result.outputBytes).toBe(mp4Bytes.byteLength);
    await expect(fs.readFile(result.outputPath)).resolves.toEqual(Buffer.from(mp4Bytes));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_bad_redirect/download",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_bad_redirect/content"
    ]);
  });

  it("认证状态接口重定向到外部域名时会拒绝且不访问外部地址", async () => {
    vi.useFakeTimers();

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return jsonResponse({
            job_id: "vjob_api_redirect",
            request_id: "req_api_redirect",
            client_request_id: "client_api_redirect",
            status: "queued",
            progress: 0
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs/vjob_api_redirect") {
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.example.com/status/vjob_api_redirect.json?signature=abc" }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "status redirect should be rejected",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    const generation = runVideoGeneration(params, "client_api_redirect", "test-key", new AbortController().signal);
    const rejection = expect(generation).rejects.toMatchObject({
      message: "视频服务返回了不安全的重定向，请稍后重试。"
    });

    await vi.advanceTimersByTimeAsync(3500);
    await rejection;

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs",
      "https://video.rivermoon7.com/v1/video/jobs/vjob_api_redirect"
    ]);
  });

  it("参考图上传接口返回外部重定向时会拒绝且不访问外部地址", async () => {
    const sourcePath = path.join(testUserData, "redirect-source.png");
    await fs.writeFile(sourcePath, pngBytes);

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "image-video-fast" },
            models: [
              {
                model: "image-video-fast",
                label: "Image Video Fast",
                family: "image",
                enabled: true,
                endpoints: ["image_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 1,
                reference_types: ["ordinary"],
                estimated_price_usd: 0.14
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/source-cache") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.example.com/upload-proxy?signature=abc" }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "image-video-fast",
      prompt: "source upload redirect should be rejected",
      endpoint: "image_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [sourcePath],
      referenceType: "ordinary",
      referenceTypes: ["ordinary"]
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.14, requestEndpoint: "image_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    await expect(
      runVideoGeneration(params, "client_upload_redirect", "test-key", new AbortController().signal)
    ).rejects.toMatchObject({
      message: "视频服务返回了不安全的重定向，请稍后重试。"
    });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/source-cache"
    ]);
  });

  it("任务提交接口返回外部重定向时会拒绝且不访问外部地址", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://video.rivermoon7.com/v1/video/contract") {
          return jsonResponse({
            contract_version: "test-contract",
            defaults: { primary_model: "video-text-fast" },
            models: [
              {
                model: "video-text-fast",
                label: "Text Fast",
                family: "text",
                enabled: true,
                endpoints: ["text_to_video"],
                aspect_ratios: ["16:9"],
                durations: [5],
                resolutions: ["720p"],
                max_reference_images: 0,
                estimated_price_usd: 0.08
              }
            ]
          });
        }

        if (url === "https://video.rivermoon7.com/v1/video/jobs") {
          expect(init?.method).toBe("POST");
          expect(headersOf(init).Authorization).toBe("Bearer test-key");
          return new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.example.com/jobs-proxy?signature=abc" }
          });
        }

        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchFreshHttpsVideoContract();
    const params: VideoGenParams = {
      model: "video-text-fast",
      prompt: "submit redirect should be rejected",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    };
    const validation = validateVideoParamsAgainstContract(params, contract);
    expect(validation).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "text_to_video" });
    if (validation.ok) params.requestEndpoint = validation.requestEndpoint;

    await expect(
      runVideoGeneration(params, "client_submit_redirect", "test-key", new AbortController().signal)
    ).rejects.toMatchObject({
      message: "视频服务返回了不安全的重定向，请稍后重试。"
    });

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://video.rivermoon7.com/v1/video/contract",
      "https://video.rivermoon7.com/v1/video/jobs"
    ]);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw || raw instanceof Headers || Array.isArray(raw)) return {};
  return raw as Record<string, string>;
}
