#!/usr/bin/env bash
set -euo pipefail
sha=${1:?commit SHA required}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ $(git rev-parse HEAD) == "$sha" ]] || exit 2
[[ $(git status --porcelain --untracked-files=no) == '' ]] || { echo 'Checkout is dirty'; exit 2; }
exec 9>/var/lib/fde-ci/release.lock
flock -n 9 || { echo 'Another Station release is active'; exit 3; }
workspace=$(pwd -P)
uid=$(id -u); gid=$(id -g)
mkdir -p /var/lib/fde-ci/npm-cache
tools_image=ghcr.io/erixwong/erix-station-portal@sha256:e6c5a80a7ea299645139a37a3c4197a41f2f82f5f78d3eb96033275458cd019b
docker pull "$tools_image"
run_node() {
  docker run --rm --init --entrypoint bash --user "$uid:$gid" --network "$1" -e HOME=/tmp -e NODE_ENV=development \
    -e npm_config_cache=/npm-cache -v /var/lib/fde-ci/npm-cache:/npm-cache \
    -v "$workspace:/work" -w /work "$tools_image" -euo pipefail -c "$2"
}
python3 deploy/ci/check-base.py
run_node bridge 'npm ci --prefer-offline; (cd runner && npm ci --prefer-offline); (cd portal/frontend && npm ci --prefer-offline)'
run_node none 'git config --global --add safe.directory /work; while IFS= read -r -d "" file; do node --check "$file"; done < <(git ls-files -z -- "*.js" "*.mjs"); timeout 300 npm test; cd portal/frontend; timeout 240 npm run typecheck; timeout 240 npm test; timeout 240 npm run build'
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
common=(--provenance=false --sbom=false --label "org.opencontainers.image.revision=$sha")
docker build "${common[@]}" --build-arg "STATION_REVISION=$sha" --build-arg "STATION_BUILD_DATE=$built_at" \
  -f deploy/ci/Dockerfile.portal -t "inteva/fde-portal:$sha" .
docker build "${common[@]}" --build-arg "STATION_REVISION=$sha" --build-arg "STATION_BUILD_DATE=$built_at" \
  -f deploy/ci/Dockerfile.runner -t "inteva/fde-runner:$sha" .
docker build "${common[@]}" -f deploy/ci/Dockerfile.proxy -t "inteva/fde-proxy:$sha" .
# Check the actual image as both runtime identities before touching live services.
for runtime_uid in 1001 1002; do
  docker run --rm --network none --read-only --cap-drop ALL --user "$runtime_uid:1000" \
    --entrypoint node "inteva/fde-runner:$sha" --check /opt/erix/agentd.js
  docker run --rm --network none --read-only --cap-drop ALL --user "$runtime_uid:1000" \
    --entrypoint node "inteva/fde-runner:$sha" --check /opt/erix/worker.js
  docker run --rm --network none --read-only --cap-drop ALL --user "$runtime_uid:1000" \
    --entrypoint node "inteva/fde-runner:$sha" --input-type=module -e \
    'import fs from "node:fs"; import "erix-agent"; import "erix-agent/tools"; const scan=p=>{const s=fs.statSync(p);fs.accessSync(p,fs.constants.R_OK|(s.isDirectory()?fs.constants.X_OK:0));if(s.isDirectory())for(const n of fs.readdirSync(p))scan(`${p}/${n}`)};scan("/opt/erix");console.log(`Runtime UID ${process.getuid()}: image files readable and engine imports OK`);'
done
python3 - "$sha" <<'PY'
import json,pathlib,subprocess,sys
sha=sys.argv[1]
images={name:subprocess.check_output(['docker','image','inspect',f'inteva/fde-{name}:{sha}','--format','{{.Id}}'],text=True).strip() for name in ['portal','runner','proxy']}
pathlib.Path('release-manifest.json').write_text(json.dumps({'revision':sha,'images':images},indent=2)+'\n')
PY
sudo -n /usr/local/sbin/fde-station-promote "$workspace" "$sha"
