// The scope vocabulary and alias expansion live in the database package so the
// authorization helpers and the API share exactly one list.
export {
  RESOURCE_SCOPES,
  SCOPE_ALIASES,
  SCOPES,
  expandScopes,
  isResourceScope,
  isScope,
  type ResourceScope,
  type Scope,
  type ScopeAlias,
} from "@invoicewise/db/utils/scopes";

export type ScopePreset = "all_access" | "read_only" | "restricted";

export const scopePresets = [
  {
    value: "all_access",
    label: "All",
    description: "full access to all resources",
  },
  {
    value: "read_only",
    label: "Read Only",
    description: "read-only access to all resources",
  },
  {
    value: "restricted",
    label: "Restricted",
    description: "restricted access to some resources",
  },
];

export const scopesToName = (scopes: string[]) => {
  if (scopes.includes("apis.all")) {
    return {
      name: "All access",
      description: "full access to all resources",
      preset: "all_access",
    };
  }

  if (scopes.includes("apis.read")) {
    return {
      name: "Read-only",
      description: "read-only access to all resources",
      preset: "read_only",
    };
  }

  return {
    name: "Restricted",
    description: "restricted access to some resources",
    preset: "restricted",
  };
};
