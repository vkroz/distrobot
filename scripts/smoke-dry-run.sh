#!/usr/bin/env bash
# End-to-end dry-run smoke test against a running server (npm run dev / npm start).
# Uploads a small file, creates a post targeting all 7 platforms, runs the worker,
# and asserts every job is published. Requires: curl, node.
#   BASE=http://localhost:3000 scripts/smoke-dry-run.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3000}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(eval('o'+process.argv[1]))})" "$1"; }

echo "1. health";   curl -fsS "$BASE/api/health"; echo

echo "2. upload a small fake video (metadata as the browser would send it)"
head -c 200000 /dev/urandom > "$TMP/clip.mp4"
MEDIA_ID=$(curl -fsS -X POST "$BASE/api/media?filename=clip.mp4&durationSec=30&width=1080&height=1920" \
  -H 'Content-Type: video/mp4' --data-binary @"$TMP/clip.mp4" | json '.media.id')
echo "   media $MEDIA_ID"

echo "3. create a post targeting all platforms (dryRun forces simulation even if credentials are set)"
POST_ID=$(curl -fsS -X POST "$BASE/api/posts" -H 'Content-Type: application/json' -d @- <<JSON | json '.post.id'
{"title":"Smoke test","caption":"Dry-run smoke test","hashtags":["smoke"],"mediaId":"$MEDIA_ID",
 "visibility":"public","action":"publish","dryRun":true,
 "targets":[{"platform":"youtube"},{"platform":"tiktok"},{"platform":"instagram"},{"platform":"x"},
            {"platform":"facebook"},{"platform":"linkedin"},{"platform":"vimeo"}]}
JSON
)
echo "   post $POST_ID"

echo "4. run the worker (waits for all due jobs)"
printf '   '; curl -fsS -X POST "$BASE/api/jobs/run" | json '.processed.length + " job(s) finished by this request (the background worker may have run the others)"'

echo "5. check results"
curl -fsS "$BASE/api/posts/$POST_ID" > "$TMP/post.json"
node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).post;
for (const t of p.targets) console.log(`   ${t.platform.padEnd(10)} ${t.job.status.padEnd(10)} ${t.job.resultUrl ?? t.job.error}`);
console.log(`   post status: ${p.status}`);
const bad = p.targets.filter(t => t.job.status !== "published");
if (p.targets.length !== 7 || bad.length || p.status !== "published") { console.error("FAIL"); process.exit(1); }
console.log("OK: all 7 platforms published (dry-run)");' "$TMP/post.json"

echo "6. dry-run preview page renders"
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).post.targets[0].job.resultUrl)' "$TMP/post.json")
curl -fsS -o /dev/null -w "   GET $URL -> %{http_code}\n" "$BASE$URL"
