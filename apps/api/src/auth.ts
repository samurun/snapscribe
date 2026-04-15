import { createClerkClient, verifyToken } from "@clerk/backend";
import { Elysia } from "elysia";
import { env } from "./env";

export const clerk = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
});

export async function userIdFromHeader(
  authHeader: string | null | undefined,
): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export const requireAuth = new Elysia({ name: "require-auth" }).derive(
  { as: "scoped" },
  async ({ request, set }) => {
    const userId = await userIdFromHeader(request.headers.get("authorization"));
    if (!userId) {
      set.status = 401;
      throw new Error("unauthorized");
    }
    return { userId };
  },
);
