# Security policy

## Supported version

Security fixes are made for the latest published Keel release.

## Report a vulnerability

Use GitHub's private vulnerability reporting form:

https://github.com/AES256Afro/Keel/security/advisories/new

Include the affected version, deployment type, reproduction steps, impact, and
any suggested mitigation. Do not include real notes, passwords, tokens, backup
passphrases, database files, or personal deployment details.

Please do not open a public issue until a fix is available. You should receive
an acknowledgement within seven days. A release timeline depends on severity
and reproducibility.

## Operator responsibility

Keel is self-hosted software. Operators are responsible for HTTPS, host and
disk security, access restrictions, software updates, and tested backups. The
live SQLite or PostgreSQL database is not application-encrypted. Use full-disk
or volume encryption if the storage medium needs encryption at rest.
