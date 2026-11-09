#!/usr/bin/env bash
set -uo pipefail

if (($# == 0)); then
  echo "Usage: $0 command [args...]" >&2
  exit 2
fi

max_attempts=3
attempt=1
while true; do
  log_file="$(mktemp)"
  "$@" 2>&1 | tee "$log_file"
  command_status=${PIPESTATUS[0]}

  if ((command_status == 0)); then
    rm -f "$log_file"
    exit 0
  fi

  if ! grep -Eiq 'Response code 5[0-9][0-9]|HTTPError.*5[0-9][0-9]|Gateway Time[- ]out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ECONNABORTED|socket hang up' "$log_file"; then
    echo "Command failed with status ${command_status}; failure does not match a transient download/network error, so it will not be retried." >&2
    rm -f "$log_file"
    exit "$command_status"
  fi

  rm -f "$log_file"
  if ((attempt >= max_attempts)); then
    echo "Transient download/network failure persisted after ${max_attempts} attempts." >&2
    exit "$command_status"
  fi

  wait_seconds=$((attempt * 10))
  echo "Transient download/network failure on attempt ${attempt}/${max_attempts}; retrying in ${wait_seconds}s..." >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
