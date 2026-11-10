#!/usr/bin/env bash
# The "Run QA agent" step of action.yml. Runs from the action's folder; inputs
# arrive as env vars (see action.yml). Kept as a file so it can be tested
# outside GitHub (test/action-sim.ts).
set -uo pipefail

ws="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is not set}"
abs() { case "$1" in /*) echo "$1" ;; .|./) echo "$ws" ;; *) echo "$ws/${1#./}" ;; esac; }

config="$(abs "${CONFIG:-qa.config.ts}")"
# Only override the config's backend.dir when the input is set; git commands run from it or the repo root
backend="$ws"
[ -n "${BACKEND_DIR:-}" ] && backend="$(abs "$BACKEND_DIR")"
out="${OUT_DIR:-$ws/qa-out}"

if [ ! -f "$config" ]; then
  echo "::error title=QA Agent::Config not found: ${CONFIG:-qa.config.ts}. Add one to your repository (the platform's CI tab generates it)."
  echo "code=2" >> "$GITHUB_OUTPUT"
  exit 0
fi

args=(run --suite "${SUITE:-pr}" -c "$config" --out "$out" --github)
[ -n "${BACKEND_DIR:-}" ] && args+=(--backend-dir "$backend")
[ -n "${BASE_URL:-}" ] && args+=(--base-url "$BASE_URL")

# PR runs only test the routes the PR touches: diff against the base branch
changed="${CHANGED_FROM:-auto}"
if [ "$changed" = "auto" ]; then
  changed=""
  [ -n "${GITHUB_BASE_REF:-}" ] && changed="origin/$GITHUB_BASE_REF"
fi
if [ -n "$changed" ]; then
  if ! git -C "$backend" rev-parse --verify --quiet "$changed^{commit}" >/dev/null; then
    # Shallow checkout: fetch the base branch so the diff can be computed
    git -C "$backend" fetch --no-tags --quiet origin "${changed#origin/}" 2>/dev/null || true
    git -C "$backend" fetch --no-tags --quiet --deepen=500 2>/dev/null || true
  fi
  if git -C "$backend" rev-parse --verify --quiet "$changed^{commit}" >/dev/null && git -C "$backend" merge-base "$changed" HEAD >/dev/null 2>&1; then
    args+=(--changed-from "$changed")
  else
    echo "::warning title=QA Agent::Couldn't diff against $changed (use actions/checkout with fetch-depth: 0). Testing all routes."
  fi
fi

if [ -n "${QA_PLATFORM_URL:-}" ] && [ -n "${QA_PLATFORM_API_KEY:-}" ]; then
  args+=(--upload)
  [ "${PLATFORM_ACCOUNTS:-false}" = "true" ] && args+=(--platform-accounts)
  [ "${AFTER_DEPLOY:-false}" = "true" ] && args+=(--after-deploy)
elif [ -n "${QA_PLATFORM_URL:-}${QA_PLATFORM_API_KEY:-}" ]; then
  echo "::warning title=QA Agent::Set both platform-url and platform-api-key to upload the run. Not uploading."
fi

echo "qa ${args[*]}"
node --import tsx src/cli.ts "${args[@]}"
code=$?
echo "code=$code" >> "$GITHUB_OUTPUT"
# The agent writes report-dir itself with --github; make sure it's set even if it stopped early
if [ -d "$out" ] && ! grep -q '^report-dir=' "$GITHUB_OUTPUT" 2>/dev/null; then echo "report-dir=$out" >> "$GITHUB_OUTPUT"; fi
exit 0
