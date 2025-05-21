import fs from "fs";
import path from "path";
import os from "os";

import {
  initializeApp,
  getApps,
  getApp,
} from "firebase-admin/app";
import { getFirestore, Firestore, FieldValue } from "firebase-admin/firestore";

let firebaseApp;
let db: Firestore;
let settingsApplied = false;

if (!getApps().length) {
  try {
    firebaseApp = initializeApp({}); // Use ADC
    console.log("Firebase Admin SDK initialized using ADC.");
  } catch (error: any) {
    console.error("Error initializing Firebase Admin SDK:", error.message);
    throw new Error("Failed to initialize Firebase Admin SDK using ADC.");
  }
} else {
  firebaseApp = getApp();
  console.log("Firebase Admin SDK already initialized. Using existing app.");
}

db = getFirestore(firebaseApp);

if (!settingsApplied) {
  try {
    db.settings({ ignoreUndefinedProperties: true });
    settingsApplied = true;
    console.log("Firestore settings applied successfully.");
  } catch (error) {
    console.warn("Could not apply Firestore settings, they may have already been configured:", error);
  }
}

import { v4 as uuidv4 } from "uuid";

// --- Firebase Admin SDK Initialization ---
if (!getApps().length) {
  try {
    console.log(
      "Firebase Admin SDK initialized successfully using Application Default Credentials.",
    );
  } catch (error: any) {
    console.error(
      "Error initializing Firebase Admin SDK with Application Default Credentials:",
      error.message,
    );
    let detailedError =
      "Failed to initialize Firebase Admin SDK using Application Default Credentials. ";
    if (
      error.message.includes("Could not load the default credentials") ||
      error.message.includes("Unable to detect a Project Id") ||
      error.message.includes("getDefaultCredential")
    ) {
      detailedError +=
        "The service account must have the necessary Firebase permissions (e.g., Firestore Admin). ";
      detailedError +=
        "If running in a Google Cloud environment, ensure the runtime service account has these permissions. ";
    } else {
      detailedError += `An unexpected error occurred: ${error.message}. `;
    }
    console.error(detailedError);
    throw new Error(detailedError);
  }
} else {
  firebaseApp = getApp(); // Use the already initialized app
  console.log("Firebase Admin SDK already initialized. Using existing app.");
}

// Initialize Firestore
db = getFirestore(firebaseApp);

// Apply settings only once to avoid the "Firestore has already been initialized" error
if (!settingsApplied) {
  try {
    // Enable Firestore timestamp snapshots
    db.settings({ ignoreUndefinedProperties: true });
    settingsApplied = true;
    console.log("Firestore settings applied successfully.");
  } catch (error) {
    // If settings have already been applied, this is not a critical error
    console.warn(
      "Could not apply Firestore settings, they may have already been configured:",
      error,
    );
  }
}

// --- End Firebase Admin SDK Initialization ---

// Collection names for Firestore
const FILES_COLLECTION = "files";
const METRICS_COLLECTION = "metrics";
const EVENTS_COLLECTION = "events";

// Export collection names for use in other modules
export { FILES_COLLECTION, METRICS_COLLECTION, EVENTS_COLLECTION, db };

// File metadata type
export interface FileMetadata {
  id: string;
  fileName: string;
  title: string; // Added title field (mandatory)
  description?: string; // Added description field (optional)
  contentType: string;
  size: number;
  gcsPath: string;
  uploadedAt: Date; // Note: In Firestore we store as Date objects
  expiresAt?: Date; // In Firestore we store as Date objects
  downloadCount: number;
  ipAddress?: string;
  userId?: string;
  metadata?: Record<string, string>;
  isShared?: boolean; // New: whether the file is shared (default false)
  password?: string; // New: optional hashed password for download
  fileType?: string; // Optional: type of artifact (generic, data, image, etc.)
}

/**
 * Convert Firebase timestamp to Date and vice versa
 */
const toFirestoreData = (data: any): any => {
  // Deep copy the object and handle Date conversion
  const result = { ...data };

  // Convert Date objects to Firestore timestamps
  Object.keys(result).forEach((key) => {
    if (result[key] instanceof Date) {
      // We'll keep it as a Date; Firestore will convert it automatically
    } else if (typeof result[key] === "object" && result[key] !== null) {
      result[key] = toFirestoreData(result[key]);
    }
  });

  return result;
};

const fromFirestoreData = (data: any): any => {
  if (!data) return null;

  // Convert Firestore timestamps to Date objects
  const result = { ...data };

  // Convert Firestore timestamps back to Date objects
  Object.keys(result).forEach((key) => {
    if (result[key] && typeof result[key].toDate === "function") {
      result[key] = result[key].toDate();
    } else if (typeof result[key] === "object" && result[key] !== null) {
      result[key] = fromFirestoreData(result[key]);
    }
  });

  return result;
};

/**
 * Save file metadata to Firestore, with embedding and searchText support
 */
export async function saveFileMetadata(
  fileData: FileMetadata & { embedding?: number[] },
): Promise<boolean> {
  try {
    // --- Generate searchText field ---
    const metaString = fileData.metadata
      ? Object.entries(fileData.metadata)
        .map(([k, v]) => `${k} ${v}`)
        .join(" ")
      : "";
    const searchText = [fileData.title, fileData.fileName, fileData.description, metaString]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    // Convert the data for Firestore
    const dataToSave = toFirestoreData({
      ...fileData,
      ...(fileData.embedding ? { embedding: fileData.embedding } : {}),
      searchText,
    });
    await db.collection(FILES_COLLECTION).doc(fileData.id).set(dataToSave);
    return true;
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error("Error saving file metadata to Firestore:", errMsg);
    return false;
  }
}

/**
 * Get file metadata from Firestore
 */
export async function getFileMetadata(
  fileId: string,
): Promise<FileMetadata | null> {
  try {
    const docRef = db.collection(FILES_COLLECTION).doc(fileId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return null;
    }

    const data = doc.data();

    // Convert Firestore timestamps back to Date objects
    return fromFirestoreData(data) as FileMetadata;
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error("Error getting file metadata from Firestore:", errMsg);
    return null;
  }
}

/**
 * Increment download count for a file in Firestore
 */
export async function incrementDownloadCount(fileId: string): Promise<number> {
  try {
    const docRef = db.collection(FILES_COLLECTION).doc(fileId);
    const doc = await docRef.get();

    if (!doc.exists) {
      console.warn(
        `File metadata not found for ID: ${fileId} when incrementing download count.`,
      );
      return 0;
    }

    // Use FieldValue.increment() for atomic increment operation
    await docRef.update({
      downloadCount: FieldValue.increment(1),
    });

    // Also update general metrics
    await incrementMetric("downloads");

    // Get the updated document to return the new count
    const updatedDoc = await docRef.get();
    const downloadCount = updatedDoc.data()?.downloadCount || 0;

    return downloadCount;
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error("Error incrementing download count in Firestore:", errMsg);

    // Attempt to get current count if update failed
    try {
      const doc = await db.collection(FILES_COLLECTION).doc(fileId).get();
      return doc.data()?.downloadCount || 0;
    } catch (e) {
      return 0;
    }
  }
}

/**
 * Delete file metadata from Firestore
 */
export async function deleteFileMetadata(fileId: string): Promise<boolean> {
  try {
    await db.collection(FILES_COLLECTION).doc(fileId).delete();
    return true;
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error("Error deleting file metadata from Firestore:", errMsg);
    return false;
  }
}

/**
 * Increment a general metric counter
 */
export async function incrementMetric(
  metric: string,
  amount: number = 1,
): Promise<number> {
  try {
    const metricRef = db.collection(METRICS_COLLECTION).doc("counters");

    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split("T")[0];
    const dailyMetricRef = db
      .collection(METRICS_COLLECTION)
      .doc(`daily_${today}`);

    // Use FieldValue.increment for atomic increment
    const updateData: Record<string, any> = {};
    updateData[metric] = FieldValue.increment(amount);

    // Update the total counters
    await metricRef.set(updateData, { merge: true });

    // Also update the timestamp
    await metricRef.update({
      lastUpdated: new Date(),
    });

    // Update daily counters
    await dailyMetricRef.set(updateData, { merge: true });

    // Get updated value
    const updatedDoc = await metricRef.get();
    return updatedDoc.data()?.[metric] || 0;
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error(`Error incrementing metric '${metric}' in Firestore:`, errMsg);
    return 0;
  }
}

/**
 * Get a general metric value
 */
export async function getMetric(metric: string): Promise<number> {
  try {
    const metricRef = db.collection(METRICS_COLLECTION).doc("counters");
    const doc = await metricRef.get();

    if (!doc.exists) {
      return 0;
    }

    return doc.data()?.[metric] || 0;
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error(`Error getting metric '${metric}' from Firestore:`, errMsg);
    return 0;
  }
}

/**
 * Get daily metrics for a specific metric type over a number of days
 */
export async function getDailyMetrics(
  metric: string,
  days: number = 30,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const today = new Date();

  try {
    const promises = [];

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD

      promises.push(
        db
          .collection(METRICS_COLLECTION)
          .doc(`daily_${dateStr}`)
          .get()
          .then((doc) => {
            result[dateStr] = doc.exists ? doc.data()?.[metric] || 0 : 0;
          }),
      );
    }

    await Promise.all(promises);
    return result;
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error(
      `Error getting daily metrics for '${metric}' from Firestore:`,
      errMsg,
    );
    return {};
  }
}

/**
 * Log an event to Firestore
 */
export async function logEvent(
  eventType: string,
  resourceId: string,
  ipAddress?: string,
  details: Record<string, any> = {},
): Promise<void> {
  try {
    const timestamp = new Date();
    const eventId = uuidv4();

    const eventData = {
      id: eventId,
      type: eventType,
      resourceId,
      timestamp,
      ipAddress,
      details,
    };

    // Add to the events collection with auto-generated ID
    await db.collection(EVENTS_COLLECTION).doc(eventId).set(eventData);

    // Create a query for cleanup (to run in a scheduled function)
    // This just increments the event counter; actual cleanup is done separately
    await incrementMetric(`events:${eventType}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error("Error logging event to Firestore:", errMsg);
  }
}

/**
 * Get recent events of a specific type from Firestore
 */
export async function getEvents(
  eventType: string,
  limit: number = 100,
): Promise<any[]> {
  try {
    const querySnapshot = await db
      .collection(EVENTS_COLLECTION)
      .where("type", "==", eventType)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    if (querySnapshot.empty) {
      return [];
    }

    // Convert to array of data
    return querySnapshot.docs.map((doc) => {
      const data = doc.data();
      // Convert any Firestore timestamps to Date objects
      return fromFirestoreData(data);
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error("Error getting events from Firestore:", errMsg);
    return [];
  }
}

/**
 * Get file metadata for a specific user from Firestore
 */
export async function getUserFiles(userId: string): Promise<FileMetadata[]> {
  try {
    const querySnapshot = await db
      .collection(FILES_COLLECTION)
      .where("userId", "==", userId)
      .orderBy("uploadedAt", "desc")
      .get();

    if (querySnapshot.empty) {
      return [];
    }

    // Convert to array of data, converting Firestore timestamps to Date objects
    return querySnapshot.docs.map(
      (doc) => fromFirestoreData(doc.data()) as FileMetadata,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error(
      `Error getting files for user ${userId} from Firestore:`,
      errMsg,
    );
    return []; // Return empty array on error
  }
}

// --- API Keys Collection ---
const API_KEYS_COLLECTION = "apiKeys";

export interface ApiKeyRecord {
  id: string; // Firestore doc ID
  userId: string;
  hashedKey: string; // Store only hashed version
  createdAt: Date;
  lastUsedAt?: Date;
  name?: string; // Optional: user-friendly name
}

import * as crypto from "crypto";

function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export async function createApiKey(
  userId: string,
  name?: string,
): Promise<{ apiKey: string; record: ApiKeyRecord }> {
  const apiKey = crypto.randomBytes(32).toString("hex");
  const hashedKey = hashApiKey(apiKey);
  const id = crypto.randomUUID();
  const record: ApiKeyRecord = {
    id,
    userId,
    hashedKey,
    createdAt: new Date(),
    name,
  };
  await db.collection(API_KEYS_COLLECTION).doc(id).set(toFirestoreData(record));
  return { apiKey, record };
}

export async function listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
  const snapshot = await db
    .collection(API_KEYS_COLLECTION)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .get();
  return snapshot.docs.map(
    (doc) => fromFirestoreData(doc.data()) as ApiKeyRecord,
  );
}

export async function deleteApiKey(
  userId: string,
  keyId: string,
): Promise<boolean> {
  const docRef = db.collection(API_KEYS_COLLECTION).doc(keyId);
  const doc = await docRef.get();
  if (!doc.exists || doc.data()?.userId !== userId) return false;
  await docRef.delete();
  return true;
}

export async function findUserByApiKey(
  apiKey: string,
): Promise<ApiKeyRecord | null> {
  const hashedKey = hashApiKey(apiKey);
  const snapshot = await db
    .collection(API_KEYS_COLLECTION)
    .where("hashedKey", "==", hashedKey)
    .limit(1)
    .get();
  if (snapshot.empty) {
    return null;
  }
  const record = fromFirestoreData(snapshot.docs[0].data()) as ApiKeyRecord;
  // Optionally update lastUsedAt
  await snapshot.docs[0].ref.update({ lastUsedAt: new Date() });
  return record;
}

const API_KEY_USAGE_COLLECTION = "apiKeyUsage";
const API_KEY_TOOL_CALL_LIMIT = 1000;

/**
 * Increment the monthly tool usage for an API key. Returns the new count and remaining quota.
 */
export async function incrementApiKeyToolUsage(
  apiKeyId: string,
): Promise<{ count: number; remaining: number }> {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`; // e.g. 202505
  const docId = `${apiKeyId}_${yearMonth}`;
  const docRef = db.collection(API_KEY_USAGE_COLLECTION).doc(docId);
  const res = await docRef.set(
    {
      apiKeyId,
      yearMonth,
      count: FieldValue.increment(1),
      updatedAt: new Date(),
    },
    { merge: true },
  );
  // Read the updated count
  const doc = await docRef.get();
  const count = doc.data()?.count || 0;
  return { count, remaining: Math.max(0, API_KEY_TOOL_CALL_LIMIT - count) };
}

/**
 * Get the current monthly tool usage for an API key.
 */
export async function getApiKeyToolUsage(
  apiKeyId: string,
): Promise<{ count: number; remaining: number }> {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const docId = `${apiKeyId}_${yearMonth}`;
  const docRef = db.collection(API_KEY_USAGE_COLLECTION).doc(docId);
  const doc = await docRef.get();
  const count = doc.exists ? doc.data()?.count || 0 : 0;
  return { count, remaining: Math.max(0, API_KEY_TOOL_CALL_LIMIT - count) };
}

const USER_USAGE_COLLECTION = "userUsage";
const USER_TOOL_CALL_LIMIT = 1000;

/**
 * Increment the monthly tool usage for a user. Returns the new count and remaining quota.
 */
export async function incrementUserToolUsage(
  userId: string,
): Promise<{ count: number; remaining: number }> {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const docId = `${userId}_${yearMonth}`;
  const docRef = db.collection(USER_USAGE_COLLECTION).doc(docId);
  await docRef.set(
    {
      userId,
      yearMonth,
      count: FieldValue.increment(1),
      updatedAt: new Date(),
    },
    { merge: true },
  );
  const doc = await docRef.get();
  const count = doc.data()?.count || 0;
  return { count, remaining: Math.max(0, USER_TOOL_CALL_LIMIT - count) };
}

/**
 * Get the current monthly tool usage for a user.
 */
export async function getUserToolUsage(
  userId: string,
): Promise<{ count: number; remaining: number }> {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const docId = `${userId}_${yearMonth}`;
  const docRef = db.collection(USER_USAGE_COLLECTION).doc(docId);
  const doc = await docRef.get();
  const count = doc.exists ? doc.data()?.count || 0 : 0;
  return { count, remaining: Math.max(0, USER_TOOL_CALL_LIMIT - count) };
}

/**
 * Get total storage used by a user (sum of all file sizes in bytes)
 */
export async function getUserStorageUsage(
  userId: string,
): Promise<{ used: number; limit: number; remaining: number }> {
  const STORAGE_LIMIT = 500 * 1024 * 1024; // 500MB in bytes
  try {
    const files = await getUserFiles(userId);
    const used = files.reduce((sum, file) => sum + (file.size || 0), 0);
    return {
      used,
      limit: STORAGE_LIMIT,
      remaining: Math.max(0, STORAGE_LIMIT - used),
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error(`Error calculating storage usage for user ${userId}:`, errMsg);
    return { used: 0, limit: STORAGE_LIMIT, remaining: STORAGE_LIMIT };
  }
}

/**
 * Hybrid search for artifacts: vector (embedding) + classical (searchText)
 * @param query The search query string
 * @param topK Number of results to return (default 5)
 * @returns Array of FileMetadata objects
 */
export async function hybridSearchArtifacts(query: string, topK: number = 5): Promise<FileMetadata[]> {
  try {
    // 1. Vector search (if embedding available)
    let vectorArtifacts: FileMetadata[] = [];
    try {
      const { getEmbedding } = await import("../lib/vertexAiEmbedding.ts");
      const embedding = await getEmbedding(query);
      // Firestore vector search (if supported)
      // @ts-ignore
      const vectorQuery = db.collection(FILES_COLLECTION).findNearest?.("embedding", embedding, {
        limit: topK,
        distanceMeasure: "DOT_PRODUCT",
      });
      if (vectorQuery) {
        const vectorSnapshot = await vectorQuery.get();
        vectorArtifacts = vectorSnapshot.docs.map((doc: any) => fromFirestoreData(doc.data()) as FileMetadata);
      }
    } catch (e) {
      // Vector search not available or failed
    }
    // 2. Classical search (searchText prefix, case-insensitive)
    const textQuery = query.toLowerCase();
    const classicalSnapshot = await db
      .collection(FILES_COLLECTION)
      .where("searchText", ">=", textQuery)
      .where("searchText", "<=", textQuery + "\uf8ff")
      .limit(topK)
      .get();
    const classicalArtifacts = classicalSnapshot.docs.map((doc: any) => fromFirestoreData(doc.data()) as FileMetadata);
    // 3. Merge and deduplicate by id
    const allArtifactsMap = new Map<string, FileMetadata>();
    for (const a of vectorArtifacts) allArtifactsMap.set(a.id, a);
    for (const a of classicalArtifacts) allArtifactsMap.set(a.id, a);
    return Array.from(allArtifactsMap.values());
  } catch (err) {
    const errMsg = err instanceof Error ? err.stack || err.message : JSON.stringify(err);
    console.error("Error in hybridSearchArtifacts:", errMsg);
    return [];
  }
}

/**
 * Get all metadata fields for a file as a formatted text string
 */
export async function getFileMetadataAsText(fileId: string): Promise<string | null> {
  const meta = await getFileMetadata(fileId);
  if (!meta) return null;
  return Object.entries(meta)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
}

/**
 * Update sharing status and password for an artifact, and return shareable link
 */
export async function updateArtifactSharing(
  id: string,
  isShared?: boolean,
  password?: string,
): Promise<{ id: string; isShared?: boolean; password: boolean; shareUrl: string } | null> {
  try {
    const fileRef = db.collection(FILES_COLLECTION).doc(id);
    const update: any = {};
    if (typeof isShared === "boolean") update.isShared = isShared;
    if (typeof password === "string") update.password = password;
    await fileRef.update(update);
    const shareUrl = `${process.env.NEXT_PUBLIC_BASE_URL || "https://mcph.io"}/artifact/${id}`;
    return {
      id,
      isShared: update.isShared,
      password: !!update.password,
      shareUrl,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.stack || err.message : JSON.stringify(err);
    console.error("Error updating artifact sharing:", errMsg);
    return null;
  }
}

// Re-export presigned URL helpers from storageService
export { generateUploadUrl, getSignedDownloadUrl } from "./storageService.ts";
