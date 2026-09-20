import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Electron runtime rendering policy", () => {
  it("disables GPU/WebGL before app readiness on headless Linux workers while preserving an explicit override", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "main.ts"), "utf8");

    expect(source).toContain('process.env.CHATGPT_REVIEW_DISABLE_GPU');
    expect(source).toContain('process.platform === "linux" && !explicitlyEnabled');
    expect(source).not.toContain('Boolean(process.env.DISPLAY)');
    expect(source).not.toContain('!process.env.XDG_SESSION_TYPE');
    expect(source).toContain("app.disableHardwareAcceleration()");
    expect(source).toContain('app.commandLine.appendSwitch("disable-gpu")');
    expect(source).toContain('app.commandLine.appendSwitch("disable-gpu-compositing")');
    expect(source).toContain('app.commandLine.appendSwitch("disable-software-rasterizer")');
    expect(source).toContain('app.commandLine.appendSwitch("disable-webgl")');
    expect(source).toContain('app.commandLine.appendSwitch("disable-webgl2")');
    expect(source).toContain('app.commandLine.appendSwitch("use-gl", "disabled")');
    expect(source).toContain("webgl: false");

    const configureIndex = source.indexOf("configureElectronRendering();");
    const readyIndex = source.indexOf("app.whenReady()");
    expect(configureIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(configureIndex);
  });
});
