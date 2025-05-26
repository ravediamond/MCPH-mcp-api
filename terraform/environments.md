# Terraform Environments and Workspaces

This Terraform setup is designed to manage cloud resources for different environments. Currently, it's focused on the **production (`prod`)** environment.

## Workspaces

We use Terraform workspaces to isolate environments. The primary workspace is `prod`.

To initialize Terraform and select the `prod` workspace:
```bash
terraform init
terraform workspace select prod || terraform workspace new prod
```

## Variables

Global variables are defined in `variables.tf`.
Sensitive variables or environment-specific overrides (like `gcp_project_id` or `terraform_state_bucket_name`) should be provided through:

1.  A `prod.tfvars` file (for production). This file should be added to `.gitignore`.
    Example `prod.tfvars`:
    ```tfvars
    gcp_project_id                = "your-gcp-project-id"
    terraform_state_bucket_name   = "your-unique-bucket-name-for-tfstate"
    cloud_run_service_name        = "mcph-prod"
    artifact_registry_repository_id = "mcph-prod"
    gcs_bucket_name_env           = "your-prod-gcs-bucket-for-app"
    // etc.
    ```
2.  Environment variables (especially for CI/CD).

## Local Development

The development environment is intended to be run locally and is not managed by this Terraform configuration.
```
