#!/usr/bin/env bash
#
# Check before push — the cheap mistakes, caught locally.
# =====================================================================
# This exists because of a specific failure. A test file was edited, a variable
# was renamed in two places but not a third, and the break only showed up in a
# GitHub Actions run several minutes later — after a commit, after a push,
# after another blind wait. The rename was one line. It could have been caught
# in one second here.
#
# The same class of mistake accounts for most of the wasted rounds on this repo:
#
#   - an undefined identifier in a test that only runs on a runner
#   - a workflow step whose shell is malformed (caught only when the job runs)
#   - a probe file that IS run by the workflow but is missing from the trigger
#     paths, so editing it does not re-run the job that uses it
#   - a source file committed without being added to the contract manifest
#
# None of those need the network. All of them are checked here, in seconds.
#
#   ./scripts/check-before-push.sh            # check files changed vs origin/main
#   ./scripts/check-before-push.sh --all      # check everything
#
# Exit 0 means the cheap layer is clean. It does NOT mean the change works —
# anything that needs a real provider must still be run on a runner, because
# this sandbox reaches none of them. That is what the reminder at the end is for.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FAIL=0
note() { printf '  %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAIL=1; }
head_() { printf '\n%s\n' "$*"; }

if [ "${1:-}" = "--all" ]; then
  FILES=$(git ls-files)
else
  BASE=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo origin/main)
  FILES=$(git diff --name-only "$BASE"...HEAD 2>/dev/null; git diff --name-only; git diff --name-only --cached; git ls-files --others --exclude-standard)
  FILES=$(printf '%s\n' "$FILES" | sort -u | grep -v '^$')
fi

CHANGED_JS=$(printf '%s\n' "$FILES" | grep -E '\.(mjs|cjs|js)$' || true)
CHANGED_TS=$(printf '%s\n' "$FILES" | grep -E '\.ts$' || true)
CHANGED_WF=$(printf '%s\n' "$FILES" | grep -E '^\.github/workflows/.*\.ya?ml$' || true)

head_ "syntax: every changed JS file parses"
if [ -z "$CHANGED_JS" ]; then note "no JS files changed"; else
  for f in $CHANGED_JS; do
    [ -f "$f" ] || continue
    if ! node --check "$f" >/dev/null 2>&1; then
      fail "$f does not parse"
      node --check "$f" 2>&1 | head -3 | sed 's/^/       /'
    fi
  done
  note "$(printf '%s\n' $CHANGED_JS | wc -l | tr -d ' ') file(s) parse"
fi

head_ "identifiers: no undefined names in changed test .mjs files"
# The exact bug that wasted a runner round: a renamed variable still referenced.
# tsc with --checkJs resolves identifiers without needing types. Its other
# complaints (redeclared `log`, missing types in dist) are pre-existing noise and
# are filtered out by name, so only resolution errors fail the check.
TEST_JS=$(printf '%s\n' "$CHANGED_JS" | grep -E '^backend/test/.*\.mjs$' || true)
if [ -z "$TEST_JS" ]; then note "no test .mjs files changed"; else
  for f in $TEST_JS; do
    [ -f "$f" ] || continue
    OUT=$(npx --no-install tsc --noEmit --allowJs --checkJs --module nodenext \
      --moduleResolution nodenext --target es2022 --skipLibCheck "$f" 2>&1 \
      | grep -E 'TS2304|TS2552' || true)
    if [ -n "$OUT" ]; then
      fail "$f references a name that does not exist"
      printf '%s\n' "$OUT" | sed 's/^/       /' | head -5
    fi
  done
  [ "$FAIL" = "1" ] || note "no unresolved identifiers"
fi

head_ "workflow: run bodies are valid shell"
if [ -z "$CHANGED_WF" ]; then note "no workflow files changed"; else
  for f in $CHANGED_WF; do
    [ -f "$f" ] || continue
    # Extract every `run: |` block and shell-check it. A malformed step is
    # otherwise only discovered when the job starts.
    node -e '
      const fs = require("fs");
      const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
      let i = 0, n = 0;
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)run:\s*\|\s*$/);
        if (!m) { i++; continue; }
        const indent = m[1].length;
        const body = [];
        i++;
        while (i < lines.length) {
          const line = lines[i];
          if (line.trim() !== "" && (line.match(/^\s*/)[0].length) <= indent) break;
          body.push(line.replace(new RegExp("^ {" + (indent + 2) + "}"), ""));
          i++;
        }
        n++;
        fs.writeFileSync("/tmp/.chk-" + n + ".sh", body.join("\n"));
      }
      console.log(n);
    ' "$f" > /tmp/.chk-count 2>/dev/null
    COUNT=$(cat /tmp/.chk-count 2>/dev/null || echo 0)
    for n in $(seq 1 "${COUNT:-0}"); do
      if ! bash -n "/tmp/.chk-$n.sh" 2>/dev/null; then
        fail "$f run block #$n is not valid shell"
        bash -n "/tmp/.chk-$n.sh" 2>&1 | head -3 | sed 's/^/       /'
      fi
    done
    rm -f /tmp/.chk-*.sh /tmp/.chk-count
    note "$f: ${COUNT:-0} run block(s) checked"
  done
fi

head_ "workflow: every probe the job runs is also a trigger path"
# A probe wired into a step but missing from `on.push.paths` never re-runs when
# only the probe changes — the edit looks deployed and is silently ignored.
WF=.github/workflows/source-independence.yml
if [ -f "$WF" ]; then
  MISSING=0
  for script in $(grep -oE 'scripts/research/[A-Za-z0-9_.-]+\.mjs' "$WF" | sort -u); do
    grep -q "'$script'" "$WF" || { fail "$script runs in $WF but is not in its trigger paths"; MISSING=1; }
  done
  [ "$MISSING" = "0" ] && note "all probe scripts are trigger paths"
else
  note "$WF not present"
fi

head_ "manifest: every source module is reachable from APPROVED_SOURCES"
if [ -f backend/src/sources/index.ts ]; then
  for mod in backend/src/sources/*.ts; do
    name=$(basename "$mod" .ts)
    case "$name" in
      index|types|lang|duration|liveness|media-sniff|mp4-audio|net-tap|probe-gate|registry|selection|self-test) continue ;;
    esac
    # citadel, greybox, nxsha, vidly are lanes; each must be imported by index.ts
    grep -q "from './$name.js'" backend/src/sources/index.ts \
      || fail "$name.ts exists but index.ts does not import it"
  done
  note "checked $(ls backend/src/sources/*.ts | wc -l | tr -d ' ') module(s)"
fi

printf '\n'
if [ "$FAIL" = "1" ]; then
  printf 'NOT SAFE TO PUSH — fix the above first.\n'
  exit 1
fi

cat <<'EOF'
clean at the cheap layer.

  This sandbox reaches NONE of the providers. Nothing above proves a source
  works, a page parses, or a manifest plays. Anything that needs the network
  must run on a runner:

      git push origin HEAD
      gh run list --branch "$(git rev-parse --abbrev-ref HEAD)" --limit 3 \
        --json name,status,conclusion,headSha
      gh run watch <run-id> --exit-status     # then read the committed verdict

  Do not sleep-and-hope, and do not conclude from a sandbox TypeError that a
  provider is dead.
EOF
