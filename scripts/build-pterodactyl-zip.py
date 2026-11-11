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

ROOT_SHIM = (
    "import { startBackendServer } from './dist/backend/index.js';\n"
    "startBackendServer();\n"
)

SRC_SHIM = (
    "import { startBackendServer } from '../dist/backend/index.js';\n"
    "startBackendServer();\n"
)

ROOT_ENTRYPOINTS = [
    "index.js",
    "index.ts",
    "server.js",
    "server.ts",
    "app.js",
    "app.ts",
    "main.js",
    "main.ts",
    "bot.js",
    "bot.ts",
    "start.js",
    "start.ts",
]

SRC_ENTRYPOINTS = [
    "src/index.js",
    "src/index.ts",
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
            "typescript": "file:./vendor/ts-shim",
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
        write_entry(zf, "README.md", (ROOT / "README.md").read_bytes())
        write_entry(zf, "RULES.md", (ROOT / "RULES.md").read_bytes())

        for ep in ROOT_ENTRYPOINTS:
            write_entry(zf, ep, ROOT_SHIM.encode("utf-8"))
        for ep in SRC_ENTRYPOINTS:
            write_entry(zf, ep, SRC_SHIM.encode("utf-8"))

        for prefix in ("vendor/ts-shim", "node_modules/typescript"):
            write_entry(zf, f"{prefix}/package.json", TS_SHIM_PKG_JSON.encode("utf-8"))
            write_entry(zf, f"{prefix}/index.cjs", TS_SHIM_INDEX_CJS.encode("utf-8"))

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
