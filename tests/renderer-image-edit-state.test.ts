import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_EDIT_REFERENCES,
  REDACTED_IMAGE_REFERENCE_PATH,
  addImageEditReference,
  imageModelSupportsEditing,
  resolveImageRerunReferences
} from "../src/renderer/image-edit-state";

describe("image edit reference state", () => {
  it("adds an output image once and keeps existing order", () => {
    expect(addImageEditReference(["a.png"], "b.png", 3)).toEqual({
      referencePaths: ["a.png", "b.png"],
      replacedFirst: false
    });
    expect(addImageEditReference(["a.png"], "a.png", 3)).toEqual({
      referencePaths: ["a.png"],
      replacedFirst: false
    });
  });

  it("replaces the first reference when the active model limit is full", () => {
    expect(addImageEditReference(["a.png", "b.png"], "c.png", 2)).toEqual({
      referencePaths: ["b.png", "c.png"],
      replacedFirst: true
    });
  });

  it("never keeps more than the product-wide 20 reference limit", () => {
    const current = Array.from({ length: MAX_IMAGE_EDIT_REFERENCES }, (_, index) => `${index}.png`);
    const result = addImageEditReference(current, "new.png", 99);
    expect(result.referencePaths).toHaveLength(MAX_IMAGE_EDIT_REFERENCES);
    expect(result.referencePaths[0]).toBe("1.png");
    expect(result.referencePaths.at(-1)).toBe("new.png");
    expect(result.replacedFirst).toBe(true);
  });

  it("requires an edit endpoint as well as positive reference capacity", () => {
    expect(imageModelSupportsEditing({ endpoints: ["generation"], maxReferences: 20 })).toBe(false);
    expect(imageModelSupportsEditing({ endpoints: ["generation", "edit"], maxReferences: 1 })).toBe(true);
    expect(imageModelSupportsEditing({ endpoints: ["reference_edit"], maxReferences: 2 })).toBe(true);
    expect(imageModelSupportsEditing({ endpoints: ["edit"], maxReferences: 0 })).toBe(false);
  });

  it("restores redacted edit references from the active conversation before rerun", () => {
    expect(resolveImageRerunReferences([REDACTED_IMAGE_REFERENCE_PATH], ["a.png", "b.png"], 1)).toEqual(["a.png"]);
    expect(resolveImageRerunReferences([REDACTED_IMAGE_REFERENCE_PATH], [], 2)).toBeNull();
    expect(resolveImageRerunReferences(["original.png"], ["other.png"], 2)).toEqual(["original.png"]);
  });
});
