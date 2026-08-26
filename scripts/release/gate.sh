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
ui_package_dir="$RELEASE_ROOT/packages/ui"
core_package_name='@takazudo/zudo-history-stash-core'
client_package_name='@takazudo/zudo-history-stash'
ui_package_name='@takazudo/zudo-history-stash-ui'

if ! version=$(release_lockstep_version); then
  exit 1
fi

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

  printf 'Running pinned package checks for %s.\n' "$package_label"
  (
    cd "$package_dir"
    pnpm run lint:pkg -- "$tarball"
  )

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
  if [[ "$package_label" == 'ui' ]]; then
    for required_entry in \
      'package/dist/styles.css' \
      'package/styles/tokens.example.css'; do
      if ! grep -Fxq "$required_entry" "$listing"; then
        release_error "$package_label tarball is missing $required_entry."
        exit 1
      fi
    done
  fi

  packed_tarball=$tarball
}

packed_tarball=''
pack_package "$core_package_dir" core
core_tarball=$packed_tarball
pack_package "$client_package_dir" client
client_tarball=$packed_tarball
pack_package "$ui_package_dir" ui
ui_tarball=$packed_tarball

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

ui_manifest="$gate_tmp/ui-package.json"
tar -xOzf "$ui_tarball" package/package.json >"$ui_manifest"
node - "$ui_manifest" "$version" <<'NODE'
const fs = require("node:fs");

const [manifestPath, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const dependencyName of [
  "@takazudo/zudo-history-stash-core",
  "@takazudo/zudo-history-stash",
]) {
  const dependency = manifest.dependencies?.[dependencyName];
  if (dependency !== expectedVersion) {
    throw new Error(
      `Packed UI dependency ${dependencyName} is ${JSON.stringify(dependency)}; expected ${expectedVersion}`,
    );
  }
}
NODE
printf 'Packed UI workspace dependencies rewritten to %s.\n' "$version"

smoke_dir="$gate_tmp/smoke"
mkdir "$smoke_dir"
(
  cd "$smoke_dir"
  pnpm init
  node - "$core_tarball" "$client_tarball" <<'NODE'
const fs = require("node:fs");

const [coreTarball, clientTarball] = process.argv.slice(2);
const packageFile = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
packageJson.pnpm = {
  ...(packageJson.pnpm ?? {}),
  overrides: {
    ...(packageJson.pnpm?.overrides ?? {}),
    "@takazudo/zudo-history-stash-core": `file:${coreTarball}`,
    "@takazudo/zudo-history-stash": `file:${clientTarball}`,
  },
};
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
NODE
  pnpm --store-dir "$gate_tmp/pnpm-store" add "$core_tarball" "$client_tarball" "$ui_tarball"
  EXPECTED_VERSION="$version" node -e '
    (async () => {
      const [{ VERSION: coreVersion }, { VERSION: clientVersion }, { VERSION: uiVersion }] = await Promise.all([
        import("@takazudo/zudo-history-stash-core"),
        import("@takazudo/zudo-history-stash"),
        import("@takazudo/zudo-history-stash-ui"),
      ]);
      const expectedVersion = process.env.EXPECTED_VERSION;
      if (
        coreVersion !== expectedVersion ||
        clientVersion !== expectedVersion ||
        uiVersion !== expectedVersion
      ) {
        throw new Error(
          `Tarball VERSION mismatch: core=${coreVersion}, client=${clientVersion}, ui=${uiVersion}, expected=${expectedVersion}`,
        );
      }
      const styles = require.resolve("@takazudo/zudo-history-stash-ui/styles.css");
      if (!require("node:fs").readFileSync(styles, "utf8").includes(".zhs-button")) {
        throw new Error("The installed UI stylesheet export is missing package component CSS");
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
printf 'Running publish dry-run for %s.\n' "$ui_package_name"
(
  cd "$ui_package_dir"
  pnpm publish --dry-run --no-git-checks
)

printf 'Release packaging gate passed for %s.\n' "$version"
