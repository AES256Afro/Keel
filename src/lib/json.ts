// JSON columns are stored as strings so the schema works on SQLite and
// PostgreSQL alike. These helpers keep parse/serialize in one place.

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
