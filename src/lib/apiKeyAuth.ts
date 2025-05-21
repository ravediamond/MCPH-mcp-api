import { findUserByApiKey } from "../services/firebaseService.ts";
import { Request, Response, NextFunction } from "express";

/**
 * Checks for an API key in the Authorization header (Bearer <key>), validates it, and returns the user record if valid, otherwise throws.
 */
export async function requireApiKeyAuth(req: Request) {
  // Try standard Authorization header first, then fall back to x-authorization
  const authHeader = req.get("Authorization") || req.get("x-authorization");

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

/**
 * Express middleware for API key authentication
 */
export function apiKeyAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  requireApiKeyAuth(req)
    .then(user => {
      // Attach user to request for later use
      (req as any).user = user;
      next();
    })
    .catch(err => {
      res.status((err as any).status || 500).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: err.message || "Authentication error"
        },
        id: null
      });
    });
}
