// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openSettledCompositionPage,
  type OpenSettledCompositionPageOptions,
} from "../capture/captureCompositionFrame.js";
import { DEFAULT_CHECK_OPTIONS, runAuditGrid } from "./checkPipeline.js";
import { captureOverviewShot, runBrowserCheck } from "./checkBrowser.js";
import type { ProjectDir } from "./project.js";

const mocks = vi.hoisted(() => ({
  serverClose: vi.fn(async () => undefined),
}));

vi.mock("@hyperframes/core/compiler", () => ({
  bundleToSingleHtml: vi.fn(async () => "<html></html>"),
}));

vi.mock("../capture/captureCompositionFrame.js", () => ({
  openSettledCompositionPage: vi.fn(),
  resolveCliChromeGpuMode: vi.fn(() => "hardware"),
  seekCompositionTimeline: vi.fn(async () => undefined),
  waitForPreferredSeekTarget: vi.fn(async () => undefined),
}));

vi.mock("./staticProjectServer.js", () => ({
  serveStaticProjectHtml: vi.fn(async () => ({
    url: "http://127.0.0.1:3000",
    close: mocks.serverClose,
  })),
}));

const PROJECT: ProjectDir = {
  dir: "/project",
  name: "project",
  indexPath: "/project/index.html",
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__hyperframesGeometryCandidates");
  Reflect.deleteProperty(window, "__hyperframesLayoutAudit");
});

it("carries raw browser geometry through the page driver and pipeline", async () => {
  vi.spyOn(Date, "now")
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(160)
    .mockReturnValueOnce(200)
    .mockReturnValueOnce(240);
  document.body.innerHTML = `
    <div data-composition-id="main" data-duration="10" data-width="640" data-height="360">
      <section data-composition-file="scenes/hero.html">
        <img id="hero-image" data-layout-name="hero" src="data:image/png;base64,AA==" />
      </section>
    </div>
  `;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 360 });
  installRects();
  const page = fakePage();
  const browser = Object.assign(Object.create(null), {
    close: vi.fn(async () => undefined),
  });
  vi.mocked(openSettledCompositionPage).mockImplementation(
    async (_html: string, _url: string, options: OpenSettledCompositionPageOptions) => {
      await options.beforeNavigate?.(page);
      return { page, browser, renderReadyTimedOut: false };
    },
  );

  const result = await runBrowserCheck(
    PROJECT,
    { ...DEFAULT_CHECK_OPTIONS, samples: 1, contrast: false, frameCheck: {} },
    { kind: "none" },
    runAuditGrid,
  );

  expect(result.layoutIssues).toEqual([
    expect.objectContaining({
      code: "frame_out_of_frame",
      severity: "warning",
      selector: "#hero-image",
      sourceFile: "scenes/hero.html",
      dataAttributes: { "data-layout-name": "hero" },
      bbox: { x: 600, y: 80, width: 200, height: 100 },
      rect: { left: 600, top: 80, right: 800, bottom: 180, width: 200, height: 100 },
      overflow: { right: 160 },
      time: 5,
    }),
  ]);
  expect(result.timings).toEqual({ launchSettleMs: 60, seekLoopMs: 40, contrastMs: 0 });
  expect(mocks.serverClose).toHaveBeenCalledOnce();
});

describe("captureOverviewShot", () => {
  it("injects the annotation overlay before the overview shot and removes it right after", async () => {
    const calls: string[] = [];
    const evaluate = vi.fn(async (fn: unknown, ...args: unknown[]) => {
      calls.push("evaluate");
      return typeof fn === "function" ? Reflect.apply(fn, undefined, args) : undefined;
    });
    const screenshot = vi.fn(async () => {
      calls.push("screenshot");
      return "annotated-base64";
    });
    const page = Object.assign(Object.create(null), { evaluate, screenshot });

    const result = await captureOverviewShot(
      page,
      [{ label: "1 clipped_text", bbox: { x: 0, y: 0, width: 10, height: 10 } }],
      "measurement-base64",
    );

    // inject overlay -> take the shot -> remove overlay, in that order —
    // never present while any audit (which runs before this is called) collects.
    expect(calls).toEqual(["evaluate", "screenshot", "evaluate"]);
    expect(result).toBe("annotated-base64");
  });

  it("skips the overlay entirely and returns the plain screenshot when there's nothing to annotate", async () => {
    const evaluate = vi.fn();
    const screenshot = vi.fn();
    const page = Object.assign(Object.create(null), { evaluate, screenshot });

    const result = await captureOverviewShot(page, [], "measurement-base64");

    expect(evaluate).not.toHaveBeenCalled();
    expect(screenshot).not.toHaveBeenCalled();
    expect(result).toBe("measurement-base64");
  });
});

function installRects(): void {
  const root = document.querySelector("[data-composition-id]");
  const image = document.querySelector("#hero-image");
  if (!root || !image) throw new Error("Geometry fixture failed to mount");
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 360));
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(600, 80, 200, 100));
}

function fakePage() {
  return Object.assign(Object.create(null), {
    on: vi.fn(),
    addScriptTag: vi.fn(async ({ content }: { content: string }) => {
      window.eval(content);
    }),
    evaluate: vi.fn(async (callback: unknown, ...args: unknown[]) => {
      if (typeof callback !== "function") throw new Error("Expected an evaluate callback");
      return Reflect.apply(callback, window, args);
    }),
  });
}
