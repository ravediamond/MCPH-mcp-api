provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

resource "google_storage_bucket" "terraform_state" {
  name          = var.terraform_state_bucket_name
  location      = var.gcp_region // Or a multi-region like "US" or "EU"
  storage_class = "STANDARD"
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = null // Or specify a KMS key
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 7 // Keep noncurrent versions for 7 days
      num_newer_versions         = 3 // Keep last 3 noncurrent versions
    }
  }
}

resource "google_artifact_registry_repository" "repository" {
  provider      = google-beta // Artifact Registry often requires the beta provider
  project       = var.gcp_project_id
  location      = var.gcp_region
  repository_id = var.artifact_registry_repository_id
  description   = "Docker repository for application images"
  format        = "DOCKER"
}

resource "google_cloud_run_v2_service" "default" {
  provider = google-beta // Cloud Run V2 resources often benefit from google-beta
  name     = var.cloud_run_service_name
  location = var.gcp_region
  project  = var.gcp_project_id

  template {
    containers {
      image = var.cloud_run_image_uri
      ports {
        container_port = 8080 // Assuming your app listens on 8080, adjust if not
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.gcp_project_id
      }
      env {
        name  = "REGION"
        value = var.gcp_region
      }
      env {
        name  = "VERTEXAI_EMBEDDING_MODEL"
        value = var.vertexai_embedding_model
      }
      env {
        name  = "GCS_BUCKET_NAME"
        value = var.gcs_bucket_name_env
      }
      env {
        name  = "GCS_DEFAULT_BUCKET_LOCATION"
        value = var.gcs_default_bucket_location_env
      }
      // Add other necessary environment variables here
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

resource "google_cloud_run_v2_service_iam_member" "allow_unauthenticated_invocations" {
  provider = google-beta
  project  = google_cloud_run_v2_service.default.project
  location = google_cloud_run_v2_service.default.location
  name     = google_cloud_run_v2_service.default.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
