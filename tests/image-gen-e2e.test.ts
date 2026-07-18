import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchImageContract, runImageGeneration } from "../src/main/cloud/image-gen";
import type { ImageGenParams } from "../src/main/types";

let testUserData = "";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected app path ${name}`);
      return testUserData;
    }
  }
}));

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const tinyPngBase64 = Buffer.from(pngBytes).toString("base64");

describe("image gateway non-billing e2e", () => {
  beforeEach(async () => {
    testUserData = await fs.mkdtemp(path.join(os.tmpdir(), "rivermoon-image-e2e-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(testUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    testUserData = "";
  });

  it("从图片合同解析到文生图 JSON 提交和落盘可串联", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });
        if (url === "https://img.rivermoon7.com/v1/image/contract") {
          return jsonResponse({
            contract_version: "2026-06-07.phase1",
            defaults: { primary_model: "gpt-image-2" },
            models: [
              {
                public_name: "gpt-image-2",
                label: "GPT Image 2",
                visible: true,
                primary: true,
                endpoints: ["generation"],
                sizes: ["3840x2160"],
                qualities: ["high"],
                output_formats: ["png"],
                size_modes: ["postprocess"]
              }
            ]
          });
        }
        if (url === "https://img.rivermoon7.com/v1/images/generations") {
          expect(init?.method).toBe("POST");
          expect(headerOf(init, "Authorization")).toBe("Bearer test-key");
          expect(headerOf(init, "Content-Type")).toBe("application/json");
          expect(JSON.parse(init?.body as string)).toMatchObject({
            model: "gpt-image-2",
            prompt: "cinematic city",
            n: 1,
            size: "3840x2160",
            quality: "high",
            output_format: "png",
            fit_mode: "contain"
          });
          return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const contract = await fetchImageContract();
    expect(contract).toMatchObject({ ok: true, contractVersion: "2026-06-07.phase1", defaultModelId: "gpt-image-2" });

    const outputs = await runImageGeneration(
      {
        model: "gpt-image-2",
        prompt: "cinematic city",
        size: "3840x2160",
        count: 1,
        quality: "high",
        outputFormat: "png",
        fitMode: "contain",
        sizeMode: "postprocess",
        referencePaths: []
      },
      "test-key",
      new AbortController().signal
    );
    expect(outputs).toHaveLength(1);
    expect(path.basename(outputs[0]!)).toMatch(/_1\.png$/);
    expect(await fs.readFile(outputs[0]!)).toEqual(Buffer.from(pngBytes));
    expect(fetchCalls.map((call) => call.url)).toContain("https://img.rivermoon7.com/v1/images/generations");
  });

  it("带参考图时走 edits FormData，并保留站点同款参数", async () => {
    const referencePath = path.join(testUserData, "reference.png");
    await fs.writeFile(referencePath, pngBytes);
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });
        if (url === "https://img.rivermoon7.com/v1/images/edits") {
          expect(init?.method).toBe("POST");
          expect(headerOf(init, "Authorization")).toBe("Bearer test-key");
          expect(headerOf(init, "Content-Type")).toBeNull();
          expect(init?.body).toBeInstanceOf(FormData);
          const form = init!.body as FormData;
          expect(form.get("model")).toBe("gpt-image-2");
          expect(String(form.get("prompt"))).toContain("use @图1");
          expect(form.get("size")).toBe("2160x3840");
          expect(form.get("quality")).toBe("high");
          expect(form.get("output_format")).toBe("jpeg");
          expect(form.get("fit_mode")).toBe("cover");
          expect(form.get("size_mode")).toBe("native");
          expect(form.getAll("image")).toHaveLength(1);
          return jsonResponse({ data: [{ b64_json: tinyPngBase64 }] });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );

    const params: ImageGenParams = {
      model: "gpt-image-2",
      prompt: "use @图1 as character reference",
      size: "2160x3840",
      count: 1,
      quality: "high",
      outputFormat: "jpeg",
      fitMode: "cover",
      sizeMode: "native",
      referencePaths: [referencePath]
    };

    const outputs = await runImageGeneration(params, "test-key", new AbortController().signal);
    expect(outputs).toHaveLength(1);
    expect(path.basename(outputs[0]!)).toMatch(/_1\.jpg$/);
    expect(fetchCalls.map((call) => call.url)).toEqual(["https://img.rivermoon7.com/v1/images/edits"]);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}
