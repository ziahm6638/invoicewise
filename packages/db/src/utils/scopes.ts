/**
 * The authoritative scope vocabulary.
 *
 * Credentials (API keys and OAuth tokens) may only ever hold scopes from
 * `RESOURCE_SCOPES`. Aliases are expanded before any role intersection and
 * unknown values are dropped, so an unrecognised scope can never be granted.
 */
export const RESOURCE_SCOPES = [
  "inbox.read",
  "inbox.write",
  "payments.read",
  "sources.read",
  "sources.write",
  "teams.read",
  "teams.write",
  "users.read",
  "users.write",
] as const;

export const SCOPE_ALIASES = ["apis.all", "apis.read"] as const;

/**
 * Scopes no alias implies: they must be requested by name. `payments.read`
 * exposes bank transactions, so `apis.all`/`apis.read` (and credentials
 * granted them before it existed) never include it.
 */
export const EXPLICIT_SCOPES: readonly string[] = ["payments.read"];

export const SCOPES = [...RESOURCE_SCOPES, ...SCOPE_ALIASES] as const;

export type ResourceScope = (typeof RESOURCE_SCOPES)[number];
export type ScopeAlias = (typeof SCOPE_ALIASES)[number];
export type Scope = (typeof SCOPES)[number];

export const isResourceScope = (value: unknown): value is ResourceScope =>
  typeof value === "string" &&
  (RESOURCE_SCOPES as readonly string[]).includes(value);

export const isScope = (value: unknown): value is Scope =>
  typeof value === "string" && (SCOPES as readonly string[]).includes(value);

/**
 * Expands aliases into concrete resource scopes and drops anything unknown.
 */
export const expandScopes = (scopes: readonly string[]): ResourceScope[] => {
  const expanded = new Set<ResourceScope>();

  for (const scope of scopes) {
    if (scope === "apis.all") {
      for (const resource of RESOURCE_SCOPES) {
        if (!EXPLICIT_SCOPES.includes(resource)) expanded.add(resource);
      }
      continue;
    }

    if (scope === "apis.read") {
      for (const resource of RESOURCE_SCOPES) {
        if (resource.endsWith(".read") && !EXPLICIT_SCOPES.includes(resource)) {
          expanded.add(resource);
        }
      }
      continue;
    }

    if (isResourceScope(scope)) {
      expanded.add(scope);
    }
  }

  return [...expanded];
};

/**
 * Whether every requested scope is known and covered by the scopes the
 * application registered. Both sides are normalized, so an application that
 * registers `apis.all` covers a request for `inbox.read`, while an unknown
 * scope never passes.
 */
export const scopesWithinApplication = (
  registeredScopes: readonly string[],
  requestedScopes: readonly string[],
): boolean => {
  if (!requestedScopes.every((scope) => isScope(scope))) {
    return false;
  }

  const registered = new Set<string>(expandScopes(registeredScopes));

  return expandScopes(requestedScopes).every((scope) => registered.has(scope));
};
