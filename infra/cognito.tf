# Amazon Cognito: AWS's managed user database. It stores users and their
# (hashed) passwords, sends verification emails, and issues signed identity
# tokens (JWTs) after sign-in. We never see or store a password — the
# browser talks to Cognito directly, and our API only ever sees tokens.

resource "aws_cognito_user_pool" "users" {
  name = "studybuddy-timer-users"

  # The LITE tier: Cognito's classic feature set with the most generous
  # free allowance (tens of thousands of monthly users). The fancier
  # tiers add features we don't use and per-user pricing we don't want
  # on a fixed-credit account (hard rules 1 and 3).
  user_pool_tier = "LITE"

  # People sign in with their EMAIL, not a separate username, and the
  # email must be verified (Cognito mails a 6-digit code on sign-up).
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email" # "forgot password" goes through email
      priority = 1
    }
  }

  # Verification emails come from Cognito's shared address
  # (no-reply@verificationemail.com), capped at ~50/day — plenty here,
  # and it avoids setting up SES.
}

# The "app client": how OUR web page identifies itself to the pool.
# A browser cannot keep secrets (anyone can View Source), so this client
# deliberately has none — possession of the client id alone lets you
# TRY to sign in, never succeed without a real password.
resource "aws_cognito_user_pool_client" "web" {
  name         = "studybuddy-timer-web"
  user_pool_id = aws_cognito_user_pool.users.id

  generate_secret = false

  # The flows our custom pages use: email+password sign-in, and trading
  # a refresh token for fresh short-lived tokens.
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Short-lived identity, long-lived renewal: the id token expires after
  # an hour, and the refresh token lets the browser renew it silently
  # for 30 days before a full re-login is needed.
  id_token_validity      = 1
  access_token_validity  = 1
  refresh_token_validity = 30
  token_validity_units {
    id_token      = "hours"
    access_token  = "hours"
    refresh_token = "days"
  }

  # Answer "wrong email or password" identically whether or not the
  # account exists — otherwise sign-in becomes an email-enumeration tool.
  prevent_user_existence_errors = "ENABLED"
}

output "cognito_user_pool_id" {
  description = "Goes into the API's JWT authorizer issuer URL"
  value       = aws_cognito_user_pool.users.id
}

output "cognito_client_id" {
  description = "Paste into site/config.js — the browser needs it to talk to Cognito"
  value       = aws_cognito_user_pool_client.web.id
}
