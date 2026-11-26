#!/bin/sh
set +x
set -eu

usage() {
  printf '%s\n' 'usage: hostfs roots | ls PATH | stat PATH | read PATH [OFFSET [LENGTH]] | write [-f] PATH [FILE|-] | mkdir [-p] PATH | cp [-f] SOURCE DEST | mv [-f] SOURCE DEST | rm [-r] PATH' >&2
  exit 2
}
[ "$#" -gt 0 ] || usage
[ -n "${DSH_HOSTFS_URL:-}" ] && [ -n "${DSH_HOSTFS_TOKEN:-}" ] || {
  printf '%s\n' 'HOSTFS_SESSION_CLOSED: hostfs is available only during a Linux tool command with the iOS host service running.' >&2
  exit 1
}
b64() { printf '%s' "$1" | /bin/busybox base64 | /bin/busybox tr -d '\n'; }
number() { case "$1" in ''|*[!0-9]*) usage ;; esac; }
command=$1
shift
overwrite=false
recursive=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -f) case "$command" in cp|mv|write) overwrite=true ;; *) usage ;; esac ;;
    -p) [ "$command" = mkdir ] || usage; recursive=true ;;
    -r|-R) case "$command" in rm|cp) recursive=true ;; *) usage ;; esac ;;
    --) shift; break ;;
    -*) usage ;;
    *) break ;;
  esac
  shift
done
request_file=$(/bin/busybox mktemp /tmp/.hostfs-request.XXXXXX)
trap '/bin/busybox rm -f "$request_file"' 0
trap 'exit 130' 1 2 15
case "$command" in
  roots)
    [ "$#" -eq 0 ] || usage
    printf '%s' '{"operation":"roots"}' > "$request_file"
    ;;
  cp|mv)
    [ "$#" -eq 2 ] || usage
    operation=copy
    [ "$command" != mv ] || operation=move
    printf '{"operation":"%s","sourceBase64":"%s","destinationBase64":"%s","overwrite":%s}' \
      "$operation" "$(b64 "$1")" "$(b64 "$2")" "$overwrite" > "$request_file"
    ;;
  ls|stat|mkdir|rm)
    [ "$#" -eq 1 ] || usage
    case "$command" in ls) operation=list ;; rm) operation=remove ;; *) operation=$command ;; esac
    printf '{"operation":"%s","pathBase64":"%s","recursive":%s}' \
      "$operation" "$(b64 "$1")" "$recursive" > "$request_file"
    ;;
  read)
    [ "$#" -ge 1 ] && [ "$#" -le 3 ] || usage
    offset=${2:-0}
    length=${3:-65536}
    number "$offset"; number "$length"
    printf '{"operation":"read","pathBase64":"%s","offset":%s,"length":%s}' \
      "$(b64 "$1")" "$offset" "$length" > "$request_file"
    ;;
  write)
    [ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
    printf '{"operation":"write","pathBase64":"%s","overwrite":%s,"encoding":"base64","data":"' \
      "$(b64 "$1")" "$overwrite" > "$request_file"
    if [ "${2:--}" = - ]; then
      encoded=$(/bin/busybox base64) || exit 1
    else
      encoded=$(/bin/busybox base64 "$2") || exit 1
    fi
    printf '%s' "$encoded" | /bin/busybox tr -d '\n' >> "$request_file"
    printf '"}' >> "$request_file"
    ;;
  *) usage ;;
esac
if ! answer=$(/bin/busybox wget -q -O - --header='Content-Type: application/json' \
    --header="Authorization: Bearer $DSH_HOSTFS_TOKEN" --post-file="$request_file" "$DSH_HOSTFS_URL"); then
  printf '%s\n' 'HOSTFS_TRANSPORT_FAILED: the command channel ended or the host service did not answer; inspect the file state before retrying a mutation.' >&2
  exit 1
fi
printf '%s\n' "$answer"
case "$answer" in
  '{"ok":true,'*) exit 0 ;;
  *) exit 1 ;;
esac
