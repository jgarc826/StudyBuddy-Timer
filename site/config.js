'use strict';
/*
  Deployment settings, loaded before every other script. Nothing here is
  secret: this URL is exactly where every visitor's browser sends its
  requests anyway. (Terraform prints it after `apply` as `api_base_url` —
  if the API is ever rebuilt, update it here and redeploy the site.)
*/
const STUDYBUDDY_CONFIG = {
  apiBaseUrl: 'https://mm725try13.execute-api.us-east-1.amazonaws.com',
};
