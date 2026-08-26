#!/usr/bin/env bash

set -euo pipefail

release_command_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$release_command_dir/lib.sh"

if (( $# != 0 )); then
  release_usage_error 'gate does not accept arguments; it is always strict.'
fi

cd "$RELEASE_ROOT"

gate_tmp=$(mktemp -d "${TMPDIR:-/tmp}/zudo-history-stash-release-gate.XXXXXX")
cleanup() {
  local status=$?
  rm -rf -- "$gate_tmp" || true
  exit "$status"
}
trap cleanup EXIT

core_package_dir="$RELEASE_ROOT/packages/core"
client_package_dir="$RELEASE_ROOT/packages/client"
core_package_name='@takazudo/zudo-history-stash-core'
client_package_name='@takazudo/zudo-history-stash'

version=$(current_version)
if [[ -z "$version" ]]; then
  release_error 'Could not determine the current package version.'
  exit 1
fi

assert_version_files() {
  local package_file=$1
  local source_file=$2
  local package_version
  local source_version

  package_version=$(release_package_version "$package_file")
  source_version=$(release_version_constant "$source_file")
  if [[ "$package_version" != "$version" ]]; then
    release_error "$package_file has version $package_version; expected $version."
    exit 1
  fi
  if [[ "$source_version" != "$version" ]]; then
    release_error "$source_file has VERSION $source_version; expected $version."
    exit 1
  fi
}

assert_version_files \
  "$core_package_dir/package.json" \
  "$core_package_dir/src/index.ts"
assert_version_files \
  "$client_package_dir/package.json" \
  "$client_package_dir/src/index.ts"

openapi_version=$(release_openapi_version)
if [[ "$openapi_version" != "$version" ]]; then
  release_error "$RELEASE_ROOT/docs/openapi.json has info.version $openapi_version; expected $version. Run pnpm openapi:generate after bumping."
  exit 1
fi

printf 'Building libraries for release gate (%s).\n' "$version"
pnpm build:libs

pack_package() {
  local package_dir=$1
  local package_label=$2
  local destination="$gate_tmp/$package_label"
  local listing="$destination/contents.txt"
  local tarball
  local -a tarballs

  mkdir -p "$destination"
  node - "$package_dir/package.json" "$package_label" <<'NODE'
const fs = require("node:fs");

const [packageFile, packageLabel] = process.argv.slice(2);
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const files = packageJson.files;
const requiredFiles = ["README.md", "CHANGELOG.md", "LICENSE"];
if (!Array.isArray(files) || requiredFiles.some((entry) => !files.includes(entry))) {
  throw new Error(`${packageLabel} package.json files must include ${requiredFiles.join(", ")}`);
}
NODE
  printf 'Running pinned package checks for %s.\n' "$package_label"
  (
    cd "$package_dir"
    pnpm run lint:pkg
  )

  printf 'Packing %s.\n' "$package_label"
  (
    cd "$package_dir"
    pnpm pack --pack-destination "$destination"
  )
  shopt -s nullglob
  tarballs=("$destination"/*.tgz)
  shopt -u nullglob
  if (( ${#tarballs[@]} != 1 )); then
    release_error "Expected exactly one tarball for $package_label in $destination."
    exit 1
  fi
  tarball=${tarballs[0]}

  tar -tzf "$tarball" >"$listing"
  for required_entry in \
    'package/README.md' \
    'package/CHANGELOG.md' \
    'package/LICENSE' \
    'package/package.json'; do
    if ! grep -Fxq "$required_entry" "$listing"; then
      release_error "$package_label tarball is missing $required_entry."
      exit 1
    fi
  done
  if ! grep -Eq '^package/dist(/|$)' "$listing"; then
    release_error "$package_label tarball is missing package/dist/."
    exit 1
  fi
  if grep -Eq '^package/src(/|$)' "$listing"; then
    release_error "$package_label tarball unexpectedly contains package/src/."
    exit 1
  fi

  packed_tarball=$tarball
}

packed_tarball=''
pack_package "$core_package_dir" core
core_tarball=$packed_tarball
pack_package "$client_package_dir" client
client_tarball=$packed_tarball

client_manifest="$gate_tmp/client-package.json"
tar -xOzf "$client_tarball" package/package.json >"$client_manifest"
node - "$client_manifest" "$version" <<'NODE'
const fs = require("node:fs");

const [manifestPath, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const dependency = manifest.dependencies?.["@takazudo/zudo-history-stash-core"];
if (dependency !== expectedVersion) {
  throw new Error(
    `Packed client core dependency is ${JSON.stringify(dependency)}; expected ${expectedVersion}`,
  );
}
NODE
printf 'Packed client workspace dependency rewritten to %s.\n' "$version"

smoke_dir="$gate_tmp/smoke"
mkdir "$smoke_dir"
(
  cd "$smoke_dir"
  pnpm init
  node - "$core_tarball" <<'NODE'
const fs = require("node:fs");

const [coreTarball] = process.argv.slice(2);
const packageFile = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
packageJson.pnpm = {
  ...(packageJson.pnpm ?? {}),
  overrides: {
    ...(packageJson.pnpm?.overrides ?? {}),
    "@takazudo/zudo-history-stash-core": `file:${coreTarball}`,
  },
};
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
NODE
  pnpm add "$core_tarball" "$client_tarball"
  EXPECTED_VERSION="$version" node -e '
    (async () => {
      const [{ VERSION: coreVersion }, { VERSION: clientVersion }] = await Promise.all([
        import("@takazudo/zudo-history-stash-core"),
        import("@takazudo/zudo-history-stash"),
      ]);
      const expectedVersion = process.env.EXPECTED_VERSION;
      if (coreVersion !== expectedVersion || clientVersion !== expectedVersion) {
        throw new Error(
          `Tarball VERSION mismatch: core=${coreVersion}, client=${clientVersion}, expected=${expectedVersion}`,
        );
      }
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  '
)
printf 'Install-from-tarball VERSION smoke passed for %s.\n' "$version"

printf 'Running publish dry-run for %s.\n' "$core_package_name"
(
  cd "$core_package_dir"
  pnpm publish --dry-run --no-git-checks
)
printf 'Running publish dry-run for %s.\n' "$client_package_name"
(
  cd "$client_package_dir"
  pnpm publish --dry-run --no-git-checks
)

printf 'Release packaging gate passed for %s.\n' "$version"
