#!/bin/bash

# Load environment variables from .env.local
set -o allexport
source .env.local
set +o allexport

# Set variables from .env.local or use defaults if not set
IMAGE_NAME=${IMAGE_NAME:-mcph}
ARTIFACT_REGISTRY_LOCATION=${ARTIFACT_REGISTRY_LOCATION:-europe-west1}
ARTIFACT_REGISTRY_REPO=${ARTIFACT_REGISTRY_REPO:-mcph}

# Authenticate Docker to Artifact Registry for the specific location
gcloud auth configure-docker ${ARTIFACT_REGISTRY_LOCATION}-docker.pkg.dev

# Define the full image path in Artifact Registry
IMAGE_PATH=${ARTIFACT_REGISTRY_LOCATION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPO}/${IMAGE_NAME}:latest

# Build Docker image
docker build -t $IMAGE_PATH .

# Push image to Artifact Registry
docker push $IMAGE_PATH

# Deploy to Cloud Run
gcloud run deploy $RUN_SERVICE_NAME \
  --image $IMAGE_PATH \
  --region $REGION \
  --project $GCP_PROJECT_ID \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_APPLICATION_CREDENTIALS=service-account-credentials.json,GCP_PROJECT_ID=${GCP_PROJECT_ID},REGION=${REGION},VERTEXAI_EMBEDDING_MODEL=${VERTEXAI_EMBEDDING_MODEL},GCS_BUCKET_NAME=${GCS_BUCKET_NAME},GCS_DEFAULT_BUCKET_LOCATION=${GCS_DEFAULT_BUCKET_LOCATION}"

echo "Deployment attempt finished. Check the Google Cloud Console for status and logs."
echo "Cloud Run service logs for project $GCP_PROJECT_ID, service $RUN_SERVICE_NAME, region $REGION:"
echo "https://console.cloud.google.com/run/detail/${REGION}/${RUN_SERVICE_NAME}/logs?project=${GCP_PROJECT_IDR}"