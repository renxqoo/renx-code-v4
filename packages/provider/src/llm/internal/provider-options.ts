import { LLMError } from "../errors";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractVendorOptions(
  providerOptions: Record<string, unknown> | undefined,
  vendorId: string,
  knownNamespaces: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!providerOptions) return providerOptions;

  const vendorBucket = isPlainRecord(providerOptions[vendorId]) ? providerOptions[vendorId] : {};
  const namespaces = new Set(knownNamespaces);
  namespaces.add(vendorId);

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(providerOptions)) {
    if (!namespaces.has(key)) {
      extras[key] = value;
    }
  }

  const merged = { ...extras, ...vendorBucket };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function assertNoReservedProviderOptions(
  vendorId: string,
  modelId: string,
  providerOptions: Record<string, unknown> | undefined,
  reservedKeys: readonly string[],
): void {
  if (!providerOptions) return;

  const collisions = reservedKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(providerOptions, key),
  );
  if (collisions.length === 0) return;

  throw new LLMError({
    code: "INVALID_REQUEST",
    message: `${vendorId} providerOptions cannot override reserved fields: ${collisions.join(", ")}`,
    retryable: false,
    vendor: vendorId,
    modelId,
  });
}
