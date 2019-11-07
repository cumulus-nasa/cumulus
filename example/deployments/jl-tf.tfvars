prefix            = "jl-tf"
system_bucket     = "jl-test-integration-internal"
buckets = {
  internal = {
    name = "jl-test-integration-internal"
    type = "internal"
  }
  private = {
    name = "jl-test-integration-private"
    type = "private"
  },
  protected = {
    name = "jl-test-integration-protected"
    type = "protected"
  },
  protected-2 = {
    name = "jl-test-integration-protected-2"
    type = "protected"
  },
  public = {
    name = "jl-test-integration-public"
    type = "public"
  }
}
cmr_oauth_provider = "launchpad"
oauth_provider   = "launchpad"

saml_entity_id                  = "https://cumulus-sandbox.earthdata.nasa.gov/jl-test-integration"
saml_assertion_consumer_service = "https://5hlnofihz8.execute-api.us-east-1.amazonaws.com:8000/dev/saml/auth"
saml_idp_login                  = "https://auth.launchpad-sbx.nasa.gov/affwebservices/public/saml2sso"
saml_launchpad_metadata_path    = "s3://jl-test-integration-internal/jl-tf/launchpad/launchpad-sbx-metadata.xml"

archive_api_port = 8000
