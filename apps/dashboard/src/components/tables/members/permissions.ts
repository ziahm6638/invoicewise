/**
 * Row-level decisions for the members table.
 *
 * These mirror the server matrix so the dashboard shows the right controls.
 * They are a convenience only: every mutation is re-checked on the server.
 */
export type TeamRoleName = "owner" | "admin" | "member";

export type MemberRowPermissions = {
  canManageRow: boolean;
  canRemoveRow: boolean;
  assignableRoles: readonly TeamRoleName[];
};

export const memberRowPermissions = (params: {
  canManageMembers: boolean;
  currentUserRole: TeamRoleName | null | undefined;
  currentUserId: string | null | undefined;
  targetUserId: string | null | undefined;
  targetRole: TeamRoleName | null | undefined;
  totalOwners: number;
}): MemberRowPermissions => {
  const {
    canManageMembers,
    currentUserRole,
    currentUserId,
    targetUserId,
    targetRole,
    totalOwners,
  } = params;

  const isSelf = Boolean(currentUserId) && currentUserId === targetUserId;

  // Admins manage admins and members; only owners manage owners. The last owner
  // can never demote or remove themselves.
  const canManageRow =
    canManageMembers &&
    (targetRole !== "owner" ||
      (currentUserRole === "owner" && (!isSelf || totalOwners > 1)));

  const canRemoveRow =
    canManageMembers &&
    !isSelf &&
    (targetRole !== "owner" || currentUserRole === "owner");

  const assignableRoles: readonly TeamRoleName[] =
    currentUserRole === "owner"
      ? (["owner", "admin", "member"] as const)
      : (["admin", "member"] as const);

  return { canManageRow, canRemoveRow, assignableRoles };
};
