#!/bin/sh
# Run one of the release's end-to-end scripts on the hosted instance, as the service user with the service's own
# environment and native tools, in a throw-away state directory (never the live workbench state).
#
#   PAI_SEND_E2E=pillow-e2e python3 tools/aws_operator.py send --script tools/hosted_e2e.sh
#
# The script imports the compiled release (dist/src) and runs with Node's type stripping; ALB authentication and the
# public origin are disabled because it talks to an in-process app, never to the network. Prints the report line.
set -e
E2E="${E2E:-pillow-e2e}"
case "$E2E" in *[!a-z0-9-]*) echo "bad E2E name" >&2; exit 2;; esac
REL=$(readlink -f /opt/pai/current)
NODE=$(systemctl show pai-workbench -p ExecStart | grep -oE 'path=[^ ;]+' | head -1 | cut -d= -f2)
W=$(mktemp -d /tmp/pai-e2e.XXXXXX); chown pai "$W"
# The script and the sibling scripts it imports (./x.js -> ./x.ts, run with Node's type stripping).
rewrite() { sed -e "s#\.\./src/\([a-z/-]*\)\.js#$REL/dist/src/\1.js#g" -e "s#from \"\./\([a-z-]*\)\.js\"#from \"./\1.ts\"#g" \
    -e 's#createApp({ ...config, state })#createApp({ ...config, state, albAuth: undefined, publicOrigin: undefined })#' "$REL/scripts/$1.ts" > "$W/$1.ts"; chown pai "$W/$1.ts"; }
rewrite "$E2E"
for dep in $(grep -oE 'from "\./[a-z-]+\.js"' "$REL/scripts/$E2E.ts" | sed -E 's#from "\./([a-z-]+)\.js"#\1#' | sort -u); do rewrite "$dep"; done
cd "$W"
set -a; . /etc/pai/runtime.env; set +a
for kv in $(systemctl show pai-workbench -p Environment --value); do export "$kv"; done
export PAI_STATE="$W/state"
status=0
/usr/sbin/runuser -u pai -p -- timeout 3000 "$NODE" --env-file-if-exists="$REL/.state/demo.env" "$W/$E2E.ts" > "$W/out.log" 2>&1 || status=$?
# The script's evidence report (one compact line), or the tail of its output when it failed.
if [ "$status" -eq 0 ] && ls "$W"/state/evidence/*.json >/dev/null 2>&1; then
  for f in "$W"/state/evidence/*.json; do /usr/bin/python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), ensure_ascii=False))' "$f"; done
else
  /usr/bin/grep -v -e Warning -e trace-warnings -e "^\s*at " "$W/out.log" | /usr/bin/tail -20
fi
# Keep a failed run's state (private, service-owned) for diagnosis; a passed run leaves nothing behind.
if [ "$status" -ne 0 ] || /usr/bin/grep -q '"result": *"failed"' "$W/out.log" 2>/dev/null; then
  K=/var/lib/pai/data/state/e2e-failures/$(date -u +%Y%m%dT%H%M%SZ)-$E2E; install -d -o pai -m 0700 "$(dirname "$K")"
  mv "$W/state" "$K" 2>/dev/null && echo "kept failed state in $K" >&2
fi
rm -rf "$W"
exit "$status"
