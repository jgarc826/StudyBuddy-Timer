# The HTTP API (API Gateway v2) — the public front door for the Lambda.
# "HTTP API" is the newer, simpler, cheaper API Gateway type; the older
# "REST API" type has more knobs we don't need.

resource "aws_apigatewayv2_api" "api" {
  name          = "studybuddy-timer-api"
  protocol_type = "HTTP"

  # CORS: browsers refuse cross-origin requests unless the API opts in.
  # Our page (served from CloudFront) calls this API (a different domain),
  # so the API must name the origins it trusts. The gateway answers the
  # browser's preflight OPTIONS requests itself - the Lambda never sees them.
  cors_configuration {
    allow_origins = [
      "https://${aws_cloudfront_distribution.site.domain_name}", # the deployed site
      "http://localhost:8123",                                   # local development server
    ]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type", "x-user-id"]
    max_age       = 3600 # browsers may cache the preflight answer for an hour
  }
}

# The integration: "requests to this API invoke that Lambda". Payload 2.0
# is the event shape handler.mjs expects.
resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

# Only these two routes exist; anything else dies at the gateway.
resource "aws_apigatewayv2_route" "post_sessions" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "POST /sessions"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "get_sessions" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "GET /sessions"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# The stage: the deployed, callable instance of the API. Throttling here
# is the project's credit protector (hard rule: conservative limits so a
# bug or a stranger can't burn credits): max 5 requests/second sustained,
# short bursts to 10. The real client sends a handful of requests per
# study session — these limits are ~100x normal use, yet cap a runaway
# loop at harmless cost.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default" # serves at the API's root URL, no path prefix
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 5  # requests per second, steady state
    throttling_burst_limit = 10 # brief spikes allowed above the rate
  }
}

# Lambda's own guard: only THIS API may invoke the function. (The role in
# lambda.tf is what the code may do; this is who may call the code.)
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

output "api_base_url" {
  description = "Base URL of the sessions API"
  value       = aws_apigatewayv2_api.api.api_endpoint
}
