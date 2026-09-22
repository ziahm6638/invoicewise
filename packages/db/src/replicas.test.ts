import { describe, expect, test } from "bun:test";
import { withReplicas } from "./replicas";

function fakeDatabase(name: string) {
  return {
    name,
    execute: async () => ({ rows: [{ name }] }),
    select: `${name}-select`,
    selectDistinct: `${name}-select-distinct`,
    selectDistinctOn: `${name}-select-distinct-on`,
    $count: `${name}-count`,
    with: `${name}-with`,
    $with: `${name}-$with`,
    query: `${name}-query`,
    update: `${name}-update`,
    insert: `${name}-insert`,
    delete: `${name}-delete`,
    transaction: `${name}-transaction`,
    refreshMaterializedView: `${name}-refresh-materialized-view`,
  };
}

describe("withReplicas", () => {
  test("uses the primary for reads when no replicas are configured", async () => {
    const primary = fakeDatabase("primary");
    const database = withReplicas(primary as never, []) as typeof primary & {
      executeOnReplica: (query: string) => Promise<Array<{ name: string }>>;
    };

    expect(database.select).toBe("primary-select");
    expect(await database.executeOnReplica("select 1")).toEqual([
      { name: "primary" },
    ]);
  });

  test("uses the selected replica for reads when replicas are configured", () => {
    const primary = fakeDatabase("primary");
    const replica = fakeDatabase("replica");
    const database = withReplicas(
      primary as never,
      [replica as never],
      (replicas) => replicas[0]!,
    ) as typeof primary;

    expect(database.select).toBe("replica-select");
    expect(database.insert).toBe("primary-insert");
  });
});
