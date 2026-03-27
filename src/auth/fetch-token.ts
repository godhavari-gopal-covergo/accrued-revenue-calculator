/**
 * Fetches a fresh API access token via token_2 GraphQL mutation.
 * Lives under src/auth/ only — not imported by extract-policy or calculate-earned-premium.
 *
 * Usage (repository root AccruedRevenue/):
 *   npm run fetch-token
 *
 * Loads auth/credentials.env if present (see credentials.example.env).
 */

import * as fs from 'fs';
import * as path from 'path';

const AUTH_DIR = __dirname;

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf-8');
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function main(): Promise<void> {
  loadEnvFile(path.join(AUTH_DIR, 'credentials.env'));

  const endpoint = process.env.COVERGO_GRAPHQL_ENDPOINT ?? 'https://api.uat.ca.covergo.cloud/graphql';
  const authBearer = process.env.COVERGO_AUTH_BEARER ?? '';
  const tenantId = process.env.COVERGO_TENANT_ID ?? 'gms';
  const clientId = process.env.COVERGO_CLIENT_ID ?? 'admin_portal';
  const username = process.env.COVERGO_USERNAME ?? '';
  const password = process.env.COVERGO_PASSWORD ?? '';
  const outFile = process.env.COVERGO_TOKEN_OUTPUT ?? path.join(AUTH_DIR, 'current-token.txt');

  if (!username || !password) {
    console.error('Missing COVERGO_USERNAME or COVERGO_PASSWORD.');
    process.exit(1);
  }
  if (!authBearer.trim()) {
    console.warn('COVERGO_AUTH_BEARER is empty — trying token request without Authorization header.');
  }

  const queryPath = path.join(AUTH_DIR, 'token-query.graphql');
  const query = fs.readFileSync(queryPath, 'utf-8');

  const body = {
    query,
    variables: { tenantId, clientId, username, password },
  };

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    origin: 'https://gms-admin.uat.ca.covergo.cloud',
    referer: 'https://gms-admin.uat.ca.covergo.cloud/',
  };
  if (authBearer.trim()) headers.authorization = `Bearer ${authBearer.trim()}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error(`Non-JSON response (${res.status}):`, raw.slice(0, 500));
    process.exit(1);
  }

  if (json.errors?.length) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }

  const tok = json.data?.token;
  if (!tok?.accessToken) {
    console.error('No accessToken in response:', JSON.stringify(json, null, 2));
    process.exit(1);
  }
  if (tok.error) {
    console.error('Token mutation error:', tok.error, tok.errorDescription ?? '');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, tok.accessToken + '\n', 'utf-8');
  fs.chmodSync(outFile, 0o600);

  console.log('Wrote access token to:', path.relative(process.cwd(), outFile));
  console.log('expiresIn (seconds):', tok.expiresIn ?? '(not returned)');
  console.log('\nUse for Stage 1, e.g.:');
  console.log(`  export COVERGO_BEARER_TOKEN="$(cat ${path.relative(process.cwd(), outFile)})"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
