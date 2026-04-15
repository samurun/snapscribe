import { describe, expect, it, mock, beforeEach } from "bun:test";

const verifyTokenMock = mock(async (_token: string, _opts: unknown) => ({
  sub: "user_default",
}));

mock.module("@clerk/backend", () => ({
  createClerkClient: () => ({}),
  verifyToken: verifyTokenMock,
}));

const { userIdFromHeader } = await import("../src/auth");

describe("userIdFromHeader", () => {
  beforeEach(() => {
    verifyTokenMock.mockClear();
  });

  it("returns null when header is missing", async () => {
    expect(await userIdFromHeader(null)).toBeNull();
    expect(await userIdFromHeader(undefined)).toBeNull();
    expect(await userIdFromHeader("")).toBeNull();
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it("returns null when Bearer prefix leaves empty token", async () => {
    expect(await userIdFromHeader("Bearer ")).toBeNull();
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it("returns userId (sub) when verifyToken resolves", async () => {
    verifyTokenMock.mockResolvedValueOnce({ sub: "user_abc" });
    const id = await userIdFromHeader("Bearer my.jwt.token");
    expect(id).toBe("user_abc");
    expect(verifyTokenMock).toHaveBeenCalledTimes(1);
    expect(verifyTokenMock).toHaveBeenCalledWith(
      "my.jwt.token",
      expect.objectContaining({ secretKey: expect.any(String) }),
    );
  });

  it("accepts 'bearer' lowercase prefix", async () => {
    verifyTokenMock.mockResolvedValueOnce({ sub: "user_lower" });
    expect(await userIdFromHeader("bearer token.value")).toBe("user_lower");
  });

  it("accepts raw token without Bearer prefix", async () => {
    verifyTokenMock.mockResolvedValueOnce({ sub: "user_raw" });
    expect(await userIdFromHeader("raw.token.here")).toBe("user_raw");
  });

  it("returns null when verifyToken throws", async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error("invalid signature"));
    expect(await userIdFromHeader("Bearer bad.token")).toBeNull();
  });

  it("returns null when payload has no sub", async () => {
    verifyTokenMock.mockResolvedValueOnce({});
    expect(await userIdFromHeader("Bearer x.y.z")).toBeNull();
  });
});
