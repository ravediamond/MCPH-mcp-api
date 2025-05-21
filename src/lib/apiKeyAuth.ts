import { findUserByApiKey } from "../services/firebaseService";
import { Request } from "express";

/**
 * Checks for an API key in the Authorization header (Bearer <key>), validates it, and returns the user record if valid, otherwise throws.
 */
export async function requireApiKeyAuth(req: Request) {
  const authHeader = req.get("x-authorization");

  if (!authHeader || !authHeader.trim() || !authHeader.startsWith("Bearer ")) {
    console.log("[requireApiKeyAuth] Missing or invalid Authorization header");
    const err = new Error("Missing or invalid API key");
    // Attach status for Express error handling
    (err as any).status = 401;
    throw err;
  }
  const apiKey = authHeader.replace("Bearer ", "").trim();
  const apiKeyRecord = await findUserByApiKey(apiKey);
  if (!apiKeyRecord) {
    console.log("[requireApiKeyAuth] API key not found in database");
    const err = new Error("Invalid API key");
    (err as any).status = 401;
    throw err;
  }
  return apiKeyRecord;
}
