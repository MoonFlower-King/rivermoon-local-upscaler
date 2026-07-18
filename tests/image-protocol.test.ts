import { describe, expect, it } from "vitest";
import {
  normalizeImageTask,
  parseImageContract,
  parseImagesResponse,
  sanitizeImageParams,
  validateImageParamsAgainstContract,
  validateImageSourceFileContent,
  validateImageSourceFileMeta
} from "../src/main/cloud/image-protocol";

describe("parseImagesResponse", () => {
  it("兼容 b64_json 与 url 混合返回", () => {
    const payload = { data: [{ b64_json: "abc" }, { url: "https://x/1.png" }, { other: 1 }, null] };
    expect(parseImagesResponse(payload)).toEqual([
      { b64: "abc", url: undefined },
      { b64: undefined, url: "https://x/1.png" }
    ]);
  });

  it("非法结构返回空数组", () => {
    expect(parseImagesResponse(null)).toEqual([]);
    expect(parseImagesResponse({ data: "x" })).toEqual([]);
  });
});

describe("sanitizeImageParams", () => {
  it("空 prompt 或空 model 拒绝开任务", () => {
    expect(sanitizeImageParams({ model: "m", prompt: "  " })).toBeNull();
    expect(sanitizeImageParams({ model: "", prompt: "hi" })).toBeNull();
    expect(sanitizeImageParams(null)).toBeNull();
  });

  it("size 白名单校验、count 夹到 1-4", () => {
    expect(sanitizeImageParams({ model: "m", prompt: "p", size: "bad", count: 99 })).toEqual({
      model: "m",
      prompt: "p",
      size: "1024x1024",
      count: 4,
      quality: "high",
      outputFormat: "png",
      fitMode: "contain",
      sizeMode: "postprocess",
      referencePaths: []
    });
    expect(sanitizeImageParams({ model: "m", prompt: "p", size: "1536x1024", count: 0 })).toEqual({
      model: "m",
      prompt: "p",
      size: "1536x1024",
      count: 1,
      quality: "high",
      outputFormat: "png",
      fitMode: "contain",
      sizeMode: "postprocess",
      referencePaths: []
    });
  });

  it("规整站点同款质量、格式、原生直出和参考图", () => {
    expect(
      sanitizeImageParams({
        model: "gpt-image-2",
        prompt: " p ",
        size: "3840x2160",
        count: 2,
        quality: "medium",
        outputFormat: "jpg",
        fitMode: "cover",
        sizeMode: "native",
        referencePaths: ["a.png", "", 1]
      })
    ).toEqual({
      model: "gpt-image-2",
      prompt: "p",
      size: "3840x2160",
      count: 2,
      quality: "medium",
      outputFormat: "jpeg",
      fitMode: "cover",
      sizeMode: "native",
      referencePaths: ["a.png"]
    });
  });
});

describe("image contract", () => {
  const contract = parseImageContract(
    {
      contract_version: "2026-06-07.phase1",
      defaults: { primary_model: "gpt-image-2" },
      models: [
        {
          public_name: "gpt-image-2",
          internal_name: "gpt-image-2",
          label: "GPT Image 2",
          visible: true,
          primary: true,
          endpoints: ["generation", "edit", "reference_edit"],
          sizes: ["1024x1024", "3840x2160", "auto"],
          custom_size: {
            enabled: true,
            min_dimension: 512,
            max_dimension: 4096,
            max_pixels: 16777216,
            allowed_ratios: ["1:1", "16:9"]
          },
          qualities: ["low", "medium", "high", "auto"],
          output_formats: ["png", "jpeg", "webp"],
          max_reference_images: 20,
          max_reference_image_bytes: 20971520,
          max_body_bytes: 67108864,
          size_modes: ["postprocess", "native"],
          native_return: { recommended_sizes: ["3840x2160"] }
        }
      ]
    },
    123
  );

  it("解析线上图片合同核心字段", () => {
    expect(contract.ok).toBe(true);
    expect(contract.contractVersion).toBe("2026-06-07.phase1");
    expect(contract.defaultModelId).toBe("gpt-image-2");
    expect(contract.models[0]).toMatchObject({
      publicName: "gpt-image-2",
      label: "GPT Image 2",
      qualities: ["low", "medium", "high", "auto"],
      outputFormats: ["png", "jpeg", "webp"],
      maxReferences: 20,
      sizeModes: ["postprocess", "native"]
    });
  });

  it("按合同校验 4K、高质量、PNG 和参考图编辑", () => {
    const params = sanitizeImageParams({
      model: "gpt-image-2",
      prompt: "city",
      size: "3840x2160",
      quality: "high",
      outputFormat: "png",
      referencePaths: ["C:/a.png"]
    })!;
    expect(validateImageParamsAgainstContract(params, contract)).toEqual({ ok: true, endpoint: "edit" });
  });

  it("拒绝合同外尺寸和过多参考图", () => {
    const badSize = sanitizeImageParams({ model: "gpt-image-2", prompt: "city", size: "1200x1000" })!;
    expect(validateImageParamsAgainstContract(badSize, contract).ok).toBe(false);

    const tooManyRefs = sanitizeImageParams({
      model: "gpt-image-2",
      prompt: "city",
      referencePaths: ["C:/0.png"]
    })!;
    tooManyRefs.referencePaths = Array.from({ length: 21 }, (_, index) => `C:/${index}.png`);
    expect(validateImageParamsAgainstContract(tooManyRefs, contract).ok).toBe(false);
  });
});

describe("image references", () => {
  it("校验参考图大小和文件头", () => {
    expect(validateImageSourceFileMeta("a.txt", 100)).toContain("只支持");
    expect(validateImageSourceFileMeta("a.png", 21 * 1024 * 1024)).toContain("超过");
    expect(validateImageSourceFileMeta("a.png", 100)).toBeNull();
    expect(validateImageSourceFileContent("a.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(validateImageSourceFileContent("a.png", Uint8Array.from([1, 2, 3, 4]))).toContain("不是可识别");
  });
});

describe("normalizeImageTask", () => {
  const base = { id: "t1", params: { model: "m", prompt: "p" }, createdAt: 1 };

  it("上次退出时仍在 running/queued 的任务标记为已中断", () => {
    const task = normalizeImageTask({ ...base, status: "running" }, 999)!;
    expect(task.status).toBe("cancelled");
    expect(task.message).toContain("已停止");
    expect(task.finishedAt).toBe(999);
  });

  it("终态任务保留输出路径，过滤非法项；outputSizes 与 outputPaths 对齐", () => {
    const task = normalizeImageTask({
      ...base,
      status: "succeeded",
      outputPaths: ["a.png", 3, ""],
      outputSizes: [123]
    })!;
    expect(task.status).toBe("succeeded");
    expect(task.outputPaths).toEqual(["a.png"]);
    expect(task.outputSizes).toEqual([123]);

    const noSizes = normalizeImageTask({ ...base, status: "succeeded", outputPaths: ["a.png", "b.png"] })!;
    expect(noSizes.outputSizes).toEqual([0, 0]);
  });

  it("缺少必要字段返回 null", () => {
    expect(normalizeImageTask({ id: "x" })).toBeNull();
    expect(normalizeImageTask({ ...base, params: { model: "m", prompt: "" } })).toBeNull();
  });
});
