import { Storage, StorageOptions } from "@google-cloud/storage";
import * as dotenv from "dotenv";

// Load environment variables at the beginning
dotenv.config({ path: ".env.local" });

// Initialize Google Cloud Storage client
let storage: Storage;

try {
  const projectIdFromEnv = process.env.GCP_PROJECT_ID;
  const storageOptions: StorageOptions = {};
  if (projectIdFromEnv) {
    storageOptions.projectId = projectIdFromEnv;
    console.log(`Using GCP_PROJECT_ID from env: ${projectIdFromEnv}`);
  }
  // The SDK will use GOOGLE_APPLICATION_CREDENTIALS if set, otherwise ADC (Cloud Run, gcloud, etc)
  storage = new Storage(storageOptions);
  console.log(
    `Initialized Google Cloud Storage client. Project ID: ${storage.projectId || "inferred"}.`
  );
} catch (error) {
  console.error("Fatal error initializing Google Cloud Storage:", error);
  throw new Error(
    "Failed to initialize storage service. Application may not function correctly."
  );
}

// Get GCS bucket name from environment variables
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
if (!BUCKET_NAME) {
  console.error(
    "GCS_BUCKET_NAME environment variable is not set! This is required.",
  );
  throw new Error("GCS_BUCKET_NAME environment variable is not set!");
}
console.log(`Using GCS Bucket: ${BUCKET_NAME}`);

// Base folder for uploaded files
const UPLOADS_FOLDER = "uploads/";

// Get the bucket
export const bucket = storage.bucket(BUCKET_NAME);
export const uploadsFolder = UPLOADS_FOLDER;
