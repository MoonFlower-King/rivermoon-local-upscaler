import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedAppNavigation } from "../src/main/navigation";

const rendererIndexPath = path.resolve("dist", "renderer", "index.html");

describe("isAllowedAppNavigation", () => {
  it("allows the dev server origin and rejects userinfo / lookalike hosts", () => {
    const dev = { packaged: false, rendererIndexPath };
    expect(isAllowedAppNavigation("http://127.0.0.1:5173/", dev)).toBe(true);
    expect(isAllowedAppNavigation("http://127.0.0.1:5173/#/image", dev)).toBe(true);
    expect(isAllowedAppNavigation("http://127.0.0.1:5173@evil.example/", dev)).toBe(false);
    expect(isAllowedAppNavigation("http://127.0.0.1:51730/", dev)).toBe(false);
    expect(isAllowedAppNavigation("https://evil.example/", dev)).toBe(false);
    expect(isAllowedAppNavigation("not a url", dev)).toBe(false);
  });

  it("only allows the packaged renderer entry file", () => {
    const packaged = { packaged: true, rendererIndexPath };
    const entry = pathToFileURL(rendererIndexPath).toString();
    expect(isAllowedAppNavigation(entry, packaged)).toBe(true);
    expect(isAllowedAppNavigation(`${entry}#/video`, packaged)).toBe(true);
    expect(isAllowedAppNavigation(pathToFileURL(path.resolve("secret.html")).toString(), packaged)).toBe(false);
    expect(isAllowedAppNavigation("http://127.0.0.1:5173/", packaged)).toBe(false);
  });
});
