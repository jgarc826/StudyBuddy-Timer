# Operations: know when the backend breaks WITHOUT watching a dashboard
# all day — the alarm emails; the dashboard is for looking things up.

# SNS ("simple notification service"): a topic is a broadcast channel —
# something publishes a message, every subscriber receives it. Here:
# CloudWatch publishes alarm state changes, an email address subscribes.
resource "aws_sns_topic" "alerts" {
  name = "studybuddy-timer-alerts"
}

# NOTE: email subscriptions start as "pending confirmation" — AWS mails a
# link that must be clicked once. Terraform cannot click it for you.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alerts_email
}

# The alarm: any Lambda error within a 5-minute window -> email. "Errors"
# counts invocations that threw/crashed — our handler catches everything
# and returns a 500 instead, so this firing means something truly
# unexpected (bad deploy, runtime failure), which is exactly when a
# human should look.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name        = "studybuddy-timer-lambda-errors"
  alarm_description = "The StudyBuddy API Lambda reported an error"

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions = {
    FunctionName = aws_lambda_function.api.function_name
  }

  statistic           = "Sum"
  period              = 300 # seconds: look at 5-minute buckets
  evaluation_periods  = 1   # one bad bucket is enough
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # No traffic means no data — that's healthy silence, not an alarm.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn] # email on entering ALARM
  ok_actions    = [aws_sns_topic.alerts.arn] # and again on recovery
}

# The dashboard: one page in the CloudWatch console with the four graphs
# that matter. The body is JSON; jsonencode() writes it from HCL so it
# stays readable and diffable here.
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "studybuddy-timer"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6,
        properties = {
          title  = "Lambda: invocations and errors"
          region = "us-east-1", view = "timeSeries", period = 300, stat = "Sum"
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.api.function_name],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.api.function_name, { color = "#d62728" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6,
        properties = {
          title  = "Lambda: duration (ms)"
          region = "us-east-1", view = "timeSeries", period = 300
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.api.function_name, { stat = "Average" }],
            ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.api.function_name, { stat = "p95", label = "p95" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6,
        properties = {
          title  = "API: requests"
          region = "us-east-1", view = "timeSeries", period = 300, stat = "Sum"
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", aws_apigatewayv2_api.api.id],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6,
        properties = {
          title  = "API: client (4xx) and server (5xx) errors"
          region = "us-east-1", view = "timeSeries", period = 300, stat = "Sum"
          metrics = [
            ["AWS/ApiGateway", "4xx", "ApiId", aws_apigatewayv2_api.api.id],
            ["AWS/ApiGateway", "5xx", "ApiId", aws_apigatewayv2_api.api.id, { color = "#d62728" }],
          ]
        }
      },
    ]
  })
}
