function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-clone a value suitable for middleware context snapshots.
 * Handles plain objects, arrays, Date, RegExp, Map, Set, and primitives.
 * Non-cloneable values (functions, symbols, etc.) are returned as-is.
 */
export function cloneContextValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  // Date
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  // RegExp
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as T;
  }
  // Map
  if (value instanceof Map) {
    const cloned = new Map<string | number | symbol, unknown>();
    for (const [k, v] of (value as Map<string | number | symbol, unknown>)) {
      cloned.set(k, cloneContextValue(v));
    }
    return cloned as T;
  }
  // Set
  if (value instanceof Set) {
    const cloned = new Set<unknown>();
    for (const v of (value as Set<unknown>)) {
      cloned.add(cloneContextValue(v));
    }
    return cloned as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneContextValue(item)) as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = cloneContextValue(entry);
    }
    return out as T;
  }
  return value;
}
