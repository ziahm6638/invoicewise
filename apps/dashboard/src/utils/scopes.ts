export const RESOURCES = [
  {
    key: "inbox",
    name: "Inbox",
    description: "Access to extracted invoice data",
    scopes: [
      { scope: "inbox.read", type: "read", label: "Read" },
      { scope: "inbox.write", type: "write", label: "Write" },
    ],
  },
  {
    key: "sources",
    name: "Authorization sources",
    description:
      "Jobs, purchase orders and contracts invoices are checked against",
    scopes: [
      { scope: "sources.read", type: "read", label: "Read" },
      { scope: "sources.write", type: "write", label: "Write" },
    ],
  },
  {
    key: "payments",
    name: "Bank payments",
    description:
      "Invoice payment status with the bank transactions and evidence behind it (owners and admins)",
    scopes: [{ scope: "payments.read", type: "read", label: "Read" }],
  },
  {
    key: "teams",
    name: "Teams",
    description: "Access to team data",
    scopes: [
      { scope: "teams.read", type: "read", label: "Read" },
      { scope: "teams.write", type: "write", label: "Write" },
    ],
  },
  {
    key: "users",
    name: "Users",
    description: "Access to user data",
    scopes: [
      { scope: "users.read", type: "read", label: "Read" },
      { scope: "users.write", type: "write", label: "Write" },
    ],
  },
] as const;

export const getScopeDescription = (scope: string) => {
  if (scope === "apis.all") {
    return { label: "Full access to all resources" };
  }

  if (scope === "apis.read") {
    return { label: "Read-only access to all resources" };
  }

  for (const resource of RESOURCES) {
    const foundScope = resource.scopes.find((item) => item.scope === scope);
    if (foundScope) {
      return { label: `${foundScope.label} access to ${resource.name}` };
    }
  }

  return { label: scope };
};
