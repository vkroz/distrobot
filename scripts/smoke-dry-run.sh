#!/usr/bin/env bash
# End-to-end dry-run smoke test against a running server (python -m distrobot).
#   BASE=http://localhost:8000 APP_USERNAME=admin APP_PASSWORD=admin scripts/smoke-dry-run.sh
# Covers: login, 401 without session, upload (+ ffprobe when a real video can be generated),
# draft create → edit → publish to all 7 platforms, worker run, results, delete, logout.
# Requires: curl, python3. Uses ffmpeg (optional) to generate a real test video.
set -euo pipefail
BASE=${BASE:-http://localhost:8000}
USER=${APP_USERNAME:-admin}
PASS=${APP_PASSWORD:-admin}
TMP=$(mktemp -d)
JAR="$TMP/cookies.txt"
trap 'rm -rf "$TMP"' EXIT
# json '<Python expression over o>' — evaluates the expression against the JSON on stdin.
json() { python3 -c 'import json,sys; o=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }
c() { curl -fsS -b "$JAR" -c "$JAR" "$@"; }

echo "1. health (public)";  curl -fsS "$BASE/api/health"; echo
echo "2. APIs require login"; curl -s -o /dev/null -w "   GET /api/posts without session -> %{http_code}\n" "$BASE/api/posts"
echo "3. log in as $USER"
c -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | json '"   " + json.dumps(o)'

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
MEDIA_ID=$(json 'o["media"]["id"]' < "$TMP/media.json")
json '"   media {id}: {durationSec}s {width}x{height} (source: {metadataSource})".format(**o["media"])' < "$TMP/media.json"

TARGETS='[{"platform":"youtube"},{"platform":"tiktok","settings":{"privacyLevel":"PUBLIC_TO_EVERYONE","allowComment":true}},
  {"platform":"instagram"},{"platform":"x"},{"platform":"facebook"},{"platform":"linkedin"},{"platform":"vimeo"}]'

echo "5. save a draft, then edit it"
DRAFT_ID=$(c -X POST "$BASE/api/posts" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Draft\",\"caption\":\"First version\",\"hashtags\":[],\"mediaId\":\"$MEDIA_ID\",\"visibility\":\"public\",\"action\":\"draft\",\"targets\":[{\"platform\":\"youtube\"}]}" \
  | json 'o["post"]["id"]')
c -X PUT "$BASE/api/posts/$DRAFT_ID" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Smoke test\",\"caption\":\"Dry-run smoke test\",\"hashtags\":[\"smoke\"],\"mediaId\":\"$MEDIA_ID\",\"visibility\":\"public\",\"action\":\"draft\",\"targets\":$TARGETS}" \
  | json '"   draft {} status={} targets={}".format(o["post"]["id"], o["post"]["status"], len(o["targets"]))'

echo "6. TikTok creator info for the posting screen"
c "$BASE/api/tiktok/creator-info" | json '"   source={} ({}) nickname={} privacy options={}".format(o["source"], o.get("reason") or "", o["creator"]["nickname"], ",".join(o["creator"]["privacyLevelOptions"]))'

echo "7. publish the draft now (dryRun forces simulation even if credentials are set)"
c -X POST "$BASE/api/posts/$DRAFT_ID/publish" -H 'Content-Type: application/json' -d '{"scheduledAt":null,"dryRun":true}' \
  | json '"   {} job(s) queued".format(len(o["jobs"]))'
POST_ID=$DRAFT_ID

echo "8. run the worker (waits for all due jobs)"
printf '   '; c -X POST "$BASE/api/jobs/run" | json '"{} job(s) finished by this request (the background worker may have run the others)".format(len(o["processed"]))'
# Background-started jobs may still be finishing.
for _ in $(seq 1 30); do
  c "$BASE/api/posts/$POST_ID" > "$TMP/post.json"
  [ "$(json 'o["post"]["status"]' < "$TMP/post.json")" = "publishing" ] || break
  sleep 0.5
done

echo "9. check results"
python3 - "$TMP/post.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))["post"]
for t in p["targets"]:
    print(f"   {t['platform']:<10} {t['job']['status']:<10} {t['job']['resultUrl'] or t['job']['error']}")
print(f"   post status: {p['status']}")
bad = [t for t in p["targets"] if t["job"]["status"] != "published"]
if len(p["targets"]) != 7 or bad or p["status"] != "published":
    sys.exit("FAIL")
print("OK: all 7 platforms published (dry-run)")
PY
URL=$(json 'o["post"]["targets"][0]["job"]["resultUrl"]' < "$TMP/post.json")
c -o /dev/null -w "   GET $URL -> %{http_code}\n" "$BASE$URL"

echo "10. published posts can't be edited; a throwaway draft can be deleted"
curl -s -b "$JAR" -o /dev/null -w "   PUT published post -> %{http_code} (expected 409)\n" -X PUT "$BASE/api/posts/$POST_ID" -H 'Content-Type: application/json' \
  -d "{\"title\":\"x\",\"mediaId\":\"$MEDIA_ID\",\"action\":\"draft\"}" || true
TMP_ID=$(c -X POST "$BASE/api/posts" -H 'Content-Type: application/json' -d '{"title":"Throwaway idea","action":"draft"}' | json 'o["post"]["id"]')
c -o /dev/null -w "   DELETE draft -> %{http_code}\n" -X DELETE "$BASE/api/posts/$TMP_ID"

echo "11. log out"
c -o /dev/null -X DELETE "$BASE/api/session"
curl -s -b "$JAR" -o /dev/null -w "   GET /api/posts after logout -> %{http_code}\n" "$BASE/api/posts"
