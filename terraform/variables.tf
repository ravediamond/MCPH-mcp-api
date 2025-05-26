variable "gcp_project_id" {
  description = "The GCP project ID."
  type        = string
}

variable "gcp_region" {
  description = "The GCP region for resources."
  type        = string
  default     = "europe-west1" // Defaulting to what's in deploy.sh
}

variable "artifact_registry_repository_id" {
  description = "The ID of the Artifact Registry repository."
  type        = string
  default     = "mcph"         // Defaulting to what's in deploy.sh
}

variable "cloud_run_service_name" {
  description = "The name of the Cloud Run service."
  type        = string
  default     = "mcph" // Assuming based on IMAGE_NAME, adjust if different
}

variable "terraform_state_bucket_name" {
  description = "The name of the GCS bucket to store Terraform state."
  type        = string
  // This will likely need to be globally unique and set by the user.
  // For now, we'll define it, but the user will need to provide a unique name.
}

variable "cloud_run_image_uri" {
  description = "The URI of the Docker image to deploy to Cloud Run."
  type        = string
  default     = "gcr.io/cloudrun/hello" // Placeholder, will be updated by CI/CD
}

variable "vertexai_embedding_model" {
  description = "Environment variable for VERTEXAI_EMBEDDING_MODEL"
  type        = string
  default     = "textembedding-gecko@001" // Default from your deploy script
}

variable "gcs_bucket_name_env" { // Renamed to avoid conflict with potential GCS bucket resource names
  description = "Environment variable for GCS_BUCKET_NAME"
  type        = string
  default     = "your-gcs-bucket-name" // Needs to be set, placeholder
}

variable "gcs_default_bucket_location_env" { // Renamed
  description = "Environment variable for GCS_DEFAULT_BUCKET_LOCATION"
  type        = string
  default     = "US" // Needs to be set, placeholder
}
