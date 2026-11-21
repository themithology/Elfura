#!/usr/bin/env python3
"""
Builds /home/user/Elfura/elfura-pterodactyl.zip as a flat-root Pterodactyl
deployment bundle (zero wrapper directory, pre-built dist/, zero npm registry
downloads, compatible with both plain `node` and ParkerCP's `ts-node --esm`
Node 22/24 Egg even when global typescript@7+ TSGo is installed).
"""

import json
from datetime import datetime
import os
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "dist"
OUT_ZIP = ROOT / "elfura-pterodactyl.zip"

if not (DIST_DIR / "embed.html").is_file() or not (DIST_DIR / "backend" / "index.js").is_file():
    raise SystemExit("dist/ is incomplete — run `npm run build` first.")

# The real root entrypoint is shipped, not a generated shim: it sets the Node
# memory flags this deployment depends on, and a shim would silently drop them.
ROOT_SHIM = (ROOT / "index.js").read_text(encoding="utf-8")

# Same entrypoint, re-pointed one directory down (src/ -> ../dist/...).
SRC_SHIM = ROOT_SHIM.replace("./dist/backend/index.js", "../dist/backend/index.js")

# Only .js aliases are shipped. A .ts file in the container root is an
# invitation for a Pterodactyl egg to start this project through ts-node, which
# then has to be installed and which breaks outright on some Node versions — for
# a project whose runtime output is already compiled JavaScript. Anything an egg
# might be configured to run exists here as plain .js.
ROOT_ENTRYPOINTS = [
    "server.js",
    "app.js",
    "main.js",
    "bot.js",
    "start.js",
    "dist/backend/index.js",  # already present; listed for clarity, not rewritten
]

SRC_ENTRYPOINTS = [
    "src/index.js",
]

NPMRC_CONTENT = """audit=false
fund=false
package-lock=false
update-notifier=false
"""

RUNTIME_PACKAGE_JSON = json.dumps(
    {
        "name": "elfura-player",
        "version": "0.1.0",
        "private": True,
        "type": "module",
        "main": "index.js",
        "scripts": {
            "start": "node index.js",
        },
        "dependencies": {
            # Declared as a file: dependency so an egg that runs `npm install`
            # at boot does not classify undici as extraneous and prune it. The
            # same copy is also shipped at vendor/undici, which the runtime
            # loader falls back to if node_modules is wiped anyway.
            "typescript": "file:./vendor/ts-shim",
            "undici": "file:./vendor/undici",
        },
        # wreq-js is only used by one AniVortex provider and needs a native
        # build, so a panel where that build fails must not abort the install
        # and take undici with it.
        "optionalDependencies": {
            "wreq-js": "3.2.0",
        },
    },
    indent=2,
) + "\n"

RUNTIME_TSCONFIG_JSON = json.dumps(
    {
        "compilerOptions": {
            "target": "ES2022",
            "module": "ESNext",
        },
        "ts-node": {
            "transpileOnly": True,
            "files": False,
            "esm": True,
        },
    },
    indent=2,
) + "\n"

TS_SHIM_PKG_JSON = json.dumps(
    {
        "name": "typescript",
        "version": "4.6.4",
        "main": "./index.cjs",
    },
    indent=2,
) + "\n"

# Lightweight zero-dependency compiler shim so ParkerCP's `/usr/local/bin/ts-node --esm`
# boots cleanly on Node 22/24 without downloading 60MB of typescript/@types/node or
# crashing against global typescript@7+ (TSGo, where ts.sys is undefined).
TS_SHIM_INDEX_CJS = r'''"use strict";
const fs = require("node:fs");
const path = require("node:path");
const mod = require("node:module");

const ScriptTarget = {
  ES3: 0, ES5: 1, ES2015: 2, ES2016: 3, ES2017: 4, ES2018: 5,
  ES2019: 6, ES2020: 7, ES2021: 8, ES2022: 9, ESNext: 99, Latest: 99,
};
const ModuleKind = {
  None: 0, CommonJS: 1, AMD: 2, UMD: 3, System: 4,
  ES2015: 5, ES2020: 6, ES2022: 7, ESNext: 99, Node16: 100, NodeNext: 199,
};
const ModuleResolutionKind = { Classic: 1, NodeJs: 2, Node16: 3, NodeNext: 99 };
const JsxEmit = { None: 0, Preserve: 1, React: 2, ReactNative: 3, ReactJSX: 4, ReactJSXDev: 5 };
const Extension = {
  Ts: ".ts", Tsx: ".tsx", Dts: ".d.ts", Js: ".js", Jsx: ".jsx", Json: ".json",
  TsBuildInfo: ".tsbuildinfo", Mjs: ".mjs", Mts: ".mts", Dmts: ".d.mts",
  Cjs: ".cjs", Cts: ".cts", Dcts: ".d.cts",
};

const sys = {
  args: process.argv.slice(2),
  newLine: "\n",
  useCaseSensitiveFileNames: process.platform !== "win32" && process.platform !== "darwin",
  fileExists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  directoryExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return undefined; } },
  writeFile: (p, data) => fs.writeFileSync(p, data, "utf8"),
  readDirectory: () => [],
  getDirectories: (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  },
  resolvePath: (p) => path.resolve(p),
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
  getCurrentDirectory: () => process.cwd(),
  getExecutingFilePath: () => __filename,
};

function findConfigFile(searchPath, fileExists = sys.fileExists, configName = "tsconfig.json") {
  let dir = path.resolve(searchPath);
  while (true) {
    const candidate = path.join(dir, configName);
    if (fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readConfigFile(fileName, readFile = sys.readFile) {
  const text = readFile(fileName);
  if (text === undefined) {
    return { config: {}, error: { code: 5083, messageText: "Cannot read " + fileName } };
  }
  try {
    return { config: JSON.parse(text) };
  } catch (err) {
    return { config: {}, error: { code: 5083, messageText: String(err) } };
  }
}

function parseJsonConfigFileContent(json) {
  const raw = (json && json.compilerOptions) || {};
  return {
    options: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      allowJs: false,
      sourceMap: Boolean(raw.sourceMap),
      inlineSourceMap: false,
      inlineSources: false,
      declaration: false,
      noEmit: false,
    },
    fileNames: [],
    errors: [],
  };
}

function transpileModule(input, transpileOptions) {
  const fileName = (transpileOptions && transpileOptions.fileName) || "module.ts";
  let outputText = input;
  if (/\.[cm]?tsx?$/i.test(fileName) && typeof mod.stripTypeScriptTypes === "function") {
    outputText = mod.stripTypeScriptTypes(input, { mode: "transform" });
  }
  const map = JSON.stringify({
    version: 3,
    file: path.basename(fileName),
    sources: [fileName],
    names: [],
    mappings: "",
  });
  return { outputText, sourceMapText: map, diagnostics: [] };
}

module.exports = {
  version: "4.6.4",
  versionMajorMinor: "4.6",
  sys,
  ScriptTarget,
  ModuleKind,
  ModuleResolutionKind,
  JsxEmit,
  Extension,
  Diagnostics: {
    File_0_not_found: { code: 6053, category: 1, key: "File_0_not_found", message: "File '{0}' not found." },
  },
  findConfigFile,
  readConfigFile,
  parseJsonConfigFileContent,
  transpileModule,
  createGetCanonicalFileName: (caseSensitive) => (caseSensitive ? (x) => x : (x) => x.toLowerCase()),
  formatDiagnostics: (diags) => (diags || []).map((d) => d.messageText || String(d)).join("\n"),
  formatDiagnosticsWithColorAndContext: (diags) => (diags || []).map((d) => d.messageText || String(d)).join("\n"),
  createCompilerDiagnostic: (msg) => ({
    code: (msg && msg.code) || 0,
    messageText: (msg && msg.message) || String(msg),
  }),
};
'''


# ZIP tools using "update if newer" must see this deployment as newer than
# older installed files. A fixed historical timestamp can silently leave an
# old backend in place while copying a new build-info.json.
ZIP_TIMESTAMP = datetime.now().timetuple()[:6]


def write_entry(zf: zipfile.ZipFile, arcname: str, data: bytes) -> None:
    # Include explicit directory records: some hosting panels' ZIP browsers
    # and extractors do not infer directories from file paths alone.
    parts = arcname.split('/')[:-1]
    for index in range(1, len(parts) + 1):
        directory = '/'.join(parts[:index]) + '/'
        if directory not in zf.NameToInfo:
            dir_info = zipfile.ZipInfo(directory, date_time=ZIP_TIMESTAMP)
            dir_info.create_system = 3
            dir_info.external_attr = (0o40755 << 16) | 0x10
            zf.writestr(dir_info, b'')
    info = zipfile.ZipInfo(arcname, date_time=ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3  # Unix
    info.external_attr = 0o100644 << 16
    zf.writestr(info, data)


def main() -> None:
    tmp_zip = OUT_ZIP.with_suffix(".zip.tmp")
    with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        # Ship `.env.example` ONLY — never write `.env` at the archive root so
        # unarchiving on Pterodactyl preserves any existing `/home/container/.env`.
        # Build stamp so the running server can report exactly which commit
        # it booted from (health + diagnostics) — ends stale-deploy confusion.
        try:
            commit = subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True
            ).strip()
        except Exception:
            commit = "unknown"
        build_info = json.dumps({"commit": commit}) + "\n"
        write_entry(zf, "build-info.json", build_info.encode("utf-8"))

        write_entry(zf, ".env.example", (ROOT / ".env.example").read_bytes())
        write_entry(zf, ".npmrc", NPMRC_CONTENT.encode("utf-8"))
        write_entry(zf, "package.json", RUNTIME_PACKAGE_JSON.encode("utf-8"))
        write_entry(zf, "tsconfig.json", RUNTIME_TSCONFIG_JSON.encode("utf-8"))
        # The relay Worker ships with the bundle: the operator who needs it is on a
        # panel with no shell, so "deploy this file" must not mean "clone the repo".
        for worker_file in ("worker.js", "README.md"):
            source = ROOT / "cloudflare-worker" / worker_file
            if source.is_file():
                write_entry(zf, f"cloudflare-worker/{worker_file}", source.read_bytes())

        write_entry(zf, "README.md", (ROOT / "README.md").read_bytes())
        write_entry(zf, "RULES.md", (ROOT / "RULES.md").read_bytes())

        # Operator tooling that depends on the pre-built dist/: mint per-install
        # AniVortex credentials inside the container, and probe them.
        for helper in ("anivortex-register.mjs", "anivortex-probe.mjs", "env-audit.mjs", "egress-report.mjs"):
            helper_path = ROOT / "scripts" / helper
            if helper_path.is_file():
                write_entry(zf, f"scripts/{helper}", helper_path.read_bytes())

        # index.js is written from the real file: it carries the memory flags.
        write_entry(zf, "index.js", ROOT_SHIM.encode("utf-8"))
        for ep in ROOT_ENTRYPOINTS:
            if ep == "dist/backend/index.js":
                continue  # part of the compiled build, never overwritten
            write_entry(zf, ep, ROOT_SHIM.encode("utf-8"))
        for ep in SRC_ENTRYPOINTS:
            write_entry(zf, ep, SRC_SHIM.encode("utf-8"))

        for prefix in ("vendor/ts-shim", "node_modules/typescript"):
            write_entry(zf, f"{prefix}/package.json", TS_SHIM_PKG_JSON.encode("utf-8"))
            write_entry(zf, f"{prefix}/index.cjs", TS_SHIM_INDEX_CJS.encode("utf-8"))

        # undici is a real runtime dependency now, not a shim: the DNS rescue
        # installs its fetch with an Agent whose connector resolves through
        # explicit name servers, which is the only supported seam Node exposes.
        #
        # Its manifest is REPLACED, not copied. Publishing undici's own
        # package.json inside the archive is what made `npm install` fail in a
        # Pterodactyl panel: npm runs the `prepare` lifecycle script of every
        # `file:` dependency, and undici's prepare is
        # `husky && node ./scripts/platform-shell.js`. Neither husky nor the
        # scripts/ directory ship with the package, so the install died with
        # "Cannot find module .../scripts/platform-shell.js" *before* finishing
        # — undici was never linked, the egress profile and the proxy pool never
        # started, and every console line said the sources were simply offline.
        # Stripping scripts/devDependencies keeps the resolution fields
        # (main, exports, engines) that `import('undici')` needs and leaves
        # nothing for npm to execute.
        undici_dir = ROOT / "node_modules" / "undici"
        if undici_dir.is_dir():
            source_manifest = json.loads((undici_dir / "package.json").read_text("utf-8"))
            runtime_manifest = {
                key: value
                for key, value in source_manifest.items()
                if key
                not in (
                    "scripts",
                    "devDependencies",
                    "husky",
                    "lint-staged",
                    "workspaces",
                    "packageManager",
                    "funding",
                    "repository",
                    "bugs",
                    "homepage",
                )
            }
            runtime_manifest["description"] = "undici (vendored, lifecycle scripts removed for the Pterodactyl bundle)"
            # A file: dependency runs whatever lifecycle scripts its manifest
            # declares, so an accidental `scripts` key here breaks `npm install`
            # in the panel — the exact failure this bundle exists to avoid.
            for forbidden in ("scripts", "devDependencies", "workspaces"):
                assert forbidden not in runtime_manifest, (
                    f"vendored undici manifest still declares {forbidden}; npm install in the panel would run it"
                )
            stripped_manifest = (json.dumps(runtime_manifest, indent=2) + "\n").encode("utf-8")
            for file_path in sorted(undici_dir.rglob("*")):
                if file_path.is_file():
                    rel = file_path.relative_to(undici_dir).as_posix()
                    content = stripped_manifest if rel == "package.json" else file_path.read_bytes()
                    write_entry(zf, f"node_modules/undici/{rel}", content)
                    # Second copy outside node_modules: an egg that runs
                    # `npm install` can prune or recreate that directory, and
                    # the proxy, egress profile and DNS rescue all need undici.
                    write_entry(zf, f"vendor/undici/{rel}", content)

        # Ship the native client and the bindings installed for the build host.
        # Without this, the resolver-only installer (which deliberately does not
        # run npm) would silently skip the multi-audio anime source. Other
        # architectures can install the optional dependency on the target.
        wreq_dir = ROOT / "node_modules" / "wreq-js"
        bindings_dir = ROOT / "node_modules" / "@wreq-js"
        bindings = sorted(p for p in bindings_dir.glob("binding-*") if p.is_dir()) if bindings_dir.is_dir() else []
        if not wreq_dir.is_dir() or not bindings:
            raise SystemExit("wreq-js and a native binding are required to build the bundle; run npm ci on the target platform")
        for package_dir, prefix in [(wreq_dir, "node_modules/wreq-js"), *[(p, f"node_modules/@wreq-js/{p.name}") for p in bindings]]:
            for file_path in sorted(package_dir.rglob("*")):
                if not file_path.is_file():
                    continue
                rel = file_path.relative_to(package_dir).as_posix()
                if rel == "package.json":
                    manifest = json.loads(file_path.read_text("utf-8"))
                    manifest.pop("scripts", None)
                    manifest.pop("devDependencies", None)
                    content = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
                else:
                    content = file_path.read_bytes()
                write_entry(zf, f"{prefix}/{rel}", content)

        for file_path in sorted(DIST_DIR.rglob("*")):
            if file_path.is_file():
                rel = file_path.relative_to(ROOT).as_posix()
                # Legacy VidStuck/Nxsha adapter remains in the repo only for
                # historical unit tests; it is not part of the runtime bundle.
                if rel in ("dist/backend/sources/source2.js", "dist/backend/sources/source2.js.map"):
                    continue
                write_entry(zf, rel, file_path.read_bytes())

    os.replace(tmp_zip, OUT_ZIP)
    print(f"[build-pterodactyl-zip] wrote {OUT_ZIP} ({OUT_ZIP.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
