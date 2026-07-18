import { describe, expect, it } from "vitest";
import type { ImageGenParams } from "../src/main/types";
import {
  IMAGE_CONV_KEY,
  createImageConversation,
  loadImageConversations,
  migrateLegacyImageTasks,
  normalizeImageConversation,
  saveImageConversations,
  type StorageLike
} from "../src/renderer/image-conversations";

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  constructor(initialValue?: string) {
    if (initialValue !== undefined) this.values.set(IMAGE_CONV_KEY, initialValue);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function imageParams(overrides: Partial<ImageGenParams> = {}): ImageGenParams {
  return {
    model: "gpt-image-2",
    prompt: "river at dusk",
    size: "1024x1024",
    count: 1,
    quality: "high",
    outputFormat: "png",
    fitMode: "contain",
    sizeMode: "postprocess",
    referencePaths: [],
    ...overrides
  };
}

describe("normalizeImageConversation", () => {
  it("拒绝非对象，并对损坏字段使用安全默认值", () => {
    expect(normalizeImageConversation(null)).toBeNull();
    expect(normalizeImageConversation("bad")).toBeNull();

    const conversation = normalizeImageConversation(
      {
        id: " ",
        title: " ",
        renamed: "yes",
        taskIds: "bad",
        lastParams: {
          model: " gpt-image-2 ",
          prompt: " prompt ",
          size: "bad",
          count: 99,
          quality: "ultra",
          outputFormat: "jpg",
          fitMode: "bad",
          sizeMode: "bad",
          referencePaths: [" a.png ", "", 1]
        },
        createdAt: Number.NaN,
        updatedAt: -1
      },
      123
    )!;

    expect(conversation.id).not.toBe("");
    expect(conversation.title).toBe("prompt");
    expect(conversation.renamed).toBe(false);
    expect(conversation.taskIds).toEqual([]);
    expect(conversation.createdAt).toBe(123);
    expect(conversation.updatedAt).toBe(123);
    expect(conversation.lastParams).toEqual({
      model: "gpt-image-2",
      prompt: "prompt",
      size: "1024x1024",
      count: 4,
      quality: "high",
      outputFormat: "jpeg",
      fitMode: "contain",
      sizeMode: "postprocess",
      referencePaths: ["a.png"]
    });
  });

  it("标题截到 80 字，taskIds 去重并只保留最后 60 个", () => {
    const taskIds = ["task-old", ...Array.from({ length: 70 }, (_, index) => `task-${index}`), "task-old", "task-69"];
    const conversation = normalizeImageConversation({
      id: "conversation",
      title: "x".repeat(100),
      taskIds,
      lastParams: null,
      createdAt: 1,
      updatedAt: 2
    })!;

    expect(conversation.title).toHaveLength(80);
    expect(conversation.taskIds).toHaveLength(60);
    expect(conversation.taskIds[0]).toBe("task-11");
    expect(conversation.taskIds.at(-1)).toBe("task-69");
    expect(new Set(conversation.taskIds).size).toBe(60);
  });
});

describe("image conversation storage", () => {
  it("storage 缺失、损坏 JSON 或非数组内容均回退空数组", () => {
    expect(loadImageConversations(new MemoryStorage())).toEqual([]);
    expect(loadImageConversations(new MemoryStorage("{"))).toEqual([]);
    expect(loadImageConversations(new MemoryStorage('{"id":"not-an-array"}'))).toEqual([]);
  });

  it("加载时按更新时间倒序并限制为 80 个会话", () => {
    const stored = Array.from({ length: 85 }, (_, index) => ({
      id: `conversation-${index}`,
      title: `Conversation ${index}`,
      renamed: false,
      taskIds: [],
      lastParams: null,
      createdAt: index,
      updatedAt: index
    }));
    const conversations = loadImageConversations(new MemoryStorage(JSON.stringify(stored)));

    expect(conversations).toHaveLength(80);
    expect(conversations[0]?.id).toBe("conversation-84");
    expect(conversations.at(-1)?.id).toBe("conversation-5");
  });

  it("保存时限制为 80 个会话，并可完整读回", () => {
    const storage = new MemoryStorage();
    const conversations = Array.from({ length: 82 }, (_, index) =>
      createImageConversation(
        {
          id: `conversation-${index}`,
          title: `Conversation ${index}`,
          taskIds: [`task-${index}`],
          lastParams: imageParams({ prompt: `prompt ${index}` }),
          createdAt: index,
          updatedAt: index
        },
        index
      )
    );

    saveImageConversations(storage, conversations);
    expect(JSON.parse(storage.getItem(IMAGE_CONV_KEY) ?? "[]")).toHaveLength(80);

    const loaded = loadImageConversations(storage);
    expect(loaded).toHaveLength(80);
    expect(loaded[0]).toMatchObject({
      id: "conversation-79",
      taskIds: ["task-79"],
      lastParams: imageParams({ prompt: "prompt 79" })
    });
  });
});

describe("migrateLegacyImageTasks", () => {
  const legacyTasks = [
    { id: "newest", params: imageParams({ prompt: "newest prompt" }), createdAt: 30 },
    { id: "oldest", params: imageParams({ prompt: "oldest prompt" }), createdAt: 10 },
    { id: "middle", params: imageParams({ prompt: "middle prompt" }), createdAt: 20 }
  ];

  it("仅在旧 storage 不存在且有历史任务时创建迁移会话", () => {
    expect(migrateLegacyImageTasks({ conversations: [], legacyTasks, storageExists: true, now: 100 })).toEqual([]);
    expect(migrateLegacyImageTasks({ conversations: [], legacyTasks: [], storageExists: false, now: 100 })).toEqual([]);

    const migrated = migrateLegacyImageTasks({ conversations: [], legacyTasks, storageExists: false, now: 100 });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({
      title: "历史生成",
      renamed: true,
      taskIds: ["oldest", "middle", "newest"],
      lastParams: imageParams({ prompt: "newest prompt" }),
      createdAt: 10,
      updatedAt: 30
    });
  });

  it("已有会话时不重复迁移，历史任务超过上限时只保留最新 60 个", () => {
    const existing = createImageConversation({ id: "existing" }, 1);
    expect(migrateLegacyImageTasks({ conversations: [existing], legacyTasks, storageExists: false, now: 100 })).toEqual(
      [existing]
    );

    const manyTasks = Array.from({ length: 65 }, (_, index) => ({
      id: `task-${index}`,
      params: imageParams({ prompt: `prompt ${index}` }),
      createdAt: index
    }));
    const migrated = migrateLegacyImageTasks({
      conversations: [],
      legacyTasks: manyTasks,
      storageExists: false,
      now: 100
    });

    expect(migrated[0]?.taskIds).toHaveLength(60);
    expect(migrated[0]?.taskIds[0]).toBe("task-5");
    expect(migrated[0]?.taskIds.at(-1)).toBe("task-64");
  });
});
