#!/bin/sh
set -eu

# Gate parity with templates/deploy/proxy.ts (CONTRACT.md §6): only the
# literal "false" opens ACCESS_RESTRICTED. Any other value, including
# unset, stays restricted - never write this the other way around
# (checking for the "open" literal, not the "restricted" one).
GATE_FILE=/etc/caddy/gate.caddy

if [ "${ACCESS_RESTRICTED:-}" = "false" ]; then
  : > "$GATE_FILE"
else
  ip_matchers=""
  # Unquoted $(...) below is a word-split-on-purpose (one entry per loop
  # turn) - set -f stops an entry that happens to contain a glob character
  # from expanding against files in cwd first.
  set -f
  for entry in $(printf '%s' "${ACCESS_ALLOWED_IPS:-}" | tr ',' '\n'); do
    trimmed=$(printf '%s' "$entry" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -z "$trimmed" ] && continue
    # Conservative IPv4/IPv6/CIDR shape check. A garbage entry must not
    # brick config load - warn to stderr and drop it instead of aborting.
    if printf '%s' "$trimmed" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$|^[0-9a-fA-F:]+(/[0-9]{1,3})?$'; then
      ip_matchers="$ip_matchers $trimmed"
    else
      echo "docker-entrypoint: dropping invalid ACCESS_ALLOWED_IPS entry: $trimmed" >&2
    fi
  done
  ip_matchers=$(printf '%s' "$ip_matchers" | sed 's/^[[:space:]]*//')

  token="${ACCESS_BYPASS_TOKEN:-}"
  token_len=${#token}
  bypass_line=""
  if [ "$token_len" -ge 32 ]; then
    # Single-quoted so $ stays literal with no backslash needed: the
    # placeholder text itself, never the token value. {$ACCESS_BYPASS_TOKEN}
    # resolves at Caddy config load, so the secret never touches disk here.
    bypass_line='not header x-baudrier-access-token {$ACCESS_BYPASS_TOKEN}'
  fi

  ip_line=""
  [ -n "$ip_matchers" ] && ip_line="not client_ip $ip_matchers"

  if [ -z "$ip_line" ] && [ -z "$bypass_line" ]; then
    {
      echo "header x-baudrier-client-ip {client_ip}"
      printf 'respond "Accès refusé : aucune adresse ni jeton n’a été configuré pour ce site." 403\n'
    } > "$GATE_FILE"
  else
    {
      echo "@baudrier_denied {"
      [ -n "$ip_line" ] && echo "	$ip_line"
      [ -n "$bypass_line" ] && echo "	$bypass_line"
      echo "}"
      echo "handle @baudrier_denied {"
      echo "	header x-baudrier-client-ip {client_ip}"
      printf '\trespond "Accès refusé : votre adresse IP n’a pas été autorisée à consulter ce site." 403\n'
      echo "}"
    } > "$GATE_FILE"
  fi
fi

# Backstop for M2: the shape check above (grep -Eq) accepts strings Caddy's
# own CIDR parser rejects (1.2.3.256, a /33 mask, a bare hex word) - those
# would otherwise crash-loop the container on config load. Validate the
# rendered Caddyfile and fail CLOSED (unconditional 403), never open, if
# something still slipped through.
if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  echo "docker-entrypoint: gate.caddy failed caddy validate - falling back to an unconditional 403" >&2
  {
    echo "header x-baudrier-client-ip {client_ip}"
    printf 'respond "Accès refusé : configuration invalide, ce site est temporairement inaccessible." 403\n'
  } > "$GATE_FILE"
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
