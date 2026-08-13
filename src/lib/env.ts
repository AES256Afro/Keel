// Environment variables, with the pre-rename names still honoured.
//
// The app was called Nopin, so every setting was NOPIN_*. Renaming them
// outright would break any existing deployment on its next restart - including
// the production instance - which is not an acceptable cost for a cosmetic
// change. Both prefixes are read, KEEL_ wins, and NOPIN_ logs a one-time notice
// so the migration is visible rather than silent.
//
// This lives on its own with no imports so proxy, route handlers and the
// standalone desktop server can all use it.

const warned = new Set<string>();

/**
 * Read a Keel setting.
 * @param suffix the part after the prefix, e.g. "OWNER_EMAIL"
 */
export function keelEnv(suffix: string): string | undefined {
  const current = process.env[`KEEL_${suffix}`];
  if (current !== undefined && current !== "") return current;

  const legacy = process.env[`NOPIN_${suffix}`];
  if (legacy !== undefined && legacy !== "") {
    if (!warned.has(suffix)) {
      warned.add(suffix);
      console.warn(
        `[keel] using NOPIN_${suffix}; rename it to KEEL_${suffix} - the old name will stop being read in a future release.`
      );
    }
    return legacy;
  }
  return undefined;
}

/** True when the setting is present and not obviously "off". */
export function keelFlag(suffix: string): boolean {
  const value = keelEnv(suffix);
  return value != null && /^(1|true|yes|on)$/i.test(value.trim());
}
