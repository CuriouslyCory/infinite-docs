import { describe, expect, it } from "vitest";

import {
  capabilityAtLeast,
  requireCapability,
  resolveCapability,
  type Capability,
} from "../access";
import { type Actor } from "../actor";
import { ForbiddenError } from "../errors";

// Pure resolver tests — DB-free, no test database. The unit the whole sharing
// spine rests on (ADR-0040).

const OWNER_ID = "owner-1";
const owner: Actor = { userId: OWNER_ID, via: "session" };
const stranger: Actor = { userId: "stranger-1", via: "session" };

describe("resolveCapability — owner is the irrevocable root of trust", () => {
  it("resolves the owner to `owner` even when guestAccess is NONE", () => {
    expect(
      resolveCapability(
        owner,
        { ownerId: OWNER_ID, guestAccess: "NONE" },
        null,
      ),
    ).toBe("owner");
  });

  it("resolves the owner to `owner` even with a stray VIEWER membership row", () => {
    // A defensive invariant: an owner with an accidental membership row is never
    // demoted (owner is checked FIRST and unconditionally).
    expect(
      resolveCapability(
        owner,
        { ownerId: OWNER_ID, guestAccess: "VIEW" },
        {
          role: "VIEWER",
        },
      ),
    ).toBe("owner");
  });

  it("resolves the owner to `owner` at guestAccess VIEW with no membership", () => {
    expect(
      resolveCapability(
        owner,
        { ownerId: OWNER_ID, guestAccess: "VIEW" },
        null,
      ),
    ).toBe("owner");
  });
});

describe("resolveCapability — membership roles map onto the ladder", () => {
  it("maps VIEWER → view", () => {
    expect(
      resolveCapability(
        stranger,
        { ownerId: OWNER_ID, guestAccess: "NONE" },
        { role: "VIEWER" },
      ),
    ).toBe("view");
  });

  it("maps EDITOR → edit", () => {
    expect(
      resolveCapability(
        stranger,
        { ownerId: OWNER_ID, guestAccess: "NONE" },
        { role: "EDITOR" },
      ),
    ).toBe("edit");
  });

  it("maps ADMIN → admin", () => {
    expect(
      resolveCapability(
        stranger,
        { ownerId: OWNER_ID, guestAccess: "NONE" },
        { role: "ADMIN" },
      ),
    ).toBe("admin");
  });

  it("a member beats guest access (member at NONE still gets the role cap)", () => {
    expect(
      resolveCapability(
        stranger,
        { ownerId: OWNER_ID, guestAccess: "NONE" },
        { role: "EDITOR" },
      ),
    ).toBe("edit");
  });
});

describe("resolveCapability — guest access for non-members", () => {
  it("non-member at guestAccess VIEW → view", () => {
    expect(
      resolveCapability(
        stranger,
        { ownerId: OWNER_ID, guestAccess: "VIEW" },
        null,
      ),
    ).toBe("view");
  });

  it("non-member at guestAccess NONE → none", () => {
    expect(
      resolveCapability(
        stranger,
        { ownerId: OWNER_ID, guestAccess: "NONE" },
        null,
      ),
    ).toBe("none");
  });

  it("anonymous (no actor) at guestAccess VIEW → view", () => {
    expect(
      resolveCapability(null, { ownerId: OWNER_ID, guestAccess: "VIEW" }, null),
    ).toBe("view");
  });

  it("anonymous (no actor) at guestAccess NONE → none", () => {
    expect(
      resolveCapability(null, { ownerId: OWNER_ID, guestAccess: "NONE" }, null),
    ).toBe("none");
  });
});

describe("requireCapability — the rank ladder", () => {
  const rungs: Capability[] = ["none", "view", "edit", "admin", "owner"];

  it("each rung satisfies its own minimum and every lower minimum", () => {
    for (let i = 0; i < rungs.length; i++) {
      const cap = rungs[i]!;
      for (let j = 0; j <= i; j++) {
        const min = rungs[j]!;
        expect(() => requireCapability(cap, min)).not.toThrow();
      }
    }
  });

  it("throws ForbiddenError when the capability is below the minimum", () => {
    expect(() => requireCapability("view", "edit")).toThrow(ForbiddenError);
    expect(() => requireCapability("none", "view")).toThrow(ForbiddenError);
    expect(() => requireCapability("edit", "admin")).toThrow(ForbiddenError);
    expect(() => requireCapability("admin", "owner")).toThrow(ForbiddenError);
  });

  it("admin satisfies a view minimum; edit does not satisfy admin", () => {
    expect(() => requireCapability("admin", "view")).not.toThrow();
    expect(() => requireCapability("edit", "admin")).toThrow(ForbiddenError);
  });
});

describe("capabilityAtLeast — boolean form for route shells", () => {
  it("returns true at or above the minimum, false below", () => {
    expect(capabilityAtLeast("owner", "edit")).toBe(true);
    expect(capabilityAtLeast("edit", "edit")).toBe(true);
    expect(capabilityAtLeast("view", "edit")).toBe(false);
    expect(capabilityAtLeast("admin", "admin")).toBe(true);
    expect(capabilityAtLeast("edit", "admin")).toBe(false);
  });
});
