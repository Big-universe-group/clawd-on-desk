"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  scanRelativeRequires,
  collectRelativeHookClosure,
  planAppImageHookBundle,
  isAppImageHookBundleComplete,
  materializeAppImageHookBundle,
  materializeAppImageHookScript,
  AppImageHookMaterializerError,
} = require("../../../hooks/shared/appimage-hook-materializer");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-materializer-"));
  tempDirs.push(dir);
  return dir;
}

function write(dir, name, content) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

// The shipped hooks tree is layered (hooks/<agent-id>/<entry>.js plus
// hooks/shared/<helper>.js). AppImage fixtures must keep that shape: the
// materializer's default boundary is the parent of the primary entry's agent
// folder, i.e. the hooks root itself. `hooksRootRel` fakes a packaged AppImage
// mount (<root>/.mount_Clawd/hooks) when it is nested.
function hooksFixture(layout, hooksRootRel = "hooks") {
  const root = tempDir();
  const hooksRoot = path.join(root, ...hooksRootRel.split("/"));
  const paths = {};
  for (const [relative, content] of Object.entries(layout)) {
    paths[relative] = write(hooksRoot, relative, content);
  }
  return { root, hooksRoot, paths };
}

function outsideHooks(err) {
  return err instanceof AppImageHookMaterializerError && err.code === "OUTSIDE_HOOKS";
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("shared AppImage hook materializer — scanner", () => {
  it("recognizes whitespace, both quote styles and extensionless relative requires", () => {
    const source = [
      `require ( './a.js' );`,
      "require(\n  \"./b\"\n);",
      `require('./nested/c');`,
      `require("node:path");`,
    ].join("\n");
    assert.deepStrictEqual(scanRelativeRequires(source), ["./a.js", "./b", "./nested/c"]);
  });
});

describe("shared AppImage hook materializer — closure", () => {
  it("collects multi-entry closures order-independently from the layered hooks root", () => {
    const { hooksRoot, paths } = hooksFixture({
      "claude-code/state.js": 'require("../shared/dep");\n',
      "claude-code/auto-start.js": 'require("../shared/dep");\nrequire("../shared/other");\n',
      "shared/dep.js": "module.exports = 1;\n",
      "shared/other.js": "module.exports = 2;\n",
    });
    const entry = paths["claude-code/state.js"];
    const extra = paths["claude-code/auto-start.js"];

    const first = collectRelativeHookClosure([entry, extra]);
    const second = collectRelativeHookClosure([extra, entry]);
    assert.strictEqual(first.rootDir, hooksRoot);
    assert.deepStrictEqual(
      [...first.files.keys()].sort(),
      [...second.files.keys()].sort()
    );
    assert.deepStrictEqual(
      [...first.files.keys()].map((file) => path.relative(hooksRoot, file).split(path.sep).join("/")).sort(),
      ["claude-code/auto-start.js", "claude-code/state.js", "shared/dep.js", "shared/other.js"]
    );
  });

  it("rejects a require escaping the hooks root with structured OUTSIDE_HOOKS", () => {
    const { paths } = hooksFixture({
      "claude-code/entry.js": 'require("../../outside.js");\n',
    });
    assert.throws(
      () => collectRelativeHookClosure(paths["claude-code/entry.js"]),
      outsideHooks
    );
  });

  it("anchors the root to the hooks dir instead of a common ancestor of all entries", () => {
    const { root, hooksRoot, paths } = hooksFixture({
      "claude-code/entry.js": "module.exports = 1;\n",
    });
    const entry = paths["claude-code/entry.js"];
    const outside = write(root, "agents/nested/outside.js", "module.exports = 2;\n");

    // Without an explicit root the primary entry's agent folder parent is the
    // boundary, so an extra entry under agents/ must be rejected (not silently
    // widen to the repo root).
    assert.throws(() => collectRelativeHookClosure([entry, outside]), outsideHooks);
    assert.throws(() => collectRelativeHookClosure([outside, entry]), outsideHooks);
    assert.throws(
      () => collectRelativeHookClosure([entry, outside], { rootDir: hooksRoot }),
      outsideHooks
    );
  });

  it("fails closed when realpath verification errors; only ENOENT is tolerated", () => {
    const { paths } = hooksFixture({ "claude-code/entry.js": "module.exports = 1;\n" });
    const entry = paths["claude-code/entry.js"];
    const denied = () => { const err = new Error("denied"); err.code = "EACCES"; throw err; };
    const gone = () => { const err = new Error("gone"); err.code = "ENOENT"; throw err; };

    assert.throws(
      () => collectRelativeHookClosure(entry, { realpathSync: denied }),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "REALPATH_FAILED"
    );
    assert.doesNotThrow(() => collectRelativeHookClosure(entry, { realpathSync: gone }));
  });

  it("fails closed on a symlink that escapes the hooks root", (t) => {
    const { root, paths } = hooksFixture({
      "claude-code/entry.js": 'require("./linked");\n',
    });
    const outside = tempDir();
    const secret = write(outside, "secret.js", "module.exports = 'secret';\n");
    const link = path.join(root, "hooks", "claude-code", "linked.js");
    try {
      fs.symlinkSync(secret, link);
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    assert.throws(
      () => collectRelativeHookClosure(paths["claude-code/entry.js"]),
      outsideHooks
    );
  });

  it("reports an unreadable/missing dependency as structured READ_FAILED", () => {
    const { paths } = hooksFixture({
      "claude-code/entry.js": 'require("./missing");\n',
    });
    assert.throws(
      () => collectRelativeHookClosure(paths["claude-code/entry.js"]),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "READ_FAILED"
    );
  });
});

describe("shared AppImage hook materializer — planning and generation", () => {
  it("plans a deterministic target map keyed by entry and preserves the Codex hash protocol", () => {
    const { root, paths } = hooksFixture({
      "codex/entry.js": 'require("../shared/dep");\n',
      "codex/auto-start.js": 'require("../shared/dep");\n',
      "shared/dep.js": "module.exports = true;\n",
    }, ".mount_Clawd/hooks");
    const hooksRoot = path.join(root, ".mount_Clawd", "hooks");
    const entry = paths["codex/entry.js"];
    const extra = paths["codex/auto-start.js"];
    const appImagePath = "/opt/Clawd-on-Desk.AppImage";
    const materializedRoot = path.join(root, "stable-hooks");

    const plan = planAppImageHookBundle([entry, extra], { appImagePath, materializedRoot });
    assert.strictEqual(
      plan.entryTargets.get(path.resolve(entry)),
      path.join(plan.generationDir, "codex", "entry.js")
    );
    assert.strictEqual(
      plan.entryTargets.get(path.resolve(extra)),
      path.join(plan.generationDir, "codex", "auto-start.js")
    );

    // Independently recompute the pre-refactor hash: canonical appimage path,
    // sorted hooks-root-relative names and bytes, NUL separators, no schema tag.
    const hasher = crypto.createHash("sha256");
    hasher.update(`${appImagePath}\0`);
    for (const name of ["codex/auto-start.js", "codex/entry.js", "shared/dep.js"]) {
      hasher.update(`${name}\0`);
      hasher.update(fs.readFileSync(path.join(hooksRoot, name)));
      hasher.update("\0");
    }
    assert.strictEqual(plan.generation, hasher.digest("hex"));

    // Call order must not change the generation.
    const reversed = planAppImageHookBundle([extra, entry], { appImagePath, materializedRoot });
    assert.strictEqual(reversed.generation, plan.generation);
  });

  it("materializes byte-complete generations and repairs truncated/wrong content", () => {
    const { root, paths } = hooksFixture({
      "codex/entry.js": 'require("../shared/dep");\n',
      "shared/dep.js": "module.exports = 42;\n",
    }, ".mount_Clawd/hooks");
    const entry = paths["codex/entry.js"];
    const materializedRoot = path.join(root, "stable-hooks");
    const options = { appImagePath: "/opt/Clawd.AppImage", materializedRoot };

    const target = materializeAppImageHookScript(entry, options);
    const plan = planAppImageHookBundle(entry, options);
    assert.ok(isAppImageHookBundleComplete(plan));
    assert.strictEqual(fs.readFileSync(target, "utf8"), 'require("../shared/dep");\n');
    const depTarget = path.join(plan.generationDir, "shared", "dep.js");

    // Truncate a dependency: the old existsSync-only check would have trusted it.
    fs.writeFileSync(depTarget, "module.ex");
    assert.strictEqual(isAppImageHookBundleComplete(plan), false);
    materializeAppImageHookBundle(plan);
    assert.strictEqual(isAppImageHookBundleComplete(plan), true);
    assert.strictEqual(fs.readFileSync(depTarget, "utf8"), "module.exports = 42;\n");

    // Wrong same-named content and marker drift are also repaired.
    fs.writeFileSync(depTarget, "module.exports = 99;\n");
    fs.writeFileSync(plan.markerPath, "/other.AppImage\n");
    assert.strictEqual(isAppImageHookBundleComplete(plan), false);
    materializeAppImageHookBundle(plan);
    assert.strictEqual(fs.readFileSync(plan.markerPath, "utf8"), "/opt/Clawd.AppImage\n");
    assert.ok(isAppImageHookBundleComplete(plan));
  });

  it("rejects a relative APPIMAGE path instead of writing a relative generation", () => {
    const { root, paths } = hooksFixture({ "claude-code/entry.js": "module.exports = true;\n" });
    assert.throws(
      () => planAppImageHookBundle(paths["claude-code/entry.js"], { appImagePath: "relative/Clawd.AppImage", materializedRoot: path.join(root, "out") }),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "INVALID_APPIMAGE_PATH"
    );
  });

  it("refuses to materialize a synthesized foreign platform without a controlled root", () => {
    const { paths } = hooksFixture({ "claude-code/entry.js": "module.exports = true;\n" });
    const synthesized = process.platform === "linux" ? "darwin" : "linux";
    assert.throws(
      () => planAppImageHookBundle(paths["claude-code/entry.js"], { appImagePath: "/opt/Clawd.AppImage", platform: synthesized }),
      (err) => err instanceof AppImageHookMaterializerError && err.code === "UNCONTROLLED_ROOT"
    );
  });

  it("tightens a pre-existing materialized root to 0700", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX mode bits only");
      return;
    }
    const { root, paths } = hooksFixture({ "claude-code/entry.js": "module.exports = true;\n" });
    const materializedRoot = path.join(root, "stable-hooks");
    fs.mkdirSync(materializedRoot, { recursive: true, mode: 0o755 });
    fs.chmodSync(materializedRoot, 0o755);

    materializeAppImageHookScript(paths["claude-code/entry.js"], { appImagePath: "/opt/Clawd.AppImage", materializedRoot });
    assert.strictEqual(fs.statSync(materializedRoot).mode & 0o777, 0o700);
  });

  it("is idempotent and does not rewrite an already-complete generation", () => {
    const { root, paths } = hooksFixture({
      "codex/entry.js": 'require("../shared/dep");\n',
      "shared/dep.js": "module.exports = 1;\n",
    }, ".mount_Clawd/hooks");
    const entry = paths["codex/entry.js"];
    const materializedRoot = path.join(root, "stable-hooks");
    const plan = planAppImageHookBundle(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });

    const winner = materializeAppImageHookBundle(plan);
    assert.strictEqual(winner.wrote, true);
    const target = plan.entryTargets.get(path.resolve(entry));
    const bytesAfterWinner = fs.readFileSync(target);
    const mtimeAfterWinner = fs.statSync(target).mtimeMs;

    // A later call observes the same content-addressed generation through the
    // early "already complete" path and must not rewrite it.
    const again = materializeAppImageHookBundle(plan);
    assert.strictEqual(again.wrote, false);
    assert.strictEqual(again.replaced, false);
    assert.deepStrictEqual(fs.readFileSync(target), bytesAfterWinner);
    assert.strictEqual(fs.statSync(target).mtimeMs, mtimeAfterWinner);
    const generations = fs.readdirSync(materializedRoot).filter((name) => !name.startsWith("."));
    assert.deepStrictEqual(generations, [path.basename(plan.generationDir)]);
  });

  it("accepts a byte-complete concurrent winner when its staging rename collides", () => {
    const { root, paths } = hooksFixture({
      "codex/entry.js": 'require("../shared/dep");\n',
      "shared/dep.js": "module.exports = 1;\n",
    }, ".mount_Clawd/hooks");
    const entry = paths["codex/entry.js"];
    const materializedRoot = path.join(root, "stable-hooks");
    const plan = planAppImageHookBundle(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });
    assert.strictEqual(fs.existsSync(plan.generationDir), false);

    // Deterministic rename collision: the first staging->generation rename
    // lands a byte-complete winner generation and then throws EEXIST. This
    // exercises the catch/loser path (not the early-complete return).
    let collided = false;
    const racingFs = {
      ...fs,
      renameSync(from, to) {
        if (!collided && to === plan.generationDir) {
          collided = true;
          fs.mkdirSync(to, { recursive: true, mode: 0o700 });
          for (const file of plan.files) {
            const target = path.join(to, file.relativePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.content);
          }
          fs.writeFileSync(path.join(to, ".clawd-appimage-path"), `${plan.appImagePath}\n`, { mode: 0o600 });
          const err = new Error("EEXIST: file already exists, rename");
          err.code = "EEXIST";
          throw err;
        }
        return fs.renameSync(from, to);
      },
    };

    const loser = materializeAppImageHookBundle(plan, { fs: racingFs });
    assert.strictEqual(collided, true, "the rename collision must have fired");
    assert.strictEqual(loser.wrote, false);
    assert.strictEqual(loser.replaced, false);
    for (const file of plan.files) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(plan.generationDir, file.relativePath)),
        file.content,
        file.relativePath
      );
    }
    const entries = fs.readdirSync(materializedRoot);
    assert.deepStrictEqual(entries, [path.basename(plan.generationDir)]);
    assert.ok(!entries.some((name) => name.includes(".tmp-") || name.includes(".replaced-")));
  });

  it("writes the marker 0600 and the generation/staging directories 0700", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX mode bits only");
      return;
    }
    const { root, paths } = hooksFixture({
      "codex/entry.js": 'require("../shared/dep");\n',
      "shared/dep.js": "module.exports = 1;\n",
    }, ".mount_Clawd/hooks");
    const entry = paths["codex/entry.js"];
    const materializedRoot = path.join(root, "stable-hooks");
    fs.mkdirSync(materializedRoot, { recursive: true, mode: 0o755 });
    fs.chmodSync(materializedRoot, 0o755);

    materializeAppImageHookScript(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });
    const plan = planAppImageHookBundle(entry, { appImagePath: "/opt/Clawd.AppImage", materializedRoot });
    assert.strictEqual(fs.statSync(materializedRoot).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(plan.generationDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(plan.markerPath).mode & 0o777, 0o600);
    assert.deepStrictEqual(
      fs.readdirSync(materializedRoot).filter((name) => name.includes(".tmp-")),
      []
    );
  });
});
