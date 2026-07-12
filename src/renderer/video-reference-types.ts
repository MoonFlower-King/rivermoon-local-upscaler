import type { VideoEndpoint, VideoReferenceType } from "../main/types";

export function resolveRendererVideoReferenceTypes(
  endpoint: VideoEndpoint,
  referencePaths: string[],
  defaultReferenceType: VideoReferenceType,
  referenceTypeByPath: Record<string, VideoReferenceType>,
  selectableTypes: VideoReferenceType[]
): VideoReferenceType[] {
  if (endpoint === "text_to_video") return [];
  if (endpoint === "first_last_frame") {
    return referencePaths.map((_, index) => {
      if (index === 0) return "first_frame";
      if (index === 1) return "last_frame";
      return "reference";
    });
  }

  const supportedTypes = selectableTypes.length > 0 ? selectableTypes : [defaultReferenceType];
  const fallback = supportedTypes.includes(defaultReferenceType)
    ? defaultReferenceType
    : (supportedTypes[0] ?? "ordinary");
  return referencePaths.map((referencePath) => {
    const savedType = referenceTypeByPath[referencePath];
    return savedType && supportedTypes.includes(savedType) ? savedType : fallback;
  });
}

export function pruneVideoReferenceTypeMap(
  referenceTypeByPath: Record<string, VideoReferenceType>,
  referencePaths: string[]
): Record<string, VideoReferenceType> {
  const allowed = new Set(referencePaths);
  return Object.fromEntries(
    Object.entries(referenceTypeByPath).filter(([referencePath]) => allowed.has(referencePath))
  );
}
