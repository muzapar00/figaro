#!/usr/bin/env bash
# Fetch the local speech models used by Figaro's hearing (src/voice/asr/).
#
#   ./scripts/fetch-models.sh                        # download what is missing (region-aware mirror)
#   ./scripts/fetch-models.sh --region=mainland      # 中国大陆：modelscope > hf-mirror > ghproxy（官方兜底）
#   ./scripts/fetch-models.sh --region=hmt           # 中国港澳台：GitHub/HuggingFace 官方直连优先
#   ./scripts/fetch-models.sh --region=overseas      # 海外：GitHub/HuggingFace 官方直连优先
#   ./scripts/fetch-models.sh --probe                # 只打印地区/源/每个 artifact 将用的 URL 并做 HEAD 校验（不下载）
#   ./scripts/fetch-models.sh --check                # verify installed models, no network
#   ./scripts/fetch-models.sh --force                # re-download everything
#   ./scripts/fetch-models.sh --only=kws             # one artifact: kws | asr | sensevoice | vad | speaker
#   ./scripts/fetch-models.sh --models-dir=/path     # install to /path (default <repo>/models; env FIGARO_MODELS_DIR)
#
# 地区与源（优先级：--region > FIGARO_REGION > config.models.region > auto）：
#   mainland        modelscope > hf-mirror > ghproxy > github > hf（国内源优先，官方只兜底）
#   hmt / overseas  github > hf > modelscope > hf-mirror（官方直连优先，国内镜像兜底）
#   auto            不探测地理位置：按 locale（如 zh_CN→mainland，zh_TW/HK/MO→hmt）再按时区猜，
#                   输出里会说明猜的依据；可用 --region 覆盖。
# `FIGARO_MIRROR=modelscope|github|hf|hf-mirror|ghproxy|auto` 是旧版的显式源覆盖：
#   非 auto 时把该源排到链首，其余源仍按地区顺序兜底。
# 环境变量：FIGARO_MODELS_DIR（目标目录）、FIGARO_REGION、FIGARO_HF_MIRROR_BASE、
#           FIGARO_GHPROXY_BASE、FIGARO_MODELSCOPE_API。
#
# 实测（2026-11）：huggingface.co 与 hf-mirror.com 有 streaming/paraformer/sensevoice 全部文件；
# GitHub Releases 有 kws/vad/speaker 及 tar.bz2 包；ModelScope 只镜像了旧版中文 KWS，
# 本脚本所需模型未上架，--probe 会显示 modelscope「不适用」并自动跳到下一个源（不会静默降级）。
#
# Models land in ${FIGARO_MODELS_DIR:-<repo>/models} (git-ignored) exactly where config.asr points:
#   models/kws          sherpa-onnx KWS zipformer zh-en 3M        (唤醒词「费加罗」/「figaro」)
#   models/asr-stream   sherpa-onnx streaming zipformer zh 14M     (live partials)
#   models/asr-offline  sherpa-onnx paraformer zh                  (final transcript)
#   models/vad          silero_vad.onnx                            (speech/silence)
#   models/speaker      3dspeaker CAM++ speaker embedding             (voiceprint: 只认你的声音)
#
# Downloads are resumable (curl -C -) and idempotent; a partial file is reused by
# the next run. Tar archives are bzip2-tested before extraction. A failed mirror
# is logged and the next source is tried automatically.
#
# The KWS model is the bilingual (Chinese pinyin + English CMU phones) export
# sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20, so both「费加罗」and "figaro"
# can wake Figaro. It replaces the old Chinese-only wenetspeech 3.3M model
# (kept as an opt-in legacy download: FIGARO_FETCH_KWS_LEGACY=1).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=lib-mirrors.sh
source "${SCRIPT_DIR}/lib-mirrors.sh"

MODELS_DIR="${FIGARO_MODELS_DIR:-${REPO_ROOT}/models}"
REGION_ARG=""
REGION_ENV="${FIGARO_REGION:-}"
MIRROR="${FIGARO_MIRROR:-auto}"
FORCE=0
CHECK_ONLY=0
PROBE=0
ONLY=""

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 && !/^#/ { exit }' "$0"
}

log()  { printf '[fetch-models] %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }
warn() { printf '[fetch-models] WARN: %s\n' "$*" >&2; }
die()  { printf '[fetch-models] ERROR: %s\n' "$*" >&2; exit 1; }
size_of() { stat -c%s "$1" 2>/dev/null || echo 0; }
human() { numfmt --to=iec "$1" 2>/dev/null || echo "${1}B"; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"; }

# --- arguments ---------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  arg="$1"; shift
  case "$arg" in
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    --probe) PROBE=1 ;;
    --region=*) REGION_ARG="${arg#--region=}" ;;
    --region)
      [[ $# -gt 0 ]] || die "--region 需要一个值（mainland|hmt|overseas|auto）"
      REGION_ARG="$1"; shift ;;
    --mirror=*) MIRROR="${arg#--mirror=}" ;;
    --mirror)
      [[ $# -gt 0 ]] || die "--mirror 需要一个值（auto|modelscope|hf-mirror|ghproxy|github|hf）"
      MIRROR="$1"; shift ;;
    --models-dir=*) MODELS_DIR="${arg#--models-dir=}" ;;
    --models-dir)
      [[ $# -gt 0 ]] || die "--models-dir 需要一个目录"
      MODELS_DIR="$1"; shift ;;
    --only=*) ONLY="${arg#--only=}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if [[ "${CHECK_ONLY}" -eq 1 && "${PROBE}" -eq 1 ]]; then
  die "--check 与 --probe 不能同时使用"
fi

case "${ONLY}" in
  ""|all|kws|asr|sensevoice|vad|speaker) ;;
  *) die "--only 只支持 all|kws|asr|sensevoice|vad|speaker（收到: ${ONLY}）" ;;
esac

# Print an absolute path without requiring the directory to exist yet.
abs_dir() {
  local path="$1"
  case "$path" in
    /*) ;;
    *) path="${PWD}/${path}" ;;
  esac
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$path" 2>/dev/null || printf '%s\n' "$path"
  else
    printf '%s\n' "$path"
  fi
}
MODELS_DIR="$(abs_dir "${MODELS_DIR}")"
CACHE_DIR="${MODELS_DIR}/.cache"

# --- region + mirror chain ---------------------------------------------------
# config.models.region is read with node (the project runtime) so we do not
# depend on jq/python; only that single field is read, never a key.
config_models_region() {
  local cfg="${FIGARO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/figaro}/config.json"
  [[ -f "$cfg" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    try {
      const fs = require("node:fs");
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const region = config && config.models && config.models.region;
      if (typeof region === "string") process.stdout.write(region.trim());
    } catch {}
  ' "$cfg" 2>/dev/null || true
}

CONFIG_REGION="$(config_models_region)"

if [[ -n "${REGION_ARG}" && "${REGION_ARG}" != "auto" ]] && ! mirrors_valid_region "${REGION_ARG}"; then
  die "--region 只支持 mainland|hmt|overseas|auto（收到: ${REGION_ARG}）"
fi
if [[ -n "${REGION_ENV}" && "${REGION_ENV}" != "auto" ]] && ! mirrors_valid_region "${REGION_ENV}"; then
  warn "FIGARO_REGION=${REGION_ENV} 无效，忽略（只支持 mainland|hmt|overseas|auto）"
  REGION_ENV=""
fi
if [[ -n "${CONFIG_REGION}" && "${CONFIG_REGION}" != "auto" ]] && ! mirrors_valid_region "${CONFIG_REGION}"; then
  warn "config.models.region=${CONFIG_REGION} 无效，按 auto 处理"
  CONFIG_REGION=""
fi

REGION_RESOLVED="$(mirrors_resolve_region "${REGION_ARG}" "${REGION_ENV}" "${CONFIG_REGION}")"
if [[ "${REGION_RESOLVED}" == "auto" ]]; then
  REGION_EFFECTIVE="$(mirrors_guess_region)"
  REGION_NOTE="auto（依据 locale/时区猜，可用 --region 覆盖）"
else
  REGION_EFFECTIVE="${REGION_RESOLVED}"
  REGION_NOTE="显式（--region > FIGARO_REGION > config.models.region）"
fi

if [[ "${MIRROR}" != "auto" ]] && ! mirrors_valid_source "${MIRROR}"; then
  die "FIGARO_MIRROR/--mirror 只支持 auto|modelscope|hf-mirror|ghproxy|github|hf（收到: ${MIRROR}）"
fi
CHAIN="$(mirrors_chain "${REGION_EFFECTIVE}" "${MIRROR}")" || die "无法计算镜像源顺序"
CHAIN_PRETTY="$(printf '%s\n' "${CHAIN}" | awk 'BEGIN { ORS = "" } NR > 1 { printf " > " } { print }')"

log "模型目录: ${MODELS_DIR}"
log "地区: ${REGION_EFFECTIVE}（${REGION_NOTE}）"
log "源顺序: ${CHAIN_PRETTY}"
if [[ "${MIRROR}" != "auto" ]]; then
  log "源覆盖: ${MIRROR} 已排到链首（FIGARO_MIRROR/--mirror），其余源按地区顺序兜底"
fi

# --- completeness checks (accept any epoch export of the right model family) --
compgen_ok() { # compgen_ok <dir> <pattern> [min-size]
  local dir="$1" pat="$2" min="${3:-100000}" f
  for f in "$dir"/$pat; do
    [[ -e "$f" ]] || continue
    [[ "$(size_of "$f")" -ge "$min" ]] && return 0
  done
  return 1
}
file_ok() { [[ -f "$1" ]] && [[ "$(size_of "$1")" -ge "${2:-100000}" ]]; }

artifact_complete() {
  local name="$1" dir
  case "$name" in
    kws)
      dir="${MODELS_DIR}/kws"
      file_ok "${dir}/tokens.txt" 100 || return 1
      compgen_ok "${dir}" "encoder-*.onnx" 1000000 || return 1
      compgen_ok "${dir}" "decoder-*.onnx" 50000 || return 1
      compgen_ok "${dir}" "joiner-*.onnx" 20000 || return 1
      # English wake words need the CMU lexicon shipped with the zh-en model
      file_ok "${dir}/en.phone" 100000 || return 1
      return 0 ;;
    asr-stream)
      dir="${MODELS_DIR}/asr-stream"
      file_ok "${dir}/tokens.txt" 1000 || return 1
      compgen_ok "${dir}" "encoder-*.onnx" 5000000 || return 1
      compgen_ok "${dir}" "decoder-*.onnx" 500000 || return 1
      compgen_ok "${dir}" "joiner-*.onnx" 500000 || return 1
      return 0 ;;
    asr-offline)
      dir="${MODELS_DIR}/asr-offline"
      file_ok "${dir}/tokens.txt" 1000 || return 1
      compgen_ok "${dir}" "model*.onnx" 10000000 || return 1
      return 0 ;;
    asr-sensevoice)
      dir="${MODELS_DIR}/asr-offline-sensevoice"
      file_ok "${dir}/tokens.txt" 1000 || return 1
      compgen_ok "${dir}" "model*.onnx" 10000000 || return 1
      return 0 ;;
    vad)
      file_ok "${MODELS_DIR}/vad/silero_vad.onnx" 100000 || return 1
      return 0 ;;
    speaker)
      file_ok "${MODELS_DIR}/speaker/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx" 25000000 || return 1
      return 0 ;;
  esac
  return 1
}

artifact_report() {
  local name="$1" dir f total=0
  case "$name" in
    kws) dir="${MODELS_DIR}/kws" ;;
    asr-stream) dir="${MODELS_DIR}/asr-stream" ;;
    asr-offline) dir="${MODELS_DIR}/asr-offline" ;;
    asr-sensevoice) dir="${MODELS_DIR}/asr-offline-sensevoice" ;;
    vad) dir="${MODELS_DIR}/vad" ;;
    speaker) dir="${MODELS_DIR}/speaker" ;;
  esac
  if artifact_complete "$name"; then
    for f in "$dir"/*; do [[ -f "$f" && "$(basename "$f")" != .figaro-model ]] && total=$((total + $(size_of "$f"))); done
    local model=""
    [[ -f "$dir/.figaro-model" ]] && model="$(sed -n 's/^model=//p' "$dir/.figaro-model" | head -1)"
    info "  $(printf '%-12s' "$name") OK        ${dir#${REPO_ROOT}/}  ($(human "$total"))${model:+  [$model]}"
    return 0
  fi
  info "  $(printf '%-12s' "$name") MISSING   ${dir#${REPO_ROOT}/}"
  return 1
}

# Stamp format kept from 0.x for existing installs/diagnostics:
#   artifact=<source label>   (github / hf-mirror / modelscope / ghproxy...)
#   source=<model id>
write_stamp() {
  mkdir -p "${MODELS_DIR}/$1"
  printf 'artifact=%s\nsource=%s\nfetched_at=%s\n' "$2" "$3" "$(date -Is)" \
    > "${MODELS_DIR}/$1/.figaro-model"
}

# --- artifact metadata -------------------------------------------------------
KWS_MODEL_NAME="sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
KWS_LEGACY_REPO="sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
KWS_LEGACY_ENCODER="encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
KWS_LEGACY_DECODER="decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
KWS_LEGACY_JOINER="joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
KWS_ENCODER="encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
KWS_DECODER="decoder-epoch-13-avg-2-chunk-16-left-64.onnx"
KWS_JOINER="joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
KWS_FILES=("${KWS_ENCODER}" "${KWS_DECODER}" "${KWS_JOINER}" "tokens.txt" "en.phone")

artifact_dir() {
  case "$1" in
    kws) printf '%s\n' "${MODELS_DIR}/kws" ;;
    kws-legacy) printf '%s\n' "${MODELS_DIR}/kws-legacy-zh" ;;
    asr-stream) printf '%s\n' "${MODELS_DIR}/asr-stream" ;;
    asr-offline) printf '%s\n' "${MODELS_DIR}/asr-offline" ;;
    asr-sensevoice) printf '%s\n' "${MODELS_DIR}/asr-offline-sensevoice" ;;
    vad) printf '%s\n' "${MODELS_DIR}/vad" ;;
    speaker) printf '%s\n' "${MODELS_DIR}/speaker" ;;
  esac
}

artifact_cache_name() {
  case "$1" in
    kws) printf 'kws-zh-en.tar.bz2\n' ;;
    kws-legacy) printf 'kws-legacy.tar.bz2\n' ;;
    asr-stream) printf 'stream-zh-14m.tar.bz2\n' ;;
    asr-offline) printf 'paraformer-zh.tar.bz2\n' ;;
    asr-sensevoice) printf 'sensevoice.tar.bz2\n' ;;
  esac
}

artifact_single_file() {
  case "$1" in
    vad) printf 'silero_vad.onnx\n' ;;
    speaker) printf '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx\n' ;;
  esac
}

artifact_file_min() { # <artifact> <basename>
  local artifact="$1" file="$2"
  case "$file" in
    tokens.txt) case "$artifact" in asr-stream) printf '1000\n' ;; *) printf '100\n' ;; esac ;;
    en.phone|*.mvn) printf '100000\n' ;;
    *.onnx)
      case "$artifact" in
        asr-stream) case "$file" in encoder-*) printf '5000000\n' ;; *) printf '500000\n' ;; esac ;;
        asr-offline|asr-sensevoice) printf '10000000\n' ;;
        kws-legacy) case "$file" in encoder-*) printf '1000000\n' ;; *) printf '20000\n' ;; esac ;;
        kws) case "$file" in encoder-*) printf '1000000\n' ;; *) printf '20000\n' ;; esac ;;
        *) printf '100000\n' ;;
      esac ;;
    *) printf '100\n' ;;
  esac
}

# --- source emission ---------------------------------------------------------
# One line per source attempt: "<source>|<mode>|<payload>"
#   mode tar   -> payload is a tarball URL
#   mode file  -> payload is a single-file URL
#   mode files -> payload is "<hf-repo>;<file>;<file>..." (file-level mirror)
gh_release() { printf 'https://github.com/k2-fsa/sherpa-onnx/releases/download/%s\n' "$1"; }

emit_tar() { # <source> <github-url>
  local source="$1" url="$2" base
  case "$source" in
    github) printf 'github|tar|%s\n' "${url}" ;;
    ghproxy)
      while IFS= read -r base; do
        [[ -n "${base}" ]] && printf 'ghproxy|tar|%s\n' "${base}${url}"
      done < <(mirrors_ghproxy_bases) ;;
  esac
}

emit_file() { # <source> <github-url>
  local source="$1" url="$2" base
  case "$source" in
    github) printf 'github|file|%s\n' "${url}" ;;
    ghproxy)
      while IFS= read -r base; do
        [[ -n "${base}" ]] && printf 'ghproxy|file|%s\n' "${base}${url}"
      done < <(mirrors_ghproxy_bases) ;;
  esac
}

emit_files() { # <source> <hf-repo> <file...>
  local source="$1" repo="$2"; shift 2
  case "$source" in
    hf|hf-mirror|modelscope)
      local payload="$repo" file
      for file in "$@"; do payload="${payload};${file}"; done
      printf '%s|files|%s\n' "${source}" "${payload}" ;;
  esac
}

artifact_spec() { # <artifact> <source> -> source attempt lines
  local artifact="$1" source="$2"
  case "$artifact" in
    kws)
      emit_tar "${source}" "$(gh_release "kws-models/${KWS_MODEL_NAME}.tar.bz2")"
      ;;
    kws-legacy)
      emit_files "${source}" "pkufool/${KWS_LEGACY_REPO}" \
        tokens.txt "${KWS_LEGACY_ENCODER}" "${KWS_LEGACY_DECODER}" "${KWS_LEGACY_JOINER}"
      emit_tar "${source}" "$(gh_release "kws-models/${KWS_LEGACY_REPO}.tar.bz2")"
      ;;
    asr-stream)
      emit_tar "${source}" "$(gh_release 'asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2')"
      emit_files "${source}" "csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23" \
        tokens.txt encoder-epoch-99-avg-1.int8.onnx decoder-epoch-99-avg-1.int8.onnx joiner-epoch-99-avg-1.int8.onnx
      ;;
    asr-offline)
      emit_tar "${source}" "$(gh_release 'asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2')"
      emit_files "${source}" "csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14" model.int8.onnx tokens.txt
      ;;
    asr-sensevoice)
      emit_tar "${source}" "$(gh_release 'asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2')"
      emit_files "${source}" "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17" model.int8.onnx tokens.txt
      ;;
    vad)
      emit_file "${source}" "$(gh_release 'asr-models/silero_vad.onnx')"
      ;;
    speaker)
      emit_file "${source}" "$(gh_release "speaker-recongition-models/$(artifact_single_file speaker)")"
      ;;
  esac
}

artifact_source_entries() { # <artifact> -> attempts in effective chain order
  local artifact="$1" source
  while IFS= read -r source; do
    [[ -z "${source}" ]] && continue
    artifact_spec "${artifact}" "${source}"
  done <<< "${CHAIN}"
}

artifact_file_url() { # <source> <repo> <file>
  case "$1" in
    hf) mirrors_hf_url "$2" "$3" ;;
    hf-mirror) mirrors_hf_mirror_url "$2" "$3" ;;
    modelscope) mirrors_modelscope_url "$2" "$3" ;;
    *) return 1 ;;
  esac
}

# --- download helpers; all logs on stderr so stdout stays machine-readable ---
download() { # download <dest> <min-size> <url...>
  local out="$1" min="$2"; shift 2
  local url
  for url in "$@"; do
    [[ -z "${url}" ]] && continue
    log "GET ${url}"
    if curl -fL --retry 2 --retry-delay 1 --connect-timeout 15 -sS -C - -o "${out}" "${url}"; then
      if [[ "$(size_of "${out}")" -ge "${min}" ]]; then
        log "  ok $(human "$(size_of "${out}")")"
        return 0
      fi
      warn "下载文件过小（$(size_of "${out}") < ${min}）：${url}"
      rm -f "${out}"
    else
      local code=$?
      warn "下载失败（curl exit ${code}）：${url}"
    fi
  done
  return 1
}

TARBALL=""
fetch_tarball() { # fetch_tarball <cache-name> <url...>; sets TARBALL
  local cache_name="$1"; shift
  local cache="${CACHE_DIR}/${cache_name}"
  if [[ "${FORCE}" -eq 1 ]]; then rm -f "${cache}"; fi
  if [[ -s "${cache}" ]] && bzip2 -t "${cache}" 2>/dev/null; then
    log "使用缓存 ${cache_name} ($(human "$(size_of "${cache}")"))"
    TARBALL="${cache}"
    return 0
  fi
  [[ -s "${cache}" ]] && { warn "缓存 ${cache_name} 校验失败，重新下载"; rm -f "${cache}"; }
  download "${cache}" 1000000 "$@" || return 1
  bzip2 -t "${cache}" 2>/dev/null || { rm -f "${cache}"; warn "${cache_name} 不是有效的 bzip2 包"; return 1; }
  TARBALL="${cache}"
  return 0
}

SRC_DIR=""
extract_dir() { # extract_dir <tarball> <dest>; sets SRC_DIR to the single top dir
  local tarball="$1" dest="$2"
  rm -rf "${dest}"
  mkdir -p "${dest}"
  tar -xjf "${tarball}" -C "${dest}" >&2 || return 1
  local entries=()
  local e
  for e in "${dest}"/*; do entries+=("$e"); done
  if [[ ${#entries[@]} -eq 1 && -d "${entries[0]}" ]]; then SRC_DIR="${entries[0]}"; else SRC_DIR="${dest}"; fi
  return 0
}

# --- installing one source ---------------------------------------------------
# Move a previously installed Chinese-only export out of the way (kept as
# models/kws-legacy-zh for diagnostics; the bilingual model supersedes it).
ensure_kws_legacy_backup() {
  local dir="$1"
  [[ -f "${dir}/en.phone" ]] && return 0
  local any=0
  compgen -G "${dir}/*.onnx" >/dev/null && any=1
  [[ -f "${dir}/tokens.txt" ]] && any=1
  [[ ${any} -eq 0 ]] && return 0
  local legacy="${MODELS_DIR}/kws-legacy-zh"
  mkdir -p "${legacy}"
  mv -f "${dir}"/*.onnx "${dir}"/tokens.txt "${dir}"/keywords*.txt "${legacy}/" 2>/dev/null || true
  log "旧的中文-only KWS 模型已移到 ${legacy}（已被中英双语模型取代）"
}

install_kws_from_dir() { # <source>
  local source="$1" dir f
  dir="$(artifact_dir kws)"
  mkdir -p "${dir}"
  ensure_kws_legacy_backup "${dir}"
  for f in "${KWS_FILES[@]}"; do
    cp -f "${SRC_DIR}/${f}" "${dir}/" || return 1
  done
  if [[ -d "${SRC_DIR}/test_wavs" ]]; then
    rm -rf "${dir}/example-test-wavs"
    cp -r "${SRC_DIR}/test_wavs" "${dir}/example-test-wavs" 2>/dev/null || true
  fi
  artifact_complete kws || return 1
  write_stamp kws "${source}" "kws-zipformer-zh-en-3M-2025-12-20"
  printf 'kind=kws-zh-en\nmodel=%s\n' "${KWS_MODEL_NAME}" >> "${dir}/.figaro-model"
  log "kws(zh-en) 安装完成（来源: ${source}）"
  return 0
}

install_kws_legacy_from_dir() { # <source>
  local source="$1" dir
  dir="$(artifact_dir kws-legacy)"
  mkdir -p "${dir}"
  cp -f "${SRC_DIR}"/*.onnx "${SRC_DIR}/tokens.txt" "${dir}/" 2>/dev/null || true
  if file_ok "${dir}/tokens.txt" 100 && compgen_ok "${dir}" "encoder-*.onnx" 1000000; then
    write_stamp kws-legacy-zh "${source}" "${KWS_LEGACY_REPO}"
    log "旧中文 KWS 模型已安装到 ${dir}（仅供对比，默认不再使用；来源: ${source}）"
    return 0
  fi
  return 1
}

install_asr_stream_from_dir() { # <source>
  local source="$1" dir
  dir="$(artifact_dir asr-stream)"
  mkdir -p "${dir}"
  if [[ -f "${SRC_DIR}/encoder-epoch-99-avg-1.int8.onnx" ]]; then
    cp -f "${SRC_DIR}"/{encoder,decoder,joiner}-epoch-99-avg-1.int8.onnx "${SRC_DIR}/tokens.txt" "${dir}/" || return 1
  else
    cp -f "${SRC_DIR}"/*.int8.onnx "${SRC_DIR}/tokens.txt" "${dir}/" || return 1
  fi
  artifact_complete asr-stream || return 1
  write_stamp asr-stream "${source}" "streaming-zipformer-zh-14M-int8"
  log "asr-stream 安装完成（来源: ${source}）"
  return 0
}

install_asr_offline_from_dir() { # <source>
  local source="$1" dir
  dir="$(artifact_dir asr-offline)"
  mkdir -p "${dir}"
  cp -f "${SRC_DIR}/model.int8.onnx" "${SRC_DIR}/tokens.txt" "${dir}/" \
    || cp -f "${SRC_DIR}/model.onnx" "${SRC_DIR}/tokens.txt" "${dir}/" \
    || return 1
  artifact_complete asr-offline || return 1
  write_stamp asr-offline "${source}" "paraformer-zh-int8"
  printf 'kind=paraformer\n' >> "${dir}/.figaro-model"
  log "asr-offline 安装完成（paraformer zh int8；来源: ${source}）"
  return 0
}

# Optional: SenseVoice-small int8 (better punctuation/readability in some cases,
# measured slower and slightly less accurate on real accented human speech than
# paraformer-zh-2023-09-14 — see src/voice/asr/README.md "准确率").
install_asr_sensevoice_from_dir() { # <source>
  local source="$1" dir
  dir="$(artifact_dir asr-sensevoice)"
  mkdir -p "${dir}"
  cp -f "${SRC_DIR}/model.int8.onnx" "${SRC_DIR}/tokens.txt" "${dir}/" || return 1
  artifact_complete asr-sensevoice || return 1
  write_stamp asr-sensevoice "${source}" "sense-voice-zh-en-ja-ko-yue-2024-07-17-int8"
  printf 'kind=sense-voice\n' >> "${dir}/.figaro-model"
  log "asr-sensevoice 安装完成（来源: ${source}）"
  return 0
}

finalize_file_artifact() { # <artifact> <source>
  local artifact="$1" source="$2" dir
  dir="$(artifact_dir "${artifact}")"
  case "${artifact}" in
    kws-legacy)
      file_ok "${dir}/tokens.txt" 100 && compgen_ok "${dir}" "encoder-*.onnx" 1000000 || return 1
      write_stamp kws-legacy-zh "${source}" "${KWS_LEGACY_REPO}"
      log "旧中文 KWS 模型已安装到 ${dir}（仅供对比，默认不再使用；来源: ${source}）" ;;
    vad)
      artifact_complete vad || return 1
      write_stamp vad "${source}" "silero-vad-v5"
      log "vad 安装完成（来源: ${source}）" ;;
    speaker)
      artifact_complete speaker || return 1
      write_stamp speaker "${source}" "3dspeaker-campplus-sv-zh-cn-16k"
      log "speaker 安装完成（声纹；来源: ${source}）" ;;
    asr-stream)
      artifact_complete asr-stream || return 1
      write_stamp asr-stream "${source}" "streaming-zipformer-zh-14M-int8"
      log "asr-stream 安装完成（来源: ${source}）" ;;
    asr-offline)
      artifact_complete asr-offline || return 1
      write_stamp asr-offline "${source}" "paraformer-zh-int8"
      printf 'kind=paraformer\n' >> "${dir}/.figaro-model"
      log "asr-offline 安装完成（paraformer zh int8；来源: ${source}）" ;;
    asr-sensevoice)
      artifact_complete asr-sensevoice || return 1
      write_stamp asr-sensevoice "${source}" "sense-voice-zh-en-ja-ko-yue-2024-07-17-int8"
      printf 'kind=sense-voice\n' >> "${dir}/.figaro-model"
      log "asr-sensevoice 安装完成（来源: ${source}）" ;;
    *) return 1 ;;
  esac
  return 0
}

try_tar_source() { # <artifact> <source> <tarball-url>
  local artifact="$1" source="$2" url="$3" cache_name cache
  cache_name="$(artifact_cache_name "${artifact}")"
  cache="${CACHE_DIR}/${cache_name}"
  mkdir -p "$(artifact_dir "${artifact}")"
  log "${artifact}: 源 ${source}（tar）"
  # Keep the 0.x gh-CLI fast path for the KWS release (historically the most
  # reliable route for that asset); it is still "the official GitHub source".
  if [[ "${artifact}" == "kws" && "${source}" == "github" && "${FORCE}" -eq 0 ]] && command -v gh >/dev/null 2>&1; then
    if gh release download -R k2-fsa/sherpa-onnx -p "${KWS_MODEL_NAME}.tar.bz2" -D "${CACHE_DIR}" --clobber 2>/dev/null \
        && [[ -s "${cache}" ]] && bzip2 -t "${cache}" 2>/dev/null; then
      TARBALL="${cache}"
      extract_dir "${TARBALL}" "${CACHE_DIR}/${artifact}-extract" || return 1
      install_kws_from_dir "${source}" && return 0
    fi
    log "gh release download 未成功，回退 curl"
  fi
  fetch_tarball "${cache_name}" "${url}" || return 1
  extract_dir "${TARBALL}" "${CACHE_DIR}/${artifact}-extract" || { warn "解压失败: ${artifact}"; return 1; }
  case "${artifact}" in
    kws) install_kws_from_dir "${source}" ;;
    kws-legacy) install_kws_legacy_from_dir "${source}" ;;
    asr-stream) install_asr_stream_from_dir "${source}" ;;
    asr-offline) install_asr_offline_from_dir "${source}" ;;
    asr-sensevoice) install_asr_sensevoice_from_dir "${source}" ;;
    *) return 1 ;;
  esac
}

try_file_source() { # <artifact> <source> <url>
  local artifact="$1" source="$2" url="$3" dir name min
  dir="$(artifact_dir "${artifact}")"
  name="$(artifact_single_file "${artifact}")"
  min="$(artifact_file_min "${artifact}" "${name}")"
  mkdir -p "${dir}"
  if [[ -s "${dir}/${name}" ]] && [[ "$(size_of "${dir}/${name}")" -ge "${min}" ]] && [[ "${FORCE}" -eq 0 ]]; then
    finalize_file_artifact "${artifact}" "${source}"
    return $?
  fi
  log "${artifact}: 源 ${source}（单文件）"
  download "${dir}/${name}.part" "${min}" "${url}" || return 1
  mv -f "${dir}/${name}.part" "${dir}/${name}"
  finalize_file_artifact "${artifact}" "${source}"
}

try_files_source() { # <artifact> <source> "<hf-repo>;<file>;..."
  local artifact="$1" source="$2" payload="$3"
  local -a bits=()
  IFS=';' read -r -a bits <<< "${payload}"
  local repo="${bits[0]:-}"
  [[ -z "${repo}" ]] && return 1
  local dir url min file
  dir="$(artifact_dir "${artifact}")"
  mkdir -p "${dir}"
  log "${artifact}: 源 ${source}（分文件）"
  local i
  for i in "${!bits[@]}"; do
    [[ "${i}" -eq 0 ]] && continue
    file="${bits[${i}]}"
    [[ -z "${file}" ]] && continue
    url="$(artifact_file_url "${source}" "${repo}" "${file}")" || return 1
    min="$(artifact_file_min "${artifact}" "${file}")"
    if [[ -s "${dir}/${file}" ]] && [[ "$(size_of "${dir}/${file}")" -ge "${min}" ]] && [[ "${FORCE}" -eq 0 ]]; then
      continue
    fi
    download "${dir}/${file}.part" "${min}" "${url}" || { warn "下载失败: ${file}（${source}）"; return 1; }
    mv -f "${dir}/${file}.part" "${dir}/${file}"
  done
  finalize_file_artifact "${artifact}" "${source}"
}

install_from_chain() { # <artifact>
  local artifact="$1" source mode payload
  while IFS='|' read -r source mode payload; do
    [[ -z "${source}" ]] && continue
    case "${mode}" in
      tar) try_tar_source "${artifact}" "${source}" "${payload}" && return 0 ;;
      file) try_file_source "${artifact}" "${source}" "${payload}" && return 0 ;;
      files) try_files_source "${artifact}" "${source}" "${payload}" && return 0 ;;
    esac
    warn "${artifact}: 源 ${source} 失败，自动 fallback 到下一个源"
  done < <(artifact_source_entries "${artifact}")
  return 1
}

# --- artifacts ---------------------------------------------------------------
fetch_kws_legacy() {
  local dir
  dir="$(artifact_dir kws-legacy)"
  if file_ok "${dir}/tokens.txt" 100 && compgen_ok "${dir}" "encoder-*.onnx" 1000000 && [[ "${FORCE}" -eq 0 ]]; then
    log "kws-legacy-zh 已就绪，跳过"; return 0
  fi
  install_from_chain kws-legacy || die "无法下载旧 KWS 模型（所有源均失败）"
}

fetch_kws() {
  local dir
  dir="$(artifact_dir kws)"
  if [[ "${FORCE}" -eq 0 ]] && artifact_complete kws && file_ok "${dir}/en.phone" 100000; then
    log "kws(zh-en) 已就绪，跳过"; return 0
  fi
  if [[ "${FIGARO_FETCH_KWS_LEGACY:-0}" == "1" ]]; then
    fetch_kws_legacy || warn "旧 KWS 可选项下载失败，继续下载当前模型"
  fi
  install_from_chain kws \
    || die "kws(zh-en) 下载失败（所有源均失败；可设 --region/--mirror 或手动从 GitHub Releases kws-models 取 ${KWS_MODEL_NAME}.tar.bz2）"
}

fetch_asr_stream() {
  if artifact_complete asr-stream && [[ "${FORCE}" -eq 0 ]]; then log "asr-stream 已就绪，跳过"; return 0; fi
  install_from_chain asr-stream || die "无法下载 streaming ASR 模型（所有源均失败）"
}

fetch_asr_offline() {
  if artifact_complete asr-offline && [[ "${FORCE}" -eq 0 ]]; then log "asr-offline 已就绪，跳过"; return 0; fi
  install_from_chain asr-offline || die "无法下载离线 ASR 模型（所有源均失败）"
}

fetch_asr_sensevoice() {
  if artifact_complete asr-sensevoice && [[ "${FORCE}" -eq 0 ]]; then log "asr-sensevoice 已就绪，跳过"; return 0; fi
  install_from_chain asr-sensevoice || die "无法下载 SenseVoice 模型（所有源均失败）"
}

fetch_vad() {
  if artifact_complete vad && [[ "${FORCE}" -eq 0 ]]; then log "vad 已就绪，跳过"; return 0; fi
  install_from_chain vad || die "无法下载 silero_vad.onnx（所有源均失败）"
}

fetch_speaker() {
  if artifact_complete speaker && [[ "${FORCE}" -eq 0 ]]; then log "speaker 已就绪，跳过"; return 0; fi
  install_from_chain speaker || die "无法下载声纹模型（所有源均失败）"
}

# --- probe -------------------------------------------------------------------
probe_artifacts() {
  case "${ONLY}" in
    ""|all) printf '%s\n' kws asr-stream asr-offline asr-sensevoice vad speaker ;;
    kws) printf 'kws\n' ;;
    asr) printf '%s\n' asr-stream asr-offline ;;
    sensevoice) printf 'asr-sensevoice\n' ;;
    vad) printf 'vad\n' ;;
    speaker) printf 'speaker\n' ;;
    *) die "--only 只支持 kws|asr|sensevoice|vad|speaker" ;;
  esac
}

artifact_probe_url() { # <artifact> <mode> <source> <payload>
  local artifact="$1" mode="$2" source="$3" payload="$4"
  case "${mode}" in
    tar|file) printf '%s\n' "${payload}" ;;
    files)
      local -a bits=()
      IFS=';' read -r -a bits <<< "${payload}"
      local repo="${bits[0]:-}" first="${bits[1]:-}"
      [[ -z "${repo}" || -z "${first}" ]] && return 1
      artifact_file_url "${source}" "${repo}" "${first}" ;;
  esac
}

probe_plan() {
  local rc=0 artifact source mode payload url code status
  local -a artifacts=()
  while IFS= read -r artifact; do artifacts+=("${artifact}"); done < <(probe_artifacts)
  log "probe 模型目录: ${MODELS_DIR}（只校验，不写入）"
  info ""
  info "$(printf '  %-14s %-12s %-10s %s' 'artifact' 'source' 'HTTP' '将使用的 URL（小文件/头部校验）')"
  local chosen_source chosen_url spec
  for artifact in "${artifacts[@]}"; do
    chosen_source=""
    chosen_url=""
    while IFS= read -r source; do
      [[ -z "${source}" ]] && continue
      spec="$(artifact_spec "${artifact}" "${source}")"
      if [[ -z "${spec}" ]]; then
        info "$(printf '  %-14s %-12s %-10s %s' "${artifact}" "${source}" '不适用' '该模型未上架此源，自动跳过')"
        continue
      fi
      while IFS='|' read -r source mode payload; do
        [[ -z "${source}" ]] && continue
        url="$(artifact_probe_url "${artifact}" "${mode}" "${source}" "${payload}")" || continue
        code="$(mirrors_verify_url "${url}")"
        if mirrors_http_ok "${code}"; then
          status='OK'
        else
          status='FAIL'
        fi
        info "$(printf '  %-14s %-12s %-10s %s' "${artifact}" "${source}" "${code}/${status}" "${url}")"
        if [[ -z "${chosen_url}" && "${status}" == 'OK' ]]; then
          chosen_source="${source}"
          chosen_url="${url}"
        fi
      done <<< "${spec}"
    done <<< "${CHAIN}"
    if [[ -n "${chosen_url}" ]]; then
      log "[probe] ${artifact} → 将使用 ${chosen_source}：${chosen_url}"
    else
      warn "[probe] ${artifact} → 没有可用源（下载会失败；检查网络、--region 或 --mirror）"
      rc=1
    fi
  done
  info ""
  log "probe 模型目录（最终）: ${MODELS_DIR}（未写入）"
  log "probe 结束：不下载任何模型；加 --region/--mirror/--only 可改变选择"
  return "${rc}"
}

# --- main --------------------------------------------------------------------
if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  rc=0
  artifact_report kws || rc=1
  artifact_report asr-stream || rc=1
  artifact_report asr-offline || rc=1
  artifact_report vad || rc=1
  if [[ "${rc}" -eq 0 ]]; then log "全部模型就绪"; else log "缺少模型，请运行 ./scripts/fetch-models.sh"; fi
  log "模型目录（最终）: ${MODELS_DIR}"
  exit "${rc}"
fi

if [[ "${PROBE}" -eq 1 ]]; then
  need curl
  probe_plan
  exit $?
fi

need curl
need tar
need bzip2
mkdir -p "${MODELS_DIR}" "${CACHE_DIR}"

case "${ONLY}" in
  kws) fetch_kws ;;
  asr) fetch_asr_stream; fetch_asr_offline ;;
  sensevoice) fetch_asr_sensevoice ;;
  vad) fetch_vad ;;
  speaker) fetch_speaker ;;
  ""|all) fetch_kws; fetch_asr_stream; fetch_asr_offline; fetch_vad; fetch_speaker ;;
  *) die "--only 只支持 kws|asr|sensevoice|vad|speaker" ;;
esac

artifact_report kws || true
artifact_report asr-stream || true
artifact_report asr-offline || true
artifact_report vad || true
log "模型目录（最终）: ${MODELS_DIR}"
log "完成。下一步：node scripts/asr-selftest.mjs"
