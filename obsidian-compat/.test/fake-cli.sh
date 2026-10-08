#!/bin/sh
# A stand-in for an agent's CLI (claude, codex…) in an isolated lab: says what it was asked, never reaches a real account.
case "$1" in
  --version|-v|version) echo "1.0.0 (fake)"; exit 0 ;;
esac
echo "$(basename "$0") $*" >> "${HOME:-/tmp}/fake-cli.log"
input=""
[ -t 0 ] || input=$(head -c 2000)
echo "fake $(basename "$0"): $*"
[ -n "$input" ] && echo "stdin: $input" | head -c 300
exit 0
