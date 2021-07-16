prefix            = "jl-tf"
system_bucket     = "jl-test-integration-internal"
buckets = {
  glacier = {
    name = "jl-test-integration-orca-glacier"
    type = "glacier"
  },
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

saml_entity_id                  = "https://cumulus-sandbox.earthdata.nasa.gov/jl-tf"
saml_assertion_consumer_service = "https://dz5bdrhmhd.execute-api.us-east-1.amazonaws.com:8000/dev/saml/auth"
saml_idp_login                  = "https://auth.launchpad-sbx.nasa.gov/affwebservices/public/saml2sso"
saml_launchpad_metadata_url     = "https://auth.launchpad-sbx.nasa.gov/unauth/metadata/launchpad-sbx.idp.xml"

archive_api_port = 8000

key_name      = "jl"

include_orca = true
orca_drop_database = "False"

tea_distribution_url = "https://jwhwz6qg4j.execute-api.us-east-1.amazonaws.com:7000/DEV/"
cumulus_distribution_url = "https://yj85g9dak9.execute-api.us-east-1.amazonaws.com:9000/dev/"
