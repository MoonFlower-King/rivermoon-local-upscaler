import type { ImageContractModel } from "../main/types";

export const MAX_IMAGE_EDIT_REFERENCES = 20;
export const REDACTED_IMAGE_REFERENCE_PATH = "[已上传参考图]";

export type ImageEditReferenceUpdate = {
  referencePaths: string[];
  replacedFirst: boolean;
};

export function imageModelSupportsEditing(
  model: Pick<ImageContractModel, "endpoints" | "maxReferences"> | null | undefined
): boolean {
  return Boolean(
    model && model.maxReferences > 0 && (model.endpoints.includes("edit") || model.endpoints.includes("reference_edit"))
  );
}

export function resolveImageRerunReferences(
  taskReferencePaths: readonly string[],
  currentReferencePaths: readonly string[],
  limit: number
): string[] | null {
  if (!taskReferencePaths.includes(REDACTED_IMAGE_REFERENCE_PATH)) return [...taskReferencePaths];
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const safeLimit = normalizeReferenceLimit(limit);
  const restored = Array.from(
    new Set(
      currentReferencePaths.map((path) => path.trim()).filter((path) => path && path !== REDACTED_IMAGE_REFERENCE_PATH)
    )
  ).slice(0, safeLimit);
  return restored.length > 0 ? restored : null;
}

export function addImageEditReference(
  currentPaths: readonly string[],
  outputPath: string,
  limit: number = MAX_IMAGE_EDIT_REFERENCES
): ImageEditReferenceUpdate {
  const safeLimit = normalizeReferenceLimit(limit);
  const normalizedPath = outputPath.trim();
  const uniquePaths = Array.from(new Set(currentPaths.map((path) => path.trim()).filter(Boolean))).slice(-safeLimit);
  if (!normalizedPath || uniquePaths.includes(normalizedPath)) {
    return { referencePaths: uniquePaths, replacedFirst: false };
  }
  if (uniquePaths.length >= safeLimit) {
    return { referencePaths: [...uniquePaths.slice(1), normalizedPath], replacedFirst: true };
  }
  return { referencePaths: [...uniquePaths, normalizedPath], replacedFirst: false };
}

function normalizeReferenceLimit(limit: number): number {
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : MAX_IMAGE_EDIT_REFERENCES;
  return Math.max(1, Math.min(MAX_IMAGE_EDIT_REFERENCES, requestedLimit));
}
