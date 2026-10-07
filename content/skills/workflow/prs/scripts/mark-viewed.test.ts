import { describe, expect, it } from "bun:test";

import { type ChangedFile, kindOf, testReviewReason } from "./mark-viewed";

const testFile = (patch: string | null, status = "modified"): ChangedFile => ({
  filename: "tests/Feature/OrderTest.php",
  status,
  changes: 10,
  patch,
});

describe("mark-viewed", () => {
  it("classifies low-review files and leaves app code, docs, and migrations alone", () => {
    expect(kindOf("src/cart.test.ts")).toBe("test");
    expect(kindOf("tests/Feature/OrderTest.php")).toBe("test");
    expect(kindOf("app/__snapshots__/cart.test.ts.snap")).toBe("generated");
    expect(kindOf("src/routeTree.gen.ts")).toBe("generated");
    expect(kindOf("bun.lock")).toBe("lock");
    expect(kindOf("pnpm-lock.yaml")).toBe("lock");
    expect(kindOf("assets/logo.svg")).toBe("asset");
    expect(kindOf("app/Models/Order.php")).toBeNull();
    expect(kindOf("docs/setup.md")).toBeNull();
    expect(kindOf("database/migrations/2026_01_01_create_orders.php")).toBeNull();
  });

  it("ticks test files that only add or extend tests", () => {
    const patch = [
      "@@ -10,3 +10,8 @@",
      " it('creates an order', function () {",
      "+    expect($order->total)->toBe(100);",
      " });",
      "+it('refunds an order', function () {",
      "+    expect($order->refund())->toBeTrue();",
      "+});",
    ].join("\n");

    expect(testReviewReason(testFile(patch))).toBeNull();
    expect(testReviewReason({ ...testFile(null, "renamed"), changes: 0 })).toBeNull();
  });

  it("keeps test files that delete, weaken, or skip tests", () => {
    expect(
      testReviewReason(
        testFile("@@ -1 +1 @@\n-    expect($a)->toBe(1);\n+    expect($a)->toBe(2);"),
      ),
    ).toBe("removes or changes a test or assertion");
    expect(testReviewReason(testFile("@@ -1 +1 @@\n-        $this->assertTrue($ok);"))).toBe(
      "removes or changes a test or assertion",
    );
    expect(testReviewReason(testFile("@@ -1 +1 @@\n+it.skip('flaky', () => {});"))).toBe(
      "adds a skip or focus marker",
    );
    expect(testReviewReason(testFile("@@ -0,0 +1 @@\n+x", "removed"))).toBe("file deleted");
    expect(testReviewReason(testFile(null))).toBe("diff too large to check");
  });
});
