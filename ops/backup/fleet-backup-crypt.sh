#!/bin/bash
# fleet-backup-crypt.sh -- OPTIONAL archive encryption for fleet-backup.sh / fleet-restore.sh.  [BACKUP-CRYPT-V1]
# Sourced, never executed. Only loaded when encryption is in play:
#   fleet-backup.sh   sources it only when /etc/fleet/backup.env sets BACKUP_ENCRYPT_SECRET=<secret name>
#   fleet-restore.sh  sources it only for an encrypted archive (*.gpg name, sidecar flag, or OpenPGP content)
# Format: OpenPGP symmetric (gpg --symmetric --cipher-algo AES256, iterated+salted SHA512 S2K, integrity-
# protected) wrapped around the unchanged .tar.gz stream -> fleet-backup-<ts>-<scope>.tar.gz.gpg.
# Decrypt by hand anywhere:  gpg --decrypt fleet-backup-....tar.gz.gpg > fleet-backup-....tar.gz
# The passphrase is a Secret Manager secret (installer default: backup-passphrase). It is passed to gpg on
# file descriptor 3 only -- never on a command line, in the environment of a child, in a log or in the archive.

# bk_sm_access NAME -> the latest version of Secret Manager secret NAME on stdout (no trailing newline).
# Uses the VM's metadata-server token, the same pattern as fleet-load-cp-secrets.sh, but hands the bearer
# token to curl on stdin (--config -) so it never shows up in the process list.
bk_sm_access() {
  local md=http://metadata.google.internal/computeMetadata/v1 p at
  p="${BK_PROJECT:-$(curl -sf -H Metadata-Flavor:Google "$md/project/project-id")}" || return 1
  at=$(curl -sf -H Metadata-Flavor:Google "$md/instance/service-accounts/default/token" | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
  [ -n "$p" ] && [ -n "$at" ] || return 1
  printf 'header = "Authorization: Bearer %s"\n' "$at" \
    | curl -sf --config - "https://secretmanager.googleapis.com/v1/projects/$p/secrets/$1/versions/latest:access" \
    | sed -n 's/.*"data" *: *"\([^"]*\)".*/\1/p' | base64 -d 2>/dev/null
}

# A throwaway GNUPGHOME per call: no keyring, no agent cache of the passphrase survives the call.
_bk_gpg() {
  local h rc
  h=$(mktemp -d "${BK_GPG_TMP:-/var/tmp}/.bkgpg-XXXXXX") || return 1
  chmod 700 "$h"
  gpg --homedir "$h" --batch --yes --quiet --no-tty --no-options --pinentry-mode loopback --no-symkey-cache --passphrase-fd 3 "$@"
  rc=$?
  gpgconf --homedir "$h" --kill gpg-agent >/dev/null 2>&1
  rm -rf "$h"
  return $rc
}

# bk_encrypt  : plaintext on stdin -> OpenPGP AES256 ciphertext on stdout. Passphrase on fd 3.
bk_encrypt() {
  _bk_gpg --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    --compress-algo none -o -
}

# bk_decrypt  : ciphertext on stdin -> plaintext on stdout. Passphrase on fd 3. Non-zero (and a gpg
# message on stderr) on a wrong passphrase, a truncated file or a failed integrity check.
bk_decrypt() {
  _bk_gpg --decrypt -o -
}

# bk_is_openpgp FILE : true when FILE starts like an OpenPGP symmetric-key packet (renamed/sniffed archives).
bk_is_openpgp() {
  local b
  b=$(head -c1 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')
  case "$b" in 8c|c3) return 0;; *) return 1;; esac
}
