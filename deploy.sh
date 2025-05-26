#!/bin/bash

# This script builds a Docker image, pushes it to Google Artifact Registry,
# and deploys it to an existing Google Cloud Run service.
# It assumes the Artifact Registry repository and Cloud Run service are already created and configured.

# Variables:
# These should be set in your environment or passed as arguments.
# GCP_PROJECT_ID: Your Google Cloud Project ID.
# REGION: The GCP region for Cloud Run and Artifact Registry (e.g., europe-west1).
# ARTIFACT_REGISTRY_REPO: The name of your Artifact Registry repository.
# IMAGE_NAME: The name of your Docker image.
# RUN_SERVICE_NAME: The name of your Cloud Run service.

# Example usage:
# GCP_PROJECT_ID="my-project" REGION="us-central1" ARTIFACT_REGISTRY_REPO="my-repo" IMAGE_NAME="my-app" RUN_SERVICE_NAME="my-app-service" ./deploy.sh

set -e # Exit immediately if a command exits with a non-zero status.

# --- Configuration - Ensure these variables are set ---
if [ -z "$GCP_PROJECT_ID" ]; then echo "Error: GCP_PROJECT_ID is not set." >&2; exit 1; fi
if [ -z "$REGION" ]; then echo "Error: REGION is not set." >&2; exit 1; fi
if [ -z "$ARTIFACT_REGISTRY_REPO" ]; then echo "Error: ARTIFACT_REGISTRY_REPO is not set." >&2; exit 1; fi
if [ -z "$IMAGE_NAME" ]; then echo "Error: IMAGE_NAME is not set." >&2; exit 1; fi
if [ -z "$RUN_SERVICE_NAME" ]; then echo "Error: RUN_SERVICE_NAME is not set." >&2; exit 1; fi

# Construct the full image path
IMAGE_PATH="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPO}/${IMAGE_NAME}:latest"
ARTIFACT_REGISTRY_DOMAIN="${REGION}-docker.pkg.dev"

# --- Script Logic ---

echo "Authenticating Docker to Artifact Registry: ${ARTIFACT_REGISTRY_DOMAIN}..."
gcloud auth configure-docker ${ARTIFACT_REGISTRY_DOMAIN} --quiet

echo "Building Docker image: ${IMAGE_PATH}..."
docker build -t "${IMAGE_PATH}" .

echo "Pushing image to Artifact Registry: ${IMAGE_PATH}..."
docker push "${IMAGE_PATH}"

echo "Deploying image to Cloud Run service: ${RUN_SERVICE_NAME} in project ${GCP_PROJECT_ID}, region ${REGION}..."
gcloud run deploy "${RUN_SERVICE_NAME}"   --image "${IMAGE_PATH}"   --region "${REGION}"   --project "${GCP_PROJECT_ID}"   --platform managed   --quiet

echo ""
echo "Deployment of new image to Cloud Run service '${RUN_SERVICE_NAME}' finished."
echo "Service URL: $(gcloud run services describe ${RUN_SERVICE_NAME} --platform managed --region ${REGION} --project ${GCP_PROJECT_ID} --format 'value(status.url)')"
echo "You can view logs at: https://console.cloud.google.com/run/detail/${REGION}/${RUN_SERVICE_NAME}/logs?project=${GCP_PROJECT_ID}"
