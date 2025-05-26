terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.0" // Specify minimum Terraform version

  backend "gcs" {
    bucket = "" # Placeholder, will be configured with -backend-config
    prefix = "prod/terraform.tfstate" // Changed to be specific for prod
  }
}
