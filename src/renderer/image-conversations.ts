import type { ImageGenParams, ImageGenTask } from "../main/types";

export const IMAGE_CONV_KEY = "rivermoon-image-conversations-v1";

const MAX_IMAGE_CONVERSATIONS = 80;
const MAX_IMAGE_CONVERSATION_TASKS = 60;
const MAX_IMAGE_REFERENCES = 20;

export type ImageConversation = {
  id: string;
  title: string;
  renamed: boolean;
  taskIds: string[];
  lastParams: ImageGenParams | null;
  createdAt: number;
  updatedAt: number;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type LegacyImageTask = Pick<ImageGenTask, "id" | "params" | "createdAt">;

export type LegacyImageMigrationInput = {
  conversations: readonly ImageConversation[];
  legacyTasks: readonly LegacyImageTask[];
  storageExists: boolean;
  now?: number;
};

export function loadImageConversations(storage: StorageLike): ImageConversation[] {
  try {
    const serialized = storage.getItem(IMAGE_CONV_KEY);
    if (serialized === null) return [];
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => normalizeImageConversation(value))
      .filter((conversation): conversation is ImageConversation => Boolean(conversation))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_IMAGE_CONVERSATIONS);
  } catch {
    return [];
  }
}

export function saveImageConversations(storage: StorageLike, conversations: readonly ImageConversation[]): void {
  const stable = conversations
    .map((conversation) => normalizeImageConversation(conversation))
    .filter((conversation): conversation is ImageConversation => Boolean(conversation))
    .slice(0, MAX_IMAGE_CONVERSATIONS);
  storage.setItem(IMAGE_CONV_KEY, JSON.stringify(stable));
}

export function createImageConversation(
  input: Partial<ImageConversation> = {},
  now: number = Date.now()
): ImageConversation {
  return normalizeImageConversation(
    {
      id: randomId(),
      title: "新会话",
      renamed: false,
      taskIds: [],
      lastParams: null,
      createdAt: now,
      updatedAt: now,
      ...input
    },
    now
  )!;
}

export function normalizeImageConversation(input: unknown, now: number = Date.now()): ImageConversation | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const lastParams = normalizeLastParams(raw.lastParams);
  const createdAt = normalizeTimestamp(raw.createdAt, now);
  return {
    id: normalizeString(raw.id) || randomId(),
    title: normalizeTitle(raw.title, lastParams?.prompt),
    renamed: raw.renamed === true,
    taskIds: normalizeTaskIds(raw.taskIds),
    lastParams,
    createdAt,
    updatedAt: normalizeTimestamp(raw.updatedAt, createdAt)
  };
}

export function migrateLegacyImageTasks({
  conversations,
  legacyTasks,
  storageExists,
  now = Date.now()
}: LegacyImageMigrationInput): ImageConversation[] {
  if (storageExists || conversations.length > 0 || legacyTasks.length === 0) return [...conversations];

  const tasks = legacyTasks
    .map((task, index) => ({
      id: normalizeString(task?.id),
      params: normalizeLastParams(task?.params),
      createdAt: normalizeTimestamp(task?.createdAt, now),
      index
    }))
    .filter((task) => Boolean(task.id))
    .sort((left, right) => left.createdAt - right.createdAt || left.index - right.index);
  const taskIds = normalizeTaskIds(tasks.map((task) => task.id));
  if (taskIds.length === 0) return [];

  const latestParams = [...tasks].reverse().find((task) => task.params)?.params ?? null;
  return [
    createImageConversation(
      {
        title: "历史生成",
        renamed: true,
        taskIds,
        lastParams: latestParams,
        createdAt: tasks[0]?.createdAt ?? now,
        updatedAt: tasks.at(-1)?.createdAt ?? now
      },
      now
    )
  ];
}

function normalizeLastParams(input: unknown): ImageGenParams | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const model = normalizeString(raw.model);
  const prompt = normalizeString(raw.prompt).slice(0, 4000);
  if (!model || !prompt) return null;

  const sizeValue = normalizeString(raw.size);
  const size = /^\d{3,5}x\d{3,5}$/.test(sizeValue) || sizeValue === "auto" ? sizeValue : "1024x1024";
  const count =
    typeof raw.count === "number" && Number.isFinite(raw.count) ? Math.min(4, Math.max(1, Math.round(raw.count))) : 1;
  const quality = isOneOf(raw.quality, ["low", "medium", "high", "auto"] as const) ? raw.quality : "high";
  const outputFormat =
    raw.outputFormat === "jpg"
      ? "jpeg"
      : isOneOf(raw.outputFormat, ["png", "jpeg", "webp"] as const)
        ? raw.outputFormat
        : "png";
  const fitMode = isOneOf(raw.fitMode, ["contain", "cover"] as const) ? raw.fitMode : "contain";
  const sizeMode = isOneOf(raw.sizeMode, ["postprocess", "native"] as const) ? raw.sizeMode : "postprocess";
  const referencePaths = Array.isArray(raw.referencePaths)
    ? raw.referencePaths.map(normalizeString).filter(Boolean).slice(0, MAX_IMAGE_REFERENCES)
    : [];

  return { model, prompt, size, count, quality, outputFormat, fitMode, sizeMode, referencePaths };
}

function normalizeTaskIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const latest: string[] = [];
  for (let index = input.length - 1; index >= 0 && latest.length < MAX_IMAGE_CONVERSATION_TASKS; index -= 1) {
    const id = normalizeString(input[index]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    latest.push(id);
  }
  return latest.reverse();
}

function normalizeTitle(input: unknown, fallbackPrompt?: string): string {
  const title = normalizeString(input).replace(/\s+/g, " ");
  if (title) return title.slice(0, 80);
  const fallback = normalizeString(fallbackPrompt).replace(/\s+/g, " ");
  return fallback ? fallback.slice(0, 80) : "新会话";
}

function normalizeTimestamp(input: unknown, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : fallback;
}

function normalizeString(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function isOneOf<const T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === "string" && options.includes(value);
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
