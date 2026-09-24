import { describe, expect, test } from "bun:test";
import { memberRowPermissions } from "./permissions";

const row = (
  overrides: Partial<Parameters<typeof memberRowPermissions>[0]> = {},
) =>
  memberRowPermissions({
    canManageMembers: true,
    currentUserRole: "owner",
    currentUserId: "me",
    targetUserId: "other",
    targetRole: "member",
    totalOwners: 1,
    ...overrides,
  });

describe("members table gating", () => {
  test("a member gets no member controls at all", () => {
    const permissions = row({
      canManageMembers: false,
      currentUserRole: "member",
    });

    expect(permissions.canManageRow).toBe(false);
    expect(permissions.canRemoveRow).toBe(false);
  });

  test("an admin manages admins and members but never owners", () => {
    expect(
      row({ currentUserRole: "admin", targetRole: "member" }).canManageRow,
    ).toBe(true);
    expect(
      row({ currentUserRole: "admin", targetRole: "admin" }).canManageRow,
    ).toBe(true);
    expect(
      row({ currentUserRole: "admin", targetRole: "owner" }).canManageRow,
    ).toBe(false);
    expect(
      row({ currentUserRole: "admin", targetRole: "owner" }).canRemoveRow,
    ).toBe(false);
    expect(
      row({ currentUserRole: "admin", targetRole: "member" }).assignableRoles,
    ).toEqual(["admin", "member"]);
  });

  test("only an owner can grant the owner role", () => {
    expect(row({ currentUserRole: "owner" }).assignableRoles).toEqual([
      "owner",
      "admin",
      "member",
    ]);
    expect(row({ currentUserRole: "admin" }).assignableRoles).not.toContain(
      "owner",
    );
  });

  test("the last owner cannot demote or remove themselves", () => {
    const lastOwner = row({
      currentUserRole: "owner",
      currentUserId: "me",
      targetUserId: "me",
      targetRole: "owner",
      totalOwners: 1,
    });

    expect(lastOwner.canManageRow).toBe(false);
    expect(lastOwner.canRemoveRow).toBe(false);
  });

  test("an owner with a co-owner can step down or remove them", () => {
    const coOwner = row({
      currentUserRole: "owner",
      currentUserId: "me",
      targetUserId: "me",
      targetRole: "owner",
      totalOwners: 2,
    });

    expect(coOwner.canManageRow).toBe(true);
    expect(coOwner.canRemoveRow).toBe(false); // self-removal is "leave"

    const otherOwner = row({
      currentUserRole: "owner",
      currentUserId: "me",
      targetUserId: "other-owner",
      targetRole: "owner",
      totalOwners: 2,
    });

    expect(otherOwner.canRemoveRow).toBe(true);
  });
});
