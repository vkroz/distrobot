#!/usr/bin/env bash
# End-to-end dry-run smoke test against a running server (npm run dev / npm start).
#   BASE=http://localhost:3000 APP_USERNAME=admin APP_PASSWORD=admin scripts/smoke-dry-run.sh
# Covers: login, 401 without session, upload (+ ffprobe when a real video can be generated),
# draft create → edit → publish to all 7 platforms, worker run, results, delete, logout.
# Requires: curl, node. Uses ffmpeg (optional) to generate a real test video.
set -euo pipefail
BASE=${BASE:-http://localhost:3000}
USER=${APP_USERNAME:-admin}
PASS=${APP_PASSWORD:-admin}
TMP=$(mktemp -d)
JAR="$TMP/cookies.txt"
trap 'rm -rf "$TMP"' EXIT
# json '<JS expression over o>' — evaluates the expression against the JSON on stdin.
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }
c() { curl -fsS -b "$JAR" -c "$JAR" "$@"; }

echo "1. health (public)";  curl -fsS "$BASE/api/health"; echo
echo "2. APIs require login"; curl -s -o /dev/null -w "   GET /api/posts without session -> %{http_code}\n" "$BASE/api/posts"
echo "3. log in as $USER"
c -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | json '"   " + JSON.stringify(o)'

echo "4. upload a video"
if command -v ffmpeg >/dev/null; then
  # Noise keeps the file above LinkedIn's 75 KB minimum.
  ffmpeg -v error -f lavfi -i testsrc=size=540x960:rate=25:duration=4 -vf noise=alls=60:allf=t -pix_fmt yuv420p -y "$TMP/clip.mp4"
  QS="filename=clip.mp4&durationSec=99&width=1&height=1"   # deliberately wrong browser values: ffprobe must win
else
  head -c 200000 /dev/urandom > "$TMP/clip.mp4"
  QS="filename=clip.mp4&durationSec=30&width=1080&height=1920" # not a real video: browser values are used
fi
c -X POST "$BASE/api/media?$QS" -H 'Content-Type: video/mp4' --data-binary @"$TMP/clip.mp4" > "$TMP/media.json"
MEDIA_ID=$(json 'o.media.id' < "$TMP/media.json")
json '"   media " + o.media.id + ": " + o.media.durationSec + "s " + o.media.width + "x" + o.media.height + " (source: " + o.media.metadataSource + ")"' < "$TMP/media.json"

TARGETS='[{"platform":"youtube"},{"platform":"tiktok","settings":{"privacyLevel":"PUBLIC_TO_EVERYONE","allowComment":true}},
  {"platform":"instagram"},{"platform":"x"},{"platform":"facebook"},{"platform":"linkedin"},{"platform":"vimeo"}]'

echo "5. save a draft, then edit it"
DRAFT_ID=$(c -X POST "$BASE/api/posts" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Draft\",\"caption\":\"First version\",\"hashtags\":[],\"mediaId\":\"$MEDIA_ID\",\"visibility\":\"public\",\"action\":\"draft\",\"targets\":[{\"platform\":\"youtube\"}]}" \
  | json 'o.post.id')
c -X PUT "$BASE/api/posts/$DRAFT_ID" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Smoke test\",\"caption\":\"Dry-run smoke test\",\"hashtags\":[\"smoke\"],\"mediaId\":\"$MEDIA_ID\",\"visibility\":\"public\",\"action\":\"draft\",\"targets\":$TARGETS}" \
  | json '"   draft " + o.post.id + " status=" + o.post.status + " targets=" + o.targets.length'

echo "6. TikTok creator info for the posting screen"
c "$BASE/api/tiktok/creator-info" | json '"   source=" + o.source + " (" + (o.reason ?? "") + ") nickname=" + o.creator.nickname + " privacy options=" + o.creator.privacyLevelOptions.join(",")'

echo "7. publish the draft now (dryRun forces simulation even if credentials are set)"
c -X POST "$BASE/api/posts/$DRAFT_ID/publish" -H 'Content-Type: application/json' -d '{"scheduledAt":null,"dryRun":true}' \
  | json '"   " + o.jobs.length + " job(s) queued"'
POST_ID=$DRAFT_ID

echo "8. run the worker (waits for all due jobs)"
printf '   '; c -X POST "$BASE/api/jobs/run" | json 'o.processed.length + " job(s) finished by this request (the background worker may have run the others)"'

echo "9. check results"
c "$BASE/api/posts/$POST_ID" > "$TMP/post.json"
node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).post;
for (const t of p.targets) console.log(`   ${t.platform.padEnd(10)} ${t.job.status.padEnd(10)} ${t.job.resultUrl ?? t.job.error}`);
console.log(`   post status: ${p.status}`);
const bad = p.targets.filter(t => t.job.status !== "published");
if (p.targets.length !== 7 || bad.length || p.status !== "published") { console.error("FAIL"); process.exit(1); }
console.log("OK: all 7 platforms published (dry-run)");' "$TMP/post.json"
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).post.targets[0].job.resultUrl)' "$TMP/post.json")
c -o /dev/null -w "   GET $URL -> %{http_code}\n" "$BASE$URL"

echo "10. published posts can't be edited; a throwaway draft can be deleted"
curl -s -b "$JAR" -o /dev/null -w "   PUT published post -> %{http_code} (expected 409)\n" -X PUT "$BASE/api/posts/$POST_ID" -H 'Content-Type: application/json' \
  -d "{\"title\":\"x\",\"mediaId\":\"$MEDIA_ID\",\"action\":\"draft\"}" || true
TMP_ID=$(c -X POST "$BASE/api/posts" -H 'Content-Type: application/json' -d '{"title":"Throwaway idea","action":"draft"}' | json 'o.post.id')
c -o /dev/null -w "   DELETE draft -> %{http_code}\n" -X DELETE "$BASE/api/posts/$TMP_ID"

echo "11. log out"
c -o /dev/null -X DELETE "$BASE/api/session"
curl -s -b "$JAR" -o /dev/null -w "   GET /api/posts after logout -> %{http_code}\n" "$BASE/api/posts"
