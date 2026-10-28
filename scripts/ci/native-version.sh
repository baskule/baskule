#!/usr/bin/env bash
# Source before any native build. Mobile bundle versions cannot contain SemVer suffixes.
export NATIVE_VERSION="${NATIVE_VERSION:-$(<"$ROOT/VERSION")}"
T3CODE_MOBILE_VERSION=$(node --input-type=module <<'JS'
const version = process.env.NATIVE_VERSION;
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
if (!match || match[4]?.split('.').some(value => /^\d+$/.test(value) && value.length > 1 && value.startsWith('0'))) {
  throw new Error('NATIVE_VERSION must be valid SemVer without a leading v');
}
console.log(`${match[1]}.${match[2]}.${match[3]}`);
JS
)
export T3CODE_MOBILE_VERSION
export BASKULE_MOBILE_BUILD_NUMBER="${BASKULE_MOBILE_BUILD_NUMBER:-1}"
