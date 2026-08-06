import { describe, it, expect } from "vitest";
import { trackingSchema } from "../tracking-schema.js";

describe("trackingSchema", () => {
  it("accepts a category identified by name and option alone", () => {
    const parsed = trackingSchema.parse({ name: "Property", option: "17PS" });
    expect(parsed).toEqual({ name: "Property", option: "17PS" });
  });

  it("accepts an explicit tracking category ID alongside the names", () => {
    const parsed = trackingSchema.parse({
      name: "Property",
      option: "17PS",
      trackingCategoryID: "8ef94a0b-b447-42f3-8529-4576ce845d80",
    });
    expect(parsed.trackingCategoryID).toBe(
      "8ef94a0b-b447-42f3-8529-4576ce845d80",
    );
  });

  it("rejects a category with no option", () => {
    expect(trackingSchema.safeParse({ name: "Property" }).success).toBe(false);
  });

  it("rejects an option with no category name", () => {
    expect(trackingSchema.safeParse({ option: "17PS" }).success).toBe(false);
  });
});
