#!/usr/bin/env bash
# Region → mirror source ordering for scripts/fetch-models.sh.
#
# Sourced (never executed) by fetch-models.sh and by tests/cli/fetch-models.test.js.
# Pure bash: no network, no filesystem writes, no side effects, so the mapping can
# be unit-tested directly.
#
#   region: mainland | hmt | overseas | auto
#   source: modelscope | hf-mirror | ghproxy | github | hf
#
# "auto" is resolved by mirrors_guess_region() using the timezone/locale of the
# machine — deliberately local-only. There is no IP geolocation and no network
# probe: the guess is printed by fetch-models.sh and can always be overridden
# with --region / FIGARO_REGION / config.models.region.

FIGARO_MIRRORS_DEFAULT_HF="https://huggingface.co"
FIGARO_MIRRORS_DEFAULT_HF_MIRROR="https://hf-mirror.com"
FIGARO_MIRRORS_DEFAULT_MODELSCOPE_API="https://modelscope.cn/api/v1/models"
# GitHub 加速代理：按顺序尝试，单个节点失效时自动换下一个（与源 fallback 相互独立）。
FIGARO_MIRRORS_DEFAULT_GHPROXY_BASES=(
  "https://ghproxy.net/"
  "https://gh-proxy.com/"
  "https://ghfast.top/"
)

mirrors_valid_region() {
  case "${1:-}" in
    mainland|hmt|overseas) return 0 ;;
    *) return 1 ;;
  esac
}

mirrors_valid_source() {
  case "${1:-}" in
    modelscope|hf-mirror|ghproxy|github|hf) return 0 ;;
    *) return 1 ;;
  esac
}

# Source order per region, one source per line, most preferred first.
mirrors_region_chain() {
  case "${1:-}" in
    # 国内源优先；官方直连只作为最后兜底（可能被墙）。
    mainland) printf '%s\n' modelscope hf-mirror ghproxy github hf ;;
    # 港澳台/海外：GitHub Releases 与 HuggingFace 官方直连优先，国内镜像兜底。
    hmt|overseas) printf '%s\n' github hf modelscope hf-mirror ;;
    *) return 1 ;;
  esac
}

# Old FIGARO_MIRROR / --mirror override: pin one source first, keep the region
# chain as the fallback order (deduplicated).
mirrors_chain() { # <region> <mirror(auto|source)>
  local region="$1" mirror="${2:-auto}" source
  if [[ "$mirror" == "auto" ]]; then
    mirrors_region_chain "$region"
    return
  fi
  mirrors_valid_source "$mirror" || return 1
  printf '%s\n' "$mirror"
  mirrors_region_chain "$region" | while IFS= read -r source; do
    [[ "$source" == "$mirror" ]] || printf '%s\n' "$source"
  done
}

# --region=auto guess: timezone first, then locale. Never calls the network.
mirrors_guess_region() { # [locale] [tz]
  local loc="${1:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}"
  local tz="${2:-${TZ:-}}"
  if [[ -z "$tz" && -r /etc/timezone ]]; then
    tz="$(head -n 1 /etc/timezone 2>/dev/null || true)"
  fi
  if [[ -z "$tz" && -r /etc/localtime ]]; then
    tz=""
  fi
  if [[ -z "$tz" ]]; then
    tz="$(date +%Z 2>/dev/null || true)"
  fi
  local low_loc low_tz
  low_loc="$(printf '%s' "$loc" | tr '[:upper:]' '[:lower:]')"
  low_tz="$(printf '%s' "$tz" | tr '[:upper:]' '[:lower:]')"
  # Locale first: it is the user's explicit language/region choice.
  case "$low_loc" in
    zh_cn*|zh_sg*|zh_hans*|*hans*) printf 'mainland\n'; return 0 ;;
    zh_tw*|zh_hk*|zh_mo*|zh_hant*|*hant*) printf 'hmt\n'; return 0 ;;
  esac
  # Then the machine timezone (no network, no IP lookup).
  case "$low_tz" in
    asia/shanghai|asia/chongqing|asia/harbin|asia/urumqi|cst) printf 'mainland\n'; return 0 ;;
    asia/hong_kong|asia/macau|asia/taipei|hkt) printf 'hmt\n'; return 0 ;;
  esac
  printf 'overseas\n'
}

# Priority: CLI > environment > config > auto.
mirrors_resolve_region() { # <cli> <env> <config>
  local cli="${1:-}" env="${2:-}" cfg="${3:-}" candidate
  for candidate in "$cli" "$env" "$cfg"; do
    if [[ -n "$candidate" && "$candidate" != "auto" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf 'auto\n'
}

# --- URL builders ------------------------------------------------------------

mirrors_hf_base() {
  printf '%s\n' "${FIGARO_HF_BASE:-$FIGARO_MIRRORS_DEFAULT_HF}"
}

mirrors_hf_mirror_base() {
  local base="${FIGARO_HF_MIRROR_BASE:-$FIGARO_MIRRORS_DEFAULT_HF_MIRROR}"
  printf '%s\n' "${base%/}"
}

mirrors_modelscope_api() {
  local base="${FIGARO_MODELSCOPE_API:-$FIGARO_MIRRORS_DEFAULT_MODELSCOPE_API}"
  printf '%s\n' "${base%/}"
}

# One proxy base per line (FIGARO_GHPROXY_BASE pins a single one).
mirrors_ghproxy_bases() {
  if [[ -n "${FIGARO_GHPROXY_BASE:-}" ]]; then
    local base="${FIGARO_GHPROXY_BASE}"
    case "$base" in
      */) printf '%s\n' "$base" ;;
      *) printf '%s/\n' "$base" ;;
    esac
    return 0
  fi
  printf '%s\n' "${FIGARO_MIRRORS_DEFAULT_GHPROXY_BASES[@]}"
}

mirrors_hf_url() { # <repo> <path> [base]
  local repo="$1" path="$2" base="${3:-$(mirrors_hf_base)}"
  printf '%s/%s/resolve/main/%s\n' "${base%/}" "$repo" "$path"
}

mirrors_hf_mirror_url() { # <repo> <path>
  mirrors_hf_url "$1" "$2" "$(mirrors_hf_mirror_base)"
}

mirrors_modelscope_url() { # <owner/repo> <path>
  local api
  api="$(mirrors_modelscope_api)"
  printf '%s/%s/repo?Revision=master&FilePath=%s\n' "$api" "$1" "$2"
}

mirrors_ghproxy_url() { # <proxy-base-with-trailing-slash> <github-url>
  printf '%s%s\n' "$1" "$2"
}

# Range-GET the URL and print the final HTTP status (000 = unreachable / curl
# missing). Reads at most 256 bytes: usable for a HEAD-style probe of a model
# file without downloading it. Tests inject a stub `curl` through PATH.
mirrors_verify_url() { # <url> [timeout-seconds]
  local url="$1" timeout="${2:-10}"
  command -v curl >/dev/null 2>&1 || { printf '000\n'; return 0; }
  local code
  code="$(curl -sS -o /dev/null -L --connect-timeout 5 --max-time "$timeout" -r 0-255 \
    -w '%{http_code}' "$url" 2>/dev/null)" || code="000"
  [[ -z "$code" ]] && code="000"
  printf '%s\n' "$code"
}

mirrors_http_ok() { # <status-code>
  case "${1:-}" in
    2??|3??) return 0 ;;
    *) return 1 ;;
  esac
}
