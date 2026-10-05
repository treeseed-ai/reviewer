import { randomUUID } from 'node:crypto';
import { latestMailpitLink } from './browser-scene-mailpit.ts';
import type { SceneRuntime } from './browser-scene-types.ts';

const visualMember = {
  email: 'visual.member@treeseed.io',
  username: 'visual-member',
  password: 'TreeSeedVisualAudit!2026',
};

export function assertLocalFixtureOrigin(value: string, label: string) {
  const url = new URL(value);
  const localHost = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
    || url.hostname.endsWith('.localhost')
    || ['api', 'admin', 'mailpit'].includes(url.hostname);
  if (!localHost || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must resolve to a local development origin before Reviewer may create browser fixtures.`);
  }
}

function errorDetail(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const causes: string[] = [error.message];
  let cause = error.cause;
  while (cause) {
    causes.push(cause instanceof Error ? cause.message : String(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return causes.filter(Boolean).join(' caused by ');
}

export async function fetchFixtureRequest(
  input: URL,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
) {
  try {
    return await fetcher(input, init);
  } catch (error) {
    const method = init.method ?? 'GET';
    throw new Error(`Browser fixture ${method} ${input.origin}${input.pathname} failed: ${errorDetail(error)}`, { cause: error });
  }
}

async function post(runtime: SceneRuntime, path: string, body: Record<string, unknown>) {
  const url = new URL(path, runtime.apiOrigin);
  return fetchFixtureRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  });
}

function tokenFrom(link: string | null) {
  if (!link) throw new Error('Fixture credential message did not contain a token link.');
  const token = new URL(link).searchParams.get('token');
  if (!token) throw new Error('Fixture credential link did not contain a token.');
  return token;
}

export async function ensureVisualMemberFixture(runtime: SceneRuntime) {
  assertLocalFixtureOrigin(runtime.apiOrigin, 'API origin');
  assertLocalFixtureOrigin(runtime.adminOrigin, 'Admin origin');
  assertLocalFixtureOrigin(runtime.mailpitOrigin, 'Mailpit origin');
  const registrationStarted = Date.now() - 1_000;
  const registration = await post(runtime, '/v1/auth/web/sign-up', {
    email: visualMember.email,
    username: visualMember.username,
    password: visualMember.password,
    displayName: 'Visual Member',
    firstName: 'Visual',
    lastName: 'Member',
    returnTo: '/app/',
  });
  if (registration.ok) {
    const link = await latestMailpitLink(runtime, visualMember.email, 'Confirm your TreeSeed email', registrationStarted);
    const confirmation = await post(runtime, '/v1/auth/web/confirm-email', { token: tokenFrom(link) });
    if (!confirmation.ok) throw new Error(`Visual member confirmation returned HTTP ${confirmation.status}.`);
  } else if (registration.status !== 409) {
    throw new Error(`Visual member registration returned HTTP ${registration.status}.`);
  }

  const resetStarted = Date.now() - 1_000;
  const requested = await post(runtime, '/v1/auth/web/password-reset/request', { email: visualMember.email });
  if (!requested.ok) throw new Error(`Visual member password reset request returned HTTP ${requested.status}.`);
  const resetLink = await latestMailpitLink(runtime, visualMember.email, 'Reset your TreeSeed password', resetStarted);
  const reset = await post(runtime, '/v1/auth/web/password-reset/complete', { token: tokenFrom(resetLink), newPassword: visualMember.password });
  if (!reset.ok) throw new Error(`Visual member password reset returned HTTP ${reset.status}.`);
}
