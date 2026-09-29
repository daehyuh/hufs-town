#!/bin/sh
set -eu

fail() {
  printf '%s\n' "Coturn configuration error: $1" >&2
  exit 1
}

[ -n "${MEDIA_TURN_SHARED_SECRET:-}" ] || fail 'MEDIA_TURN_SHARED_SECRET is required when the turn profile is enabled'
[ "${#MEDIA_TURN_SHARED_SECRET}" -ge 64 ] || fail 'MEDIA_TURN_SHARED_SECRET must be at least 64 hexadecimal characters'
case "$MEDIA_TURN_SHARED_SECRET" in
  *[!0-9a-fA-F]*) fail 'MEDIA_TURN_SHARED_SECRET must be hexadecimal' ;;
esac

[ -n "${TURN_RELAY_IP:-}" ] || fail 'TURN_RELAY_IP must be set to the server private IPv4 address'
case "$TURN_RELAY_IP" in
  *[!0-9.]*) fail 'TURN_RELAY_IP must be an IPv4 address' ;;
esac
[ -n "${TURN_EXTERNAL_IP:-}" ] || fail 'TURN_EXTERNAL_IP must be set to the server public IPv4 address'
case "$TURN_EXTERNAL_IP" in
  *[!0-9.]*) fail 'TURN_EXTERNAL_IP must be an IPv4 address' ;;
esac

TURN_REALM=${TURN_REALM:-town.gdgoc.com}
case "$TURN_REALM" in
  ''|*[!a-zA-Z0-9.-]*) fail 'TURN_REALM may contain only letters, digits, dots, and hyphens' ;;
esac

# Coturn reads the shared secret from this private, container-local config file
# instead of exposing it in the process argument list.
umask 077
config_file=/tmp/turnserver.conf
printf '%s\n' \
  'listening-port=3478' \
  "listening-ip=$TURN_RELAY_IP" \
  "relay-ip=$TURN_RELAY_IP" \
  "external-ip=$TURN_EXTERNAL_IP/$TURN_RELAY_IP" \
  'min-port=49160' \
  'max-port=49959' \
  'relay-threads=1' \
  "realm=$TURN_REALM" \
  'use-auth-secret' \
  "static-auth-secret=$MEDIA_TURN_SHARED_SECRET" \
  'fingerprint' \
  'no-cli' \
  'no-tls' \
  'no-dtls' \
  'no-loopback-peers' \
  'no-multicast-peers' > "$config_file"

exec turnserver --log-file=stdout -c "$config_file"
