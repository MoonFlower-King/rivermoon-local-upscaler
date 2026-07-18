import { describe, expect, it } from "vitest";
import {
  VIDEO_SOURCE_MAX_BYTES,
  buildVideoJobRequestPayload,
  normalizeVideoContractCacheValue,
  normalizeVideoTask,
  parseUploadedVideoSource,
  parseVideoContract,
  parseVideoJobResponse,
  parseVideoJobsList,
  resolveVideoReferenceTypes,
  sanitizeVideoParams,
  validateVideoParamsAgainstContract,
  validateVideoSourceFileContent,
  validateVideoSourceFileMeta
} from "../src/main/cloud/video-protocol";

describe("video protocol", () => {
  it("解析 video contract 并隐藏 disabled 模型", () => {
    const contract = parseVideoContract({
      models: [
        {
          model: "omni_flash-10s",
          label: "Omni Flash",
          family: "omni",
          endpoints: ["text_to_video", "image_to_video"],
          aspect_ratios: ["16:9", "9:16"],
          durations: [5, 10],
          resolutions: ["720p"],
          primary: true,
          default_aspect_ratio: "9:16",
          default_duration: 10,
          default_resolution: "720p",
          reference_types: ["ordinary", "character", "style"],
          max_reference_assets: 1,
          estimated_price_usd: "$0.08"
        },
        {
          public_name: "grok-imagine-video",
          visible: false,
          disabled_reason: "missing price"
        }
      ]
    });

    expect(contract.ok).toBe(true);
    expect(contract.models[0]).toMatchObject({
      id: "omni_flash-10s",
      label: "Omni Flash",
      family: "omni",
      enabled: true,
      endpoints: ["text_to_video", "image_to_video"],
      aspectRatios: ["16:9", "9:16"],
      durations: [5, 10],
      resolutions: ["720p"],
      maxReferences: 1,
      requestEndpoints: {
        text_to_video: "text_to_video",
        image_to_video: "image_to_video"
      },
      primary: true,
      defaultAspectRatio: "9:16",
      defaultDuration: 10,
      defaultResolution: "720p",
      referenceTypes: ["ordinary", "character", "style"],
      estimatedPriceUsd: 0.08
    });
    expect(contract.models[1]?.enabled).toBe(false);
  });

  it("解析 video contract 的 primary_model 默认模型", () => {
    const contract = parseVideoContract({
      defaults: { primary_model: "video-primary" },
      models: [
        {
          public_name: "video-secondary",
          endpoints: ["text_to_video"]
        },
        {
          public_name: "video-primary",
          endpoints: ["text_to_video"]
        }
      ]
    });

    expect(contract.defaultModelId).toBe("video-primary");
    expect(contract.models[0]?.primary).toBe(false);
    expect(contract.models[1]).toMatchObject({ id: "video-primary", primary: true });
  });

  it("模型未声明 reference_types 时继承 video contract 顶层参考图类型", () => {
    const contract = parseVideoContract({
      reference_types: [
        { id: "ordinary", label: "普通参考" },
        { id: "first_frame", label: "首帧图" }
      ],
      models: [
        {
          model: "video-v1",
          endpoints: ["image_to_video"],
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"],
          max_reference_assets: 1
        }
      ]
    });

    expect(contract.models[0]?.referenceTypes).toEqual(["ordinary", "first_frame"]);
    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "image_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/style.png"],
          referenceType: "style",
          referenceTypes: ["style"]
        },
        contract
      )
    ).toMatchObject({ ok: false, error: "当前模型不支持风格参考图。" });
  });

  it("顶层声明首尾帧参考类型时不会凭空开放首尾帧 endpoint", () => {
    const contract = parseVideoContract({
      reference_types: [
        { id: "first_frame", label: "首帧图" },
        { id: "last_frame", label: "尾帧图" },
        { id: "ordinary", label: "普通参考" }
      ],
      models: [
        {
          model: "video-v1",
          endpoints: ["text_to_video", "image_to_video"],
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"],
          max_reference_assets: 2
        }
      ]
    });

    expect(contract.models[0]?.endpoints).toEqual(["text_to_video", "image_to_video"]);
    expect(contract.models[0]?.referenceTypes).toEqual(["first_frame", "last_frame", "ordinary"]);
    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "first_last_frame",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/first.png", "C:/last.png"],
          referenceType: "ordinary",
          referenceTypes: ["first_frame", "last_frame"]
        },
        contract
      )
    ).toMatchObject({ ok: false, error: "当前模型不支持 首尾帧。" });
  });

  it("视频合同 endpoint 只接受明确视频模式，不把参考图类型或普通单词误判为模式", () => {
    const contract = parseVideoContract({
      models: [
        {
          model: "bad-endpoints",
          endpoints: ["last_frame", "first_frame", "lasting_motion"],
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"]
        },
        {
          model: "missing-endpoints",
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"]
        },
        {
          model: "alias-endpoints",
          endpoints: ["firstLastFrame", "image", "reference", "multi_reference"],
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"],
          max_reference_assets: 2
        }
      ]
    });

    expect(contract.ok).toBe(true);
    expect(contract.models[0]).toMatchObject({
      id: "bad-endpoints",
      enabled: false,
      endpoints: [],
      requestEndpoints: {}
    });
    expect(contract.models[1]).toMatchObject({
      id: "missing-endpoints",
      enabled: false,
      endpoints: [],
      requestEndpoints: {}
    });
    expect(contract.models[2]).toMatchObject({
      id: "alias-endpoints",
      enabled: true,
      endpoints: ["first_last_frame", "image_to_video", "reference_to_video"],
      requestEndpoints: {
        first_last_frame: "firstLastFrame",
        image_to_video: "image",
        reference_to_video: "reference"
      }
    });
    expect(
      validateVideoParamsAgainstContract(
        {
          model: "bad-endpoints",
          prompt: "p",
          endpoint: "text_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: [],
          referenceType: "ordinary",
          referenceTypes: []
        },
        contract
      )
    ).toMatchObject({ ok: false, error: "当前视频模型不可用，请同步视频合同后重试。" });
  });

  it("读取缓存视频合同时同样禁用缺失或未知 endpoint 的旧模型", () => {
    const cached = normalizeVideoContractCacheValue({
      ok: true,
      defaultModelId: "cached-good",
      fetchedAt: 123,
      models: [
        {
          id: "cached-missing",
          enabled: true,
          endpoints: [],
          aspectRatios: ["16:9"],
          durations: [5],
          resolutions: ["720p"]
        },
        {
          id: "cached-unknown",
          enabled: true,
          endpoints: ["last_frame", "lasting_motion"],
          aspectRatios: ["16:9"],
          durations: [5],
          resolutions: ["720p"]
        },
        {
          id: "cached-good",
          enabled: true,
          endpoints: ["reference_to_video"],
          requestEndpoints: { reference_to_video: "multi_reference" },
          aspectRatios: ["16:9"],
          durations: [10],
          resolutions: ["720p"],
          referenceTypes: ["ordinary", "style"],
          maxReferences: 4
        }
      ]
    });

    expect(cached).toMatchObject({
      ok: true,
      fromCache: true,
      source: "cache",
      defaultModelId: "cached-good"
    });
    expect(cached?.models[0]).toMatchObject({ id: "cached-missing", enabled: false, endpoints: [] });
    expect(cached?.models[1]).toMatchObject({ id: "cached-unknown", enabled: false, endpoints: [] });
    expect(cached?.models[2]).toMatchObject({
      id: "cached-good",
      enabled: true,
      endpoints: ["reference_to_video"],
      requestEndpoints: { reference_to_video: "multi_reference" },
      primary: true,
      referenceTypes: ["ordinary", "style"],
      maxReferences: 4
    });
  });

  it("保留 video contract 里的原始 endpoint 作为提交值", () => {
    const contract = parseVideoContract({
      models: [
        {
          model: "videos_stable",
          endpoints: ["text_to_video", "image_to_video", "multi_reference"],
          aspect_ratios: ["16:9"],
          durations: [10],
          resolutions: ["720p"],
          max_reference_assets: 4
        },
        {
          model: "grok-imagine-video",
          endpoints: ["reference_to_video"],
          aspect_ratios: ["16:9"],
          durations: [6],
          resolutions: ["720p"],
          max_reference_assets: 8
        }
      ]
    });

    expect(contract.models[0]).toMatchObject({
      endpoints: ["text_to_video", "image_to_video", "reference_to_video"],
      requestEndpoints: {
        text_to_video: "text_to_video",
        image_to_video: "image_to_video",
        reference_to_video: "multi_reference"
      }
    });
    expect(contract.models[1]).toMatchObject({
      endpoints: ["reference_to_video"],
      requestEndpoints: { reference_to_video: "reference_to_video" }
    });
    expect(
      validateVideoParamsAgainstContract(
        {
          model: "videos_stable",
          prompt: "p",
          endpoint: "reference_to_video",
          aspectRatio: "16:9",
          duration: 10,
          resolution: "720p",
          referencePaths: ["C:/a.png", "C:/b.png"],
          referenceType: "ordinary",
          referenceTypes: ["ordinary", "ordinary"]
        },
        contract
      )
    ).toEqual({ ok: true, estimatedCostUsd: null, requestEndpoint: "multi_reference" });
  });

  it("规整视频参数，空 prompt/model 拒绝开任务", () => {
    expect(sanitizeVideoParams({ model: "m", prompt: "" })).toBeNull();
    expect(sanitizeVideoParams({ model: "", prompt: "x" })).toBeNull();
    expect(
      sanitizeVideoParams({
        model: "m",
        prompt: "  hello  ",
        endpoint: "image_to_video",
        aspectRatio: "9:16",
        duration: 10,
        resolution: "1080p",
        referencePaths: ["C:/a.png", "", "C:/b.webp"],
        referenceType: "character"
      })
    ).toEqual({
      model: "m",
      prompt: "hello",
      endpoint: "image_to_video",
      requestEndpoint: "image_to_video",
      aspectRatio: "9:16",
      duration: 10,
      resolution: "1080p",
      referencePaths: ["C:/a.png", "C:/b.webp"],
      referenceType: "character",
      referenceTypes: ["character", "character"]
    });
  });

  it("规整视频参数时补齐参考图默认值并回退非法参考类型", () => {
    expect(sanitizeVideoParams({ model: "m", prompt: "p" })).toMatchObject({
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    });
    expect(sanitizeVideoParams({ model: "m", prompt: "p", referenceType: "bad_type" })).toMatchObject({
      referenceType: "ordinary"
    });
  });

  it("首尾帧模式按参考图顺序自动标记首帧和尾帧", () => {
    expect(
      sanitizeVideoParams({
        model: "m",
        prompt: "p",
        endpoint: "first_last_frame",
        referencePaths: ["C:/first.png", "C:/last.png"],
        referenceType: "style"
      })
    ).toMatchObject({
      endpoint: "first_last_frame",
      referenceTypes: ["first_frame", "last_frame"]
    });
    expect(resolveVideoReferenceTypes("first_last_frame", ["a", "b", "c"], "style")).toEqual([
      "first_frame",
      "last_frame",
      "reference"
    ]);
  });

  it("多参考图模式保留逐图参考类型", () => {
    expect(
      sanitizeVideoParams({
        model: "m",
        prompt: "p",
        endpoint: "reference_to_video",
        referencePaths: ["C:/a.png", "C:/b.png"],
        referenceTypes: ["character", "style"]
      })
    ).toMatchObject({
      referenceType: "ordinary",
      referenceTypes: ["character", "style"]
    });
  });

  it("本地校验视频参考图格式和大小", () => {
    expect(validateVideoSourceFileMeta("C:/asset/ref.png", 1024)).toBeNull();
    expect(validateVideoSourceFileMeta("C:/asset/ref.gif", 1024)).toBeNull();
    expect(validateVideoSourceFileMeta("C:/asset/ref.bmp", 1024)).toContain("参考图只支持 JPG、PNG、WebP 或 GIF");
    expect(validateVideoSourceFileMeta("C:/asset/ref.jpg", 0)).toContain("参考图为空");
    expect(validateVideoSourceFileMeta("C:/asset/ref.webp", VIDEO_SOURCE_MAX_BYTES + 1)).toContain(
      "参考图不能超过 20MB"
    );
  });

  it("本地校验视频参考图文件头，拒绝扩展名伪装文件", () => {
    expect(
      validateVideoSourceFileContent(
        "C:/asset/ref.png",
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toBeNull();
    expect(validateVideoSourceFileContent("C:/asset/ref.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBeNull();
    expect(
      validateVideoSourceFileContent(
        "C:/asset/ref.webp",
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
      )
    ).toBeNull();
    expect(validateVideoSourceFileContent("C:/asset/ref.gif", new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(validateVideoSourceFileContent("C:/asset/not-image.png", new TextEncoder().encode("not an image"))).toBe(
      "参考图内容不是有效图片：not-image.png"
    );
  });

  it("按视频合同校验提交参数并返回预估费用", () => {
    const contract = parseVideoContract({
      models: [
        {
          model: "video-v1",
          endpoints: ["text_to_video", "image_to_video"],
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"],
          max_reference_assets: 1,
          estimated_price_usd: 0.08
        }
      ]
    });

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "image_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/a.png"],
          referenceType: "ordinary",
          referenceTypes: ["ordinary"]
        },
        contract
      )
    ).toEqual({ ok: true, estimatedCostUsd: 0.08, requestEndpoint: "image_to_video" });

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "image_to_video",
          aspectRatio: "1:1",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/a.png"],
          referenceType: "ordinary",
          referenceTypes: ["ordinary"]
        },
        contract
      )
    ).toMatchObject({ ok: false });

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "image_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/a.png", "C:/b.png"],
          referenceType: "ordinary",
          referenceTypes: ["ordinary", "ordinary"]
        },
        contract
      )
    ).toMatchObject({ ok: false, error: "参考图数量超过当前模型上限（1 张）。" });
  });

  it("缓存视频合同不能用于提交新付费任务", () => {
    const contract = {
      ...parseVideoContract({
        models: [
          {
            model: "video-v1",
            endpoints: ["text_to_video"],
            aspect_ratios: ["16:9"],
            durations: [5],
            resolutions: ["720p"]
          }
        ]
      }),
      fromCache: true,
      error: "视频合同同步失败，正在使用上次缓存：network"
    };

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "text_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: [],
          referenceType: "ordinary",
          referenceTypes: []
        },
        contract
      )
    ).toEqual({ ok: false, error: "视频合同同步失败，正在使用上次缓存：network" });
  });

  it("HTTP fallback 视频合同不能用于提交新付费任务", () => {
    const contract = parseVideoContract(
      {
        models: [
          {
            model: "video-v1",
            endpoints: ["text_to_video"],
            aspect_ratios: ["16:9"],
            durations: [5],
            resolutions: ["720p"]
          }
        ]
      },
      1,
      "http"
    );

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "text_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: [],
          referenceType: "ordinary",
          referenceTypes: []
        },
        contract
      )
    ).toEqual({ ok: false, error: "提交视频任务必须使用 HTTPS 实时合同，请同步视频合同后重试。" });
  });

  it("按视频合同拒绝模型不支持的参考图类型", () => {
    const contract = parseVideoContract({
      models: [
        {
          model: "video-v1",
          endpoints: ["image_to_video"],
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"],
          max_reference_assets: 1,
          reference_types: ["ordinary", "first_frame"]
        }
      ]
    });

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "image_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/a.png"],
          referenceType: "style",
          referenceTypes: ["style"]
        },
        contract
      )
    ).toMatchObject({ ok: false, error: "当前模型不支持风格参考图。" });
  });

  it("按视频合同校验首尾帧必须同时提供首帧和尾帧", () => {
    const contract = parseVideoContract({
      models: [
        {
          model: "video-v1",
          endpoints: ["first_last_frame"],
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"],
          max_reference_assets: 2
        }
      ]
    });

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "first_last_frame",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/first.png"],
          referenceType: "first_frame",
          referenceTypes: ["first_frame"]
        },
        contract
      )
    ).toMatchObject({ ok: false, error: "首尾帧模式需要首帧和尾帧 2 张参考图。" });

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "first_last_frame",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/first.png", "C:/last.png"],
          referenceType: "ordinary",
          referenceTypes: ["first_frame", "last_frame"]
        },
        contract
      )
    ).toEqual({ ok: true, estimatedCostUsd: null, requestEndpoint: "first_last_frame" });
  });

  it("首尾帧合同参考图上限不足时本地拒绝提交", () => {
    const contract = parseVideoContract({
      models: [
        {
          model: "video-v1",
          endpoints: ["first_last_frame"],
          aspect_ratios: ["16:9"],
          durations: [5],
          resolutions: ["720p"],
          max_reference_assets: 1
        }
      ]
    });

    expect(
      validateVideoParamsAgainstContract(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "first_last_frame",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/first.png", "C:/last.png"],
          referenceType: "ordinary",
          referenceTypes: ["first_frame", "last_frame"]
        },
        contract
      )
    ).toMatchObject({
      ok: false,
      error: "当前模型首尾帧参考图上限不足，请同步视频合同或切换模型。"
    });
  });

  it("构造视频提交载荷时保持逐图 reference_types 顺序", () => {
    const payload = buildVideoJobRequestPayload(
      {
        model: "video-v1",
        prompt: "p",
        endpoint: "first_last_frame",
        aspectRatio: "16:9",
        duration: 5,
        resolution: "720p",
        referencePaths: ["C:/first.png", "C:/last.png"],
        referenceType: "ordinary",
        referenceTypes: ["first_frame", "last_frame"]
      },
      [
        { sourceId: "src_first", sourceUrl: null },
        { sourceId: "src_last", sourceUrl: null }
      ],
      "client_1"
    );

    expect(payload).toMatchObject({
      reference_type: "first_frame",
      source_ids: ["src_first", "src_last"],
      source_urls: [],
      reference_types: {
        "1": "first_frame",
        "2": "last_frame"
      },
      client_request_id: "client_1"
    });
  });

  it("构造视频提交载荷时使用合同提供的 requestEndpoint", () => {
    const payload = buildVideoJobRequestPayload(
      {
        model: "videos_stable",
        prompt: "p",
        endpoint: "reference_to_video",
        requestEndpoint: "multi_reference",
        aspectRatio: "16:9",
        duration: 10,
        resolution: "720p",
        referencePaths: ["C:/a.png", "C:/b.png"],
        referenceType: "ordinary",
        referenceTypes: ["ordinary", "style"]
      },
      [
        { sourceId: "src_a", sourceUrl: null },
        { sourceId: "src_b", sourceUrl: null }
      ],
      "client_1"
    );

    expect(payload).toMatchObject({
      endpoint: "multi_reference",
      mode: "multi_reference",
      source_ids: ["src_a", "src_b"],
      reference_types: {
        "1": "ordinary",
        "2": "style"
      }
    });
  });

  it("兼容 source-cache 返回的多种包装结构", () => {
    expect(parseUploadedVideoSource({ source_id: "src_root", source_url: "https://cdn.example.com/root.png" })).toEqual(
      {
        sourceId: "src_root",
        sourceUrl: "https://cdn.example.com/root.png"
      }
    );
    expect(
      parseUploadedVideoSource({ data: { sourceId: "src_data", url: "https://cdn.example.com/data.png" } })
    ).toEqual({
      sourceId: "src_data",
      sourceUrl: "https://cdn.example.com/data.png"
    });
    expect(
      parseUploadedVideoSource({ source: { id: "src_nested", file_url: "https://cdn.example.com/source.png" } })
    ).toEqual({
      sourceId: "src_nested",
      sourceUrl: "https://cdn.example.com/source.png"
    });
    expect(
      parseUploadedVideoSource({
        raw_response_json: JSON.stringify({
          result: { cache_id: "src_raw", asset_url: "https://cdn.example.com/raw.png" }
        })
      })
    ).toEqual({
      sourceId: "src_raw",
      sourceUrl: "https://cdn.example.com/raw.png"
    });
  });

  it("构造视频提交载荷时拒绝无法保序的混合参考图缓存结果", () => {
    expect(() =>
      buildVideoJobRequestPayload(
        {
          model: "video-v1",
          prompt: "p",
          endpoint: "first_last_frame",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p",
          referencePaths: ["C:/first.png", "C:/last.png"],
          referenceType: "ordinary",
          referenceTypes: ["first_frame", "last_frame"]
        },
        [
          { sourceId: null, sourceUrl: "https://cdn.example.com/first.png" },
          { sourceId: "src_last", sourceUrl: null }
        ],
        "client_1"
      )
    ).toThrow("视频参考图缓存返回不完整，无法保持参考图顺序，请稍后重试。");
  });

  it("兼容 create/poll 返回的 job 包装结构", () => {
    const job = parseVideoJobResponse({
      ok: true,
      job: {
        job_id: "vjob_1",
        request_id: "req_1",
        client_request_id: "client_1",
        status: "processing",
        raw_response_json: JSON.stringify({ progress: 42 }),
        charged_usd: "$0.12",
        charged: 1,
        content_url: "/v1/video/jobs/vjob_1/content",
        download_url: "/v1/video/jobs/vjob_1/download"
      }
    });

    expect(job).toMatchObject({
      jobId: "vjob_1",
      requestId: "req_1",
      clientRequestId: "client_1",
      status: "running",
      progress: 42,
      endpoint: "text_to_video",
      costUsd: 0.12,
      charged: true,
      contentUrl: "/v1/video/jobs/vjob_1/content",
      downloadUrl: "/v1/video/jobs/vjob_1/download"
    });
  });

  it("从 raw_response_json 兼容解析视频成本回执", () => {
    const job = parseVideoJobResponse({
      job: {
        job_id: "vjob_cost",
        status: "completed",
        raw_response_json: JSON.stringify({
          actual_cost_usd: "0.085",
          estimated_cost_usd: "0.10"
        }),
        refunded: "false"
      }
    });

    expect(job).toMatchObject({
      jobId: "vjob_cost",
      status: "succeeded",
      costUsd: 0.085,
      estimatedCostUsd: 0.1,
      refunded: false
    });
  });

  it("兼容 data 包装的视频任务响应", () => {
    const job = parseVideoJobResponse({
      ok: true,
      data: {
        job_id: "vjob_data",
        status: "completed",
        progress: "100%",
        video_url: "https://cdn.example.com/video.mp4",
        charged: true
      }
    });

    expect(job).toMatchObject({
      jobId: "vjob_data",
      status: "succeeded",
      progress: 100,
      outputUrl: "https://cdn.example.com/video.mp4",
      charged: true
    });
  });

  it("兼容 0-1 小数进度并保留百分比格式语义", () => {
    expect(parseVideoJobResponse({ job_id: "vjob_fraction", progress: 0.42 })).toMatchObject({
      jobId: "vjob_fraction",
      progress: 42
    });
    expect(parseVideoJobResponse({ job_id: "vjob_fraction_string", progress: "0.42" })).toMatchObject({
      jobId: "vjob_fraction_string",
      progress: 42
    });
    expect(parseVideoJobResponse({ job_id: "vjob_percent_string", progress: "0.42%" })).toMatchObject({
      jobId: "vjob_percent_string",
      progress: 0
    });
  });

  it("兼容进度字段别名和明确进度消息，同时不把普通数字误判为进度", () => {
    expect(parseVideoJobResponse({ job_id: "vjob_progress_percent", progress_percent: "75" })).toMatchObject({
      jobId: "vjob_progress_percent",
      progress: 75
    });
    expect(parseVideoJobResponse({ job_id: "vjob_progress_ratio", progressRatio: 0.42 })).toMatchObject({
      jobId: "vjob_progress_ratio",
      progress: 42
    });
    expect(parseVideoJobResponse({ job_id: "vjob_message_percent", message: "rendering 67%" })).toMatchObject({
      jobId: "vjob_message_percent",
      progress: 67
    });
    expect(parseVideoJobResponse({ job_id: "vjob_status_message", status_message: "远端进度 0.42" })).toMatchObject({
      jobId: "vjob_status_message",
      progress: 42
    });
    expect(parseVideoJobResponse({ job_id: "vjob_eta", message: "预计还要 5 分钟" })).toMatchObject({
      jobId: "vjob_eta",
      progress: null
    });
  });

  it("兼容 data.job 和 raw_response_json.data.job 包装的视频任务响应", () => {
    const fromDataJob = parseVideoJobResponse({
      ok: true,
      data: {
        job: {
          job_id: "vjob_data_job",
          status: "completed",
          output: {
            video_url: "https://cdn.example.com/data-job.mp4"
          },
          usage: {
            total_usd: "0.14"
          }
        }
      }
    });
    const fromRawDataJob = parseVideoJobResponse({
      raw_response_json: JSON.stringify({
        data: {
          job: {
            id: "vjob_raw_data_job",
            state: "success",
            download_url: "/v1/video/jobs/vjob_raw_data_job/download",
            estimated_price_usd: "0.16",
            billed: "yes"
          }
        }
      })
    });

    expect(fromDataJob).toMatchObject({
      jobId: "vjob_data_job",
      status: "succeeded",
      outputUrl: "https://cdn.example.com/data-job.mp4",
      costUsd: 0.14
    });
    expect(fromRawDataJob).toMatchObject({
      jobId: "vjob_raw_data_job",
      status: "succeeded",
      downloadUrl: "/v1/video/jobs/vjob_raw_data_job/download",
      estimatedCostUsd: 0.16,
      charged: true
    });
  });

  it("从 raw_response_json 的嵌套 data/result/output 兼容解析视频地址和费用", () => {
    const fromData = parseVideoJobResponse({
      job: {
        job_id: "vjob_raw_data",
        status: "completed",
        raw_response_json: JSON.stringify({
          data: {
            video_url: "https://cdn.example.com/raw-data.mp4",
            actual_cost_usd: "0.09",
            estimated_price_usd: "0.11",
            charged: "paid"
          }
        })
      }
    });
    const fromResult = parseVideoJobResponse({
      job: {
        job_id: "vjob_raw_result",
        status: "completed",
        raw_response_json: JSON.stringify({
          result: {
            url: "https://cdn.example.com/raw-result.mp4",
            refunded: "true"
          }
        })
      }
    });
    const fromOutput = parseVideoJobResponse({
      job: {
        job_id: "vjob_raw_output",
        status: "completed",
        raw_response_json: JSON.stringify({
          output: {
            file_url: "https://cdn.example.com/raw-output.mp4"
          }
        })
      }
    });

    expect(fromData).toMatchObject({
      outputUrl: "https://cdn.example.com/raw-data.mp4",
      costUsd: 0.09,
      estimatedCostUsd: 0.11,
      charged: true
    });
    expect(fromResult).toMatchObject({
      outputUrl: "https://cdn.example.com/raw-result.mp4",
      refunded: true
    });
    expect(fromOutput).toMatchObject({
      outputUrl: "https://cdn.example.com/raw-output.mp4"
    });
  });

  it("兼容响应根对象上的视频成本回执", () => {
    const job = parseVideoJobResponse({
      ok: true,
      usage_usd: 0.07,
      estimated_price_usd: 0.08,
      charged: true,
      job: {
        job_id: "vjob_root_cost",
        status: "completed"
      }
    });

    expect(job).toMatchObject({
      jobId: "vjob_root_cost",
      status: "succeeded",
      costUsd: 0.07,
      estimatedCostUsd: 0.08,
      charged: true
    });
  });

  it("兼容 recent 视频任务列表的多种包装结构", () => {
    const jobs = parseVideoJobsList({
      jobs: [
        {
          job_id: "vjob_1",
          request_id: "req_1",
          status: "completed",
          model: "video-v1",
          prompt: "camera push in",
          mode: "text_to_video",
          aspect_ratio: "16:9",
          duration: "10s",
          quality: "720p",
          progress: "100%"
        },
        {
          id: "vjob_2",
          status: "failed",
          message: "bad prompt"
        }
      ]
    });

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      jobId: "vjob_1",
      requestId: "req_1",
      status: "succeeded",
      model: "video-v1",
      prompt: "camera push in",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 10,
      resolution: "720p",
      progress: 100
    });
    expect(jobs[1]).toMatchObject({
      jobId: "vjob_2",
      status: "failed",
      errorMessage: "bad prompt"
    });
  });

  it("兼容 nested data.jobs 和 raw_response_json.results 视频任务列表", () => {
    const fromDataJobs = parseVideoJobsList({
      data: {
        jobs: [
          {
            job_id: "vjob_nested_1",
            status: "completed"
          }
        ]
      }
    });
    const fromRawResults = parseVideoJobsList({
      raw_response_json: JSON.stringify({
        results: [
          {
            id: "vjob_raw_list_1",
            state: "pending"
          }
        ]
      })
    });

    expect(fromDataJobs).toHaveLength(1);
    expect(fromDataJobs[0]).toMatchObject({ jobId: "vjob_nested_1", status: "succeeded" });
    expect(fromRawResults).toHaveLength(1);
    expect(fromRawResults[0]).toMatchObject({ jobId: "vjob_raw_list_1", status: "queued" });
  });

  it("恢复磁盘任务时把未完成任务标记为 cancelled", () => {
    const task = normalizeVideoTask(
      {
        id: "local",
        params: {
          model: "m",
          prompt: "p",
          endpoint: "text_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p"
        },
        status: "queued",
        createdAt: 1,
        costUsd: 0.2,
        estimatedCostUsd: 0.25,
        charged: true,
        refunded: false,
        clientRequestId: "client_queued"
      },
      99
    );

    expect(task?.status).toBe("cancelled");
    expect(task?.finishedAt).toBe(99);
    expect(task?.message).toBe("上次关闭软件时已停止");
    expect(task?.params.referencePaths).toEqual([]);
    expect(task?.params.referenceType).toBe("ordinary");
    expect(task?.params.referenceTypes).toEqual([]);
    expect(task?.costUsd).toBe(0.2);
    expect(task?.estimatedCostUsd).toBe(0.25);
    expect(task?.charged).toBe(true);
    expect(task?.refunded).toBe(false);
    expect(task?.clientRequestId).toBe("client_queued");
  });

  it("恢复磁盘任务时保留已提交的远端视频任务", () => {
    const task = normalizeVideoTask(
      {
        id: "local",
        params: {
          model: "m",
          prompt: "p",
          endpoint: "text_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p"
        },
        status: "running",
        createdAt: 1,
        remoteJobId: "vjob_1"
      },
      99
    );

    expect(task?.status).toBe("queued");
    expect(task?.finishedAt).toBeNull();
    expect(task?.message).toBe("等待恢复远端视频任务");
    expect(task?.remoteJobId).toBe("vjob_1");
  });

  it("恢复磁盘任务时保留已提交但还在本地排队的远端视频任务", () => {
    const task = normalizeVideoTask(
      {
        id: "local",
        params: {
          model: "m",
          prompt: "p",
          endpoint: "text_to_video",
          aspectRatio: "16:9",
          duration: 5,
          resolution: "720p"
        },
        status: "queued",
        createdAt: 1,
        finishedAt: 88,
        remoteJobId: "vjob_queued"
      },
      99
    );

    expect(task?.status).toBe("queued");
    expect(task?.finishedAt).toBeNull();
    expect(task?.message).toBe("等待恢复远端视频任务");
    expect(task?.remoteJobId).toBe("vjob_queued");
  });
});
