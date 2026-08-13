// Backup file naming, shared by the server and the browser.
//
// Kept free of server-only imports so client components can use it too - the
// Settings UI decides from the filename whether to prompt for a passphrase, and
// getting that wrong means a silent failed restore.
//
// Both spellings are recognised forever. The app was called Nopin; a rename
// that makes your existing backups invisible is not a rename, it is data loss.

/** Extension written for new encrypted backups. */
export const ENCRYPTED_EXTENSION = ".keelbak";

/** Every extension an encrypted backup may carry, newest first. */
export const ENCRYPTED_EXTENSIONS = [".keelbak", ".nopinbak"] as const;

/** Every extension a backup file of any kind may carry. */
export const BACKUP_EXTENSIONS = [".json", ...ENCRYPTED_EXTENSIONS] as const;

/**
 * Whether a file NAME says the file is encrypted.
 *
 * A claim about the name, and only about the name - the bytes may say
 * something else, because a backup store can be a synced folder anyone with
 * access can write to. So this answer is never the last word: it decides what
 * the UI shows (the padlock, the passphrase prompt), and the server then holds
 * the file to whatever it decided. backupFileStream() attaches this claim to
 * the stream it opens and readBackupStream() refuses a file that contradicts
 * it; see the trust-boundary note in backup.ts. Before that, a swapped-for-
 * plaintext .keelbak still showed the padlock, still prompted, and still
 * restored - the prompt being pure theatre is exactly the failure this pairing
 * exists to prevent.
 */
export function isEncryptedBackupName(name: string): boolean {
  return ENCRYPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function isBackupName(name: string): boolean {
  return BACKUP_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Filename prefixes identifying a workspace's backups, newest first. */
export function backupPrefixes(workspaceId: string): string[] {
  const short = workspaceId.slice(0, 12);
  return [`keel-${short}-`, `nopin-${short}-`];
}
