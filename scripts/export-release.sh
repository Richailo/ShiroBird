#!/usr/bin/env bash
# Export tested image set and reproducible source distribution for another Docker host.
set -euo pipefail
cd "$(dirname "$0")/.."
version="0.1.0-rc.1"
registry="ghcr.io/richailo"
mkdir -p releases
images=(
  "$registry/shirobird:$version"
  "$registry/shirobird-customize:$version"
  "$registry/shirobird-bridge:$version"
  "$registry/shirobird-native-flow:$version"
)
for image in "${images[@]}"; do docker image inspect "$image" >/dev/null; done
docker save "${images[@]}" | gzip -1 > "releases/shirobird-images-$version-linux-amd64.tar.gz"
tar -czf "releases/shirobird-docker-$version-src.tar.gz" \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='*.log' \
  --exclude='extensions/native-flow/flow-secret' \
  --exclude='extensions/native-flow/api-token' \
  --exclude='extensions/native-flow/.env' \
  --exclude='extensions/native-flow/.data' \
  --exclude='extensions/native-flow/production-before.json' \
  Dockerfile LICENSE README.md .dockerignore .env.example \
  compose.release.yaml compose.release.netbird.yaml \
  compose.release.native.yaml compose.release.build.yaml \
  compose.release.build.netbird.yaml compose.release.build.native.yaml \
  packaging/docker/ scripts/ tests/ \
  shirobird/ web/ integration/ extensions/native-flow/ \
  extensions/management-adapter/ docs/docker-release.md \
  docs/netbird-tab.md docs/security.md .github/workflows/publish-docker.yml
sha256sum "releases/shirobird-images-$version-linux-amd64.tar.gz" \
  "releases/shirobird-docker-$version-src.tar.gz" \
  > "releases/shirobird-$version.sha256"
echo "Images: releases/shirobird-images-$version-linux-amd64.tar.gz"
echo "Source: releases/shirobird-docker-$version-src.tar.gz"
echo "Checksums: releases/shirobird-$version.sha256"
