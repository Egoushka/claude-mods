#!/usr/bin/env bash
# Type-checks, validates and tests every mod. TYPES points at a claude-code.d.ts
# (the engine writes one into each loaded mod's .claude-plugin/types/).
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tsc=${TSC:-npx -y -p typescript@5.6.3 tsc}
fail=0
for mod in "$root"/mods/*/; do
  name=$(basename "$mod")
  mkdir -p "$root/.check"; cfg="$root/.check/tsconfig.$name.json"
  cat > "$cfg" <<JSON
{ "compilerOptions": { "target": "es2023", "lib": ["es2023"], "types": [], "module": "esnext",
    "moduleResolution": "bundler", "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment" },
  "include": ["${TYPES:?set TYPES to claude-code.d.ts}", "${mod}hooks", "${mod}types"] }
JSON
  echo "== $name"
  $tsc -p "$cfg" | sed "s#.*/mods/#mods/#" || fail=1
  out=$(claude plugin validate "$mod" 2>&1) || { echo "$out"; fail=1; }
  if ls "$mod"tests/*.test.ts >/dev/null 2>&1; then claude plugin test "$mod" || fail=1; fi
done
exit $fail
