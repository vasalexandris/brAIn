import { afterEach, describe, expect, it } from "vitest";
import { isAdmin, isApproved } from "@/auth/access";

describe("έγκριση λογαριασμών", () => {
  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  it("χωρίς ADMIN_EMAIL όλοι μπαίνουν και κανείς δεν είναι διαχειριστής", () => {
    expect(isApproved({ email: "a@b.gr", status: "pending" })).toBe(true);
    expect(isAdmin({ email: "" })).toBe(false);
  });

  it("με ADMIN_EMAIL μπαίνουν μόνο ο διαχειριστής και οι εγκεκριμένοι", () => {
    process.env.ADMIN_EMAIL = " Boss@Site.gr ";
    expect(isAdmin({ email: "boss@site.gr" })).toBe(true);
    expect(isApproved({ email: "boss@site.gr", status: "pending" })).toBe(true);
    expect(isApproved({ email: "a@b.gr", status: "pending" })).toBe(false);
    expect(isApproved({ email: "a@b.gr", status: "rejected" })).toBe(false);
    expect(isApproved({ email: "a@b.gr", status: "approved" })).toBe(true);
    expect(isAdmin({ email: "a@b.gr" })).toBe(false);
  });
});
