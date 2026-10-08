const test = require("node:test");
const assert = require("node:assert");

const {
  loadTrayNormalIcon,
  loadTrayFlashIcon,
  buildTrayRainbowFrames,
  recolorBitmap,
} = require("../../../src/ui/menu/tray-flash-icon");

// Minimal nativeImage stand-in: records what was asked of it so the tests can
// assert on the sizing decisions rather than on real pixels.
function makeNativeImage({ empty = false } = {}) {
  const calls = { created: [], resizes: [] };

  function makeImage({ isEmptyValue }) {
    return {
      isEmpty: () => isEmptyValue(),
      setTemplateImage(value) { this.template = value; },
      resize(size) {
        calls.resizes.push(size);
        return { ...this, size };
      },
    };
  }

  return {
    calls,
    createFromPath(p) {
      calls.created.push(p);
      return makeImage({ isEmptyValue: () => empty });
    },
  };
}

const PATHS = {
  templatePath: "/assets/tray-iconTemplate.png",
  iconPath: "/assets/icon.png",
  flashPath: "/assets/tray-icon-flash.png",
  flashTemplatePath: "/assets/tray-icon-flashTemplate.png",
};

test("mac normal icon is loaded as a template image at its natural point size", () => {
  const nativeImage = makeNativeImage();
  const icon = loadTrayNormalIcon({ nativeImage, platform: "darwin", ...PATHS });

  assert.strictEqual(icon.template, true);
  assert.deepStrictEqual(nativeImage.calls.created, [PATHS.templatePath]);
  assert.deepStrictEqual(nativeImage.calls.resizes, [], "no resize — @2x sibling handles retina");
});

test("non-mac normal icon is normalised to 32px", () => {
  const nativeImage = makeNativeImage();
  loadTrayNormalIcon({ nativeImage, platform: "win32", ...PATHS });

  assert.deepStrictEqual(nativeImage.calls.created, [PATHS.iconPath]);
  assert.deepStrictEqual(nativeImage.calls.resizes, [{ width: 32, height: 32 }]);
});

// #722/#941: macOS uses a natural 18pt Template pair. The @2x sibling is
// discovered by Electron/macOS, so no runtime representation or resize occurs.
test("mac flash icon uses the dedicated Template pair at its natural point size", () => {
  const nativeImage = makeNativeImage();
  const icon = loadTrayFlashIcon({
    nativeImage,
    platform: "darwin",
    ...PATHS,
    fileExists: () => true,
  });

  assert.strictEqual(icon.template, true);
  assert.deepStrictEqual(nativeImage.calls.created, [PATHS.flashTemplatePath]);
  assert.deepStrictEqual(nativeImage.calls.resizes, []);
});

test("non-mac flash icon matches the 32px normal icon", () => {
  const nativeImage = makeNativeImage();
  loadTrayFlashIcon({
    nativeImage,
    platform: "win32",
    ...PATHS,
    fileExists: () => true,
  });

  assert.deepStrictEqual(nativeImage.calls.resizes, [{ width: 32, height: 32 }]);
});

test("missing or unreadable flash asset yields no highlight icon", () => {
  const absent = makeNativeImage();
  assert.strictEqual(
    loadTrayFlashIcon({ nativeImage: absent, platform: "darwin", ...PATHS, fileExists: () => false }),
    null
  );
  assert.deepStrictEqual(absent.calls.created, []);

  const emptyImage = makeNativeImage({ empty: true });
  assert.strictEqual(
    loadTrayFlashIcon({ nativeImage: emptyImage, platform: "darwin", ...PATHS, fileExists: () => true }),
    null
  );
});

// Bitmaps are premultiplied BGRA, matching Electron's toBitmap()/createFromBitmap().
test("silhouette recolor fills visible pixels with the hue and keeps premultiplied alpha", () => {
  const bitmap = Buffer.from([
    0, 0, 0, 0,     // transparent
    0, 0, 0, 255,   // opaque black template glyph
    0, 0, 0, 128,   // half-alpha black edge
  ]);
  const out = recolorBitmap(bitmap, 0, { silhouette: true });

  assert.deepStrictEqual([...out.subarray(0, 4)], [0, 0, 0, 0]);
  const [b, g, r, a] = out.subarray(4, 8);
  assert.strictEqual(a, 255);
  assert.ok(r > 200 && g < 60 && b < 60, `expected red, got r=${r} g=${g} b=${b}`);
  const edge = out.subarray(8, 12);
  assert.strictEqual(edge[3], 128);
  assert.ok(edge[0] <= 128 && edge[1] <= 128 && edge[2] <= 128, "channels must stay premultiplied");
  assert.ok(edge[2] > 100, "edge keeps the hue");
  assert.deepStrictEqual([...bitmap.subarray(4, 8)], [0, 0, 0, 255], "source bitmap is not mutated");
});

test("hue recolor shifts saturated pixels and keeps greys (eyes) intact", () => {
  const bitmap = Buffer.from([
    40, 120, 230, 255, // orange body (B,G,R)
    20, 20, 20, 255,   // near-black eye
  ]);
  const out = recolorBitmap(bitmap, 240, { silhouette: false });

  const [b, g, r] = out.subarray(0, 3);
  assert.ok(b > r && b > g, `expected blue-dominant, got r=${r} g=${g} b=${b}`);
  assert.deepStrictEqual([...out.subarray(4, 8)], [20, 20, 20, 255]);
});

test("rainbow frames are empty when the base icon cannot be read, so callers fall back", () => {
  const nativeImage = { createFromBitmap() { throw new Error("must not be called"); } };
  assert.deepStrictEqual(
    buildTrayRainbowFrames({ nativeImage, baseIcon: { isEmpty: () => true }, platform: "win32" }),
    []
  );
  const mismatched = {
    isEmpty: () => false,
    getScaleFactors: () => [1],
    getSize: () => ({ width: 32, height: 32 }),
    toBitmap: () => Buffer.alloc(16),
  };
  assert.deepStrictEqual(
    buildTrayRainbowFrames({ nativeImage, baseIcon: mismatched, platform: "win32" }),
    []
  );
});
