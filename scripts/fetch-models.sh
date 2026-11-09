#!/usr/bin/env bash
# Fetch the local speech models used by Figaro's hearing (src/voice/asr/).
#
#   ./scripts/fetch-models.sh              # download what is missing (auto mirror)
#   ./scripts/fetch-models.sh --check      # verify installed models, no network
#   ./scripts/fetch-models.sh --force      # re-download everything
#   ./scripts/fetch-models.sh --only=kws   # one artifact: kws | asr | sensevoice | vad
#   FIGARO_MIRROR=modelscope|github|hf|auto ./scripts/fetch-models.sh
#
# Models land in <repo>/models (git-ignored) exactly where config.asr points:
#   models/kws          sherpa-onnx KWS zipformer wenetspeech 3.3M  (wake word「费加罗」)
#   models/asr-stream   sherpa-onnx streaming zipformer zh 14M     (live partials)
#   models/asr-offline  sherpa-onnx paraformer zh                  (final transcript)
#   models/vad          silero_vad.onnx                            (speech/silence)
#
# Mirrors: ModelScope is tried first by default (domestic), then GitHub releases,
# then HuggingFace. Downloads are resumable (curl -C -) and idempotent; a partial
# file is reused by the next run. Tar archives are bzip2-tested before extraction.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODELS_DIR="${FIGARO_MODELS_DIR:-${REPO_ROOT}/models}"
CACHE_DIR="${MODELS_DIR}/.cache"
MIRROR="${FIGARO_MIRROR:-auto}"
FORCE=0
CHECK_ONLY=0
ONLY=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1" >&2; exit 1; }; }
need curl
need tar
need bzip2

log()  { printf '[fetch-models] %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }
warn() { printf '[fetch-models] WARN: %s\n' "$*" >&2; }
die()  { printf '[fetch-models] ERROR: %s\n' "$*" >&2; exit 1; }
size_of() { stat -c%s "$1" 2>/dev/null || echo 0; }
human() { numfmt --to=iec "$1" 2>/dev/null || echo "${1}B"; }

mkdir -p "${MODELS_DIR}" "${CACHE_DIR}"

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
  esac
  if artifact_complete "$name"; then
    for f in "$dir"/*; do [[ -f "$f" && "$(basename "$f")" != .figaro-model ]] && total=$((total + $(size_of "$f"))); done
    info "  $(printf '%-12s' "$name") OK        ${dir#${REPO_ROOT}/}  ($(human "$total"))"
    return 0
  fi
  info "  $(printf '%-12s' "$name") MISSING   ${dir#${REPO_ROOT}/}"
  return 1
}

write_stamp() {
  mkdir -p "${MODELS_DIR}/$1"
  printf 'artifact=%s\nsource=%s\nfetched_at=%s\n' "$2" "$3" "$(date -Is)" \
    > "${MODELS_DIR}/$1/.figaro-model"
}

# --- download helpers; all logs on stderr so stdout stays machine-readable ---
download() { # download <dest> <min-size> <url...>
  local out="$1" min="$2"; shift 2
  local url
  for url in "$@"; do
    [[ -z "$url" ]] && continue
    log "GET ${url}"
    if curl -fL --retry 2 --retry-delay 1 --connect-timeout 15 -sS -C - -o "${out}" "${url}"; then
      if [[ "$(size_of "${out}")" -ge "${min}" ]]; then
        log "  ok $(human "$(size_of "${out}")")"
        return 0
      fi
      warn "下载文件过小（$(size_of "${out}") < ${min}）：${url}"
      rm -f "${out}"
    else
      warn "镜像失败（curl exit $?）：${url}"
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

# --- URL helpers -------------------------------------------------------------
ms_file() { printf 'https://modelscope.cn/api/v1/models/pkufool/%s/repo?Revision=master&FilePath=%s' "$1" "$2"; }
gh_release() { printf 'https://github.com/k2-fsa/sherpa-onnx/releases/download/%s' "$1"; }
hf_file() { printf 'https://huggingface.co/%s/resolve/main/%s' "$1" "$2"; }

KWS_REPO="sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"

# --- artifact fetchers -------------------------------------------------------
fetch_kws() {
  local dir="${MODELS_DIR}/kws"
  mkdir -p "${dir}"
  if artifact_complete kws && [[ ${FORCE} -eq 0 ]]; then log "kws 已就绪，跳过"; return 0; fi
  local ms_urls=() gh_urls=() hf_urls=()
  local f
  for f in tokens.txt encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
           decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
           joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx keywords.txt; do
    ms_urls+=("$(ms_file "${KWS_REPO}" "$f")")
    hf_urls+=("$(hf_file "csukuangfj/${KWS_REPO}" "$f")")
  done
  gh_urls+=("$(gh_release "kws-models/${KWS_REPO}.tar.bz2")")

  # 1) ModelScope (file-level: only the epoch-12 int8 export is mirrored there)
  if [[ "${MIRROR}" == "auto" || "${MIRROR}" == "modelscope" ]]; then
    local ok=1
    for f in tokens.txt encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
             decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
             joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx; do
      download "${dir}/${f}.part" 20000 "$(ms_file "${KWS_REPO}" "$f")" || { ok=0; break; }
      mv -f "${dir}/${f}.part" "${dir}/${f}" || { ok=0; break; }
    done
    if [[ ${ok} -eq 1 ]]; then
      download "${dir}/keywords.txt" 50 "$(ms_file "${KWS_REPO}" "keywords.txt")" || true
      cp -f "${dir}/keywords.txt" "${dir}/keywords.example.txt" 2>/dev/null || true
      write_stamp kws modelscope "epoch-12-avg-2-int8"
      log "kws 安装完成（ModelScope, epoch-12 int8）"
      return 0
    fi
    warn "ModelScope 下载 kws 失败，回退 GitHub"
  fi

  # 2) GitHub release tar (contains both epoch-12 and the newer epoch-99 export)
  if [[ "${MIRROR}" == "auto" || "${MIRROR}" == "github" ]]; then
    if fetch_tarball "kws.tar.bz2" "${gh_urls[@]}" && extract_dir "${TARBALL}" "${CACHE_DIR}/kws-extract"; then
      cp -f "${SRC_DIR}"/encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx \
            "${SRC_DIR}"/decoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx \
            "${SRC_DIR}"/joiner-epoch-99-avg-1-chunk-16-left-64.int8.onnx \
            "${SRC_DIR}"/tokens.txt "${dir}/" || true
      cp -f "${SRC_DIR}"/keywords.txt "${dir}/keywords.example.txt" 2>/dev/null || true
      if artifact_complete kws; then
        write_stamp kws github "epoch-99-avg-1-int8"
        log "kws 安装完成（GitHub tar, epoch-99 int8）"
        return 0
      fi
    fi
    warn "GitHub 下载 kws 失败，回退 HuggingFace"
  fi

  # 3) HuggingFace file-level fallback
  if [[ "${MIRROR}" == "hf" || "${MIRROR}" == "auto" ]]; then
    for f in tokens.txt encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
             decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
             joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx; do
      download "${dir}/${f}.part" 20000 "$(hf_file "csukuangfj/${KWS_REPO}" "$f")" \
        || die "kws 下载失败: ${f}（所有镜像均失败）"
      mv -f "${dir}/${f}.part" "${dir}/${f}"
    done
    write_stamp kws hf "epoch-12-avg-2-int8"
    log "kws 安装完成（HuggingFace, epoch-12 int8）"
    return 0
  fi

  die "kws 下载失败（所有镜像均失败）"
}

fetch_asr_stream() {
  local dir="${MODELS_DIR}/asr-stream"
  mkdir -p "${dir}"
  if artifact_complete asr-stream && [[ ${FORCE} -eq 0 ]]; then log "asr-stream 已就绪，跳过"; return 0; fi
  local urls=(
    "$(gh_release 'asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2')"
  )
  fetch_tarball "stream-zh-14m.tar.bz2" "${urls[@]}" || die "无法下载 streaming ASR 模型"
  extract_dir "${TARBALL}" "${CACHE_DIR}/stream-extract" || die "解压 streaming ASR 模型失败"
  if [[ -f "${SRC_DIR}/encoder-epoch-99-avg-1.int8.onnx" ]]; then
    cp -f "${SRC_DIR}"/{encoder,decoder,joiner}-epoch-99-avg-1.int8.onnx "${SRC_DIR}/tokens.txt" "${dir}/"
  else
    cp -f "${SRC_DIR}"/*.int8.onnx "${SRC_DIR}/tokens.txt" "${dir}/"
  fi
  artifact_complete asr-stream || die "asr-stream 模型文件不完整"
  write_stamp asr-stream github "streaming-zipformer-zh-14M-int8"
  log "asr-stream 安装完成"
}

fetch_asr_offline() {
  local dir="${MODELS_DIR}/asr-offline"
  mkdir -p "${dir}"
  if artifact_complete asr-offline && [[ ${FORCE} -eq 0 ]]; then log "asr-offline 已就绪，跳过"; return 0; fi
  local urls=(
    "$(gh_release 'asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2')"
  )
  fetch_tarball "paraformer-zh.tar.bz2" "${urls[@]}" || die "无法下载离线 ASR 模型"
  extract_dir "${TARBALL}" "${CACHE_DIR}/offline-extract" || die "解压离线 ASR 模型失败"
  cp -f "${SRC_DIR}/model.int8.onnx" "${SRC_DIR}/tokens.txt" "${dir}/" \
    || cp -f "${SRC_DIR}/model.onnx" "${SRC_DIR}/tokens.txt" "${dir}/" \
    || die "离线 ASR 模型缺少 model.int8.onnx / tokens.txt"
  artifact_complete asr-offline || die "asr-offline 模型文件不完整"
  write_stamp asr-offline github "paraformer-zh-int8"
  printf 'kind=paraformer\n' >> "${dir}/.figaro-model"
  log "asr-offline 安装完成（paraformer zh int8）"
}

# Optional: SenseVoice-small int8 (better punctuation/readability in some cases,
# measured slower and slightly less accurate on real accented human speech than
# paraformer-zh-2023-09-14 — see src/voice/asr/README.md "准确率").
fetch_asr_sensevoice() {
  local dir="${MODELS_DIR}/asr-offline-sensevoice"
  mkdir -p "${dir}"
  if artifact_complete asr-sensevoice && [[ ${FORCE} -eq 0 ]]; then log "asr-sensevoice 已就绪，跳过"; return 0; fi
  local urls=(
    "$(gh_release 'asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2')"
  )
  fetch_tarball "sensevoice.tar.bz2" "${urls[@]}" || die "无法下载 SenseVoice 模型"
  extract_dir "${TARBALL}" "${CACHE_DIR}/sensevoice-extract" || die "解压 SenseVoice 失败"
  cp -f "${SRC_DIR}/model.int8.onnx" "${SRC_DIR}/tokens.txt" "${dir}/" \
    || die "SenseVoice 模型缺少 model.int8.onnx / tokens.txt"
  artifact_complete asr-sensevoice || die "asr-sensevoice 不完整"
  write_stamp asr-sensevoice github "sense-voice-zh-en-ja-ko-yue-2024-07-17-int8"
  printf 'kind=sense-voice\n' >> "${dir}/.figaro-model"
  log "asr-sensevoice 安装完成"
}

fetch_vad() {
  local dir="${MODELS_DIR}/vad"
  mkdir -p "${dir}"
  if artifact_complete vad && [[ ${FORCE} -eq 0 ]]; then log "vad 已就绪，跳过"; return 0; fi
  download "${dir}/silero_vad.onnx.part" 100000 \
    "$(gh_release 'asr-models/silero_vad.onnx')" \
    "$(hf_file 'csukuangfj/silero_vad' 'silero_vad.onnx')" \
    || die "无法下载 silero_vad.onnx"
  mv -f "${dir}/silero_vad.onnx.part" "${dir}/silero_vad.onnx"
  artifact_complete vad || die "silero_vad.onnx 不完整"
  write_stamp vad github "silero-vad-v5"
  log "vad 安装完成"
}

# --- main --------------------------------------------------------------------
if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  log "模型目录: ${MODELS_DIR}（mirror=${MIRROR}）"
  rc=0
  artifact_report kws || rc=1
  artifact_report asr-stream || rc=1
  artifact_report asr-offline || rc=1
  artifact_report vad || rc=1
  if [[ "${rc}" -eq 0 ]]; then log "全部模型就绪"; else log "缺少模型，请运行 ./scripts/fetch-models.sh"; fi
  exit "${rc}"
fi

log "模型目录: ${MODELS_DIR}（mirror=${MIRROR}）"
case "${ONLY}" in
  kws) fetch_kws ;;
  asr) fetch_asr_stream; fetch_asr_offline ;;
  sensevoice) fetch_asr_sensevoice ;;
  vad) fetch_vad ;;
  "") fetch_kws; fetch_asr_stream; fetch_asr_offline; fetch_vad ;;
  *) die "--only 只支持 kws|asr|sensevoice|vad" ;;
esac

artifact_report kws || true
artifact_report asr-stream || true
artifact_report asr-offline || true
artifact_report vad || true
log "完成。下一步：node scripts/asr-selftest.mjs"
