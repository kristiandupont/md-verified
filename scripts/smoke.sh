#!/usr/bin/env bash
# End-to-end install test: pack the package, install it into a throwaway
# project, and drive the CLI the way a real consumer would.
#
# This is the only test that exercises the *published shape*. Two bugs that the
# normal suite could not see were caught here: a runtime dependency left in
# devDependencies, and shipping TypeScript that made consumers typecheck our
# source.
#
# Usage: scripts/smoke.sh [node|bun]
set -euo pipefail

RUNTIME="${1:-node}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> building and packing"
cd "$ROOT"
bun run build >/dev/null
TARBALL="$(bun pm pack --destination "$WORK" 2>/dev/null | grep -o '[^ ]*\.tgz$' || true)"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || TARBALL="$(ls "$WORK"/*.tgz | head -1)"

echo "==> creating a consumer project in $WORK"
mkdir -p "$WORK/app/src" "$WORK/app/docs"
cd "$WORK/app"

cat > package.json <<'EOF'
{ "name": "smoke-app", "private": true, "type": "module" }
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "Preserve", "moduleResolution": "bundler", "target": "ESNext",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src", "docs"]
}
EOF

cat > src/plans.ts <<'EOF'
export function seatsFor(plan: string): number {
  return { solo: 1, team: 10 }[plan] ?? 0;
}
export function plans(): string[] { return ['solo', 'team']; }
EOF

cat > docs/plans.md <<'EOF'
# Plans

> 🛠️ **Verified Data:** `seats`
> **Schema:** `[plan: String, seats: Integer]`

| Plan | Seats |
| ---- | ----- |
| solo | 1     |
| team | 10    |

> 👁️ **Reviewed:** `sizing`
> **Covers:** `../src/plans.ts#seatsFor`

Seat counts are fixed per plan and not configurable.
EOF

cat > docs/plans.verify.ts <<'EOF'
import { verify, equals, covers } from 'md-verified';
import { seatsFor, plans } from '../src/plans';

verify.table('seats', (row) => equals(seatsFor(row.plan as string), row.seats, 'seats'));
verify.table.all('seats', (t) => covers(t.rows.map((r) => r['Plan'] as string), plans()));
EOF

echo "==> installing the tarball"
npm install --silent "$TARBALL" tsx >/dev/null 2>&1

BIN="node_modules/md-verified/dist/check.js"

# The glue above imports `../src/plans`, with no extension -- the norm in any
# project using bundler-style resolution, and something Node's ESM resolver
# rejects outright. Node therefore needs a loader; Bun resolves it natively.
if [ "$RUNTIME" = "node" ]; then
  LOADER=(--import tsx)
else
  LOADER=()
fi

CLI="$RUNTIME $BIN ${LOADER[*]}"

# Before anything else: the bare Node invocation must fail on that import, and
# must say what to do about it. This is the failure a first-time user meets.
if [ "$RUNTIME" = "node" ]; then
  echo "==> [node] an extensionless import without a loader must be explained"
  OUT="$(node "$BIN" docs/plans.md 2>&1 || true)"
  echo "$OUT" | grep -q "requires an extension on relative imports" \
    || { echo "FAIL: no resolver hint for an extensionless import"; echo "$OUT"; exit 1; }
  echo "    hint shown"
fi

echo "==> [$RUNTIME] a consumer typecheck must not see our source"
npx --yes tsc --noEmit

echo "==> [$RUNTIME] an unstamped review must fail"
if $CLI docs/plans.md >/dev/null 2>&1; then
  echo "FAIL: expected a non-zero exit for an unstamped review"; exit 1
fi

echo "==> [$RUNTIME] --stamp then pass"
$CLI docs/plans.md --stamp >/dev/null
grep -q '^> \*\*Digest:\*\* `1:' docs/plans.md || { echo "FAIL: no digest written"; exit 1; }
$CLI 'docs/**/*.md' >/dev/null

echo "==> [$RUNTIME] drift must fail, and be written back"
sed -i.bak 's/| team | 10    |/| team | 12    |/' docs/plans.md
if $CLI docs/plans.md --write >/dev/null 2>&1; then
  echo "FAIL: expected a non-zero exit for a drifted table"; exit 1
fi
grep -q '<!-- ERROR: row 2: seats: expected 12, got 10 -->' docs/plans.md \
  || { echo "FAIL: the failure was not written into the document"; exit 1; }

echo "==> [$RUNTIME] a stale review must be detected"
sed -i.bak 's/| team | 12    |/| team | 10    |/' docs/plans.md
$CLI docs/plans.md --stamp >/dev/null
sed -i.bak 's/team: 10/team: 11/' src/plans.ts
# Capture first: with `pipefail`, piping a deliberately-failing command into
# grep would report the command's exit status, not the match.
OUT="$($CLI docs/plans.md 2>&1 || true)"
if echo "$OUT" | grep -q 'changed since this section was last read'; then
  echo "    stale review detected"
else
  echo "FAIL: a changed covered symbol did not go stale"
  echo "$OUT"
  exit 1
fi

echo "==> [$RUNTIME] smoke test passed"
