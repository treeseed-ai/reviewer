import type { SceneRuntime } from './browser-scene-types.ts';

function messages(value: any): any[] {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.messages) ? value.messages : Array.isArray(value?.Messages) ? value.Messages : [];
}

function recipients(message: any) {
  const values = message?.To ?? message?.to ?? message?.Recipients ?? [];
  return (Array.isArray(values) ? values : [values]).flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    return [entry?.Address, entry?.address, entry?.Email, entry?.email].filter((value): value is string => typeof value === 'string');
  });
}

function body(message: any) {
  return [message?.HTML, message?.Html, message?.html, message?.Text, message?.text, message?.Body, message?.body]
    .filter((entry) => typeof entry === 'string').join('\n');
}

function links(value: string) {
  const decoded = value.replaceAll('&amp;', '&');
  return [...decoded.matchAll(/https?:\/\/[^\s"'<>]+/giu)].map((match) => match[0]!.replace(/[),.;]+$/u, ''));
}

async function latest(runtime: SceneRuntime, email: string, subject?: string) {
  const origin = runtime.mailpitOrigin.replace(/\/+$/u, '');
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch(`${origin}/api/v1/messages`);
    if (!response.ok) throw new Error(`Mailpit message list returned HTTP ${response.status}.`);
    const found = messages(await response.json()).find((message) => recipients(message).some((entry) => entry.toLowerCase() === email.toLowerCase())
      && (!subject || String(message?.Subject ?? message?.subject ?? '').toLowerCase().includes(subject.toLowerCase())));
    if (found) {
      const id = found.ID ?? found.Id ?? found.id;
      const detail = await fetch(`${origin}/api/v1/message/${encodeURIComponent(String(id))}`);
      if (!detail.ok) throw new Error(`Mailpit message returned HTTP ${detail.status}.`);
      return await detail.json();
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`No Mailpit message arrived for ${email}.`);
}

export async function confirmLatest(runtime: SceneRuntime, raw: any) {
  const email = String(raw.email ?? '');
  const message = await latest(runtime, email, raw.subjectIncludes ? String(raw.subjectIncludes) : undefined);
  const link = links(body(message)).find((value) => /confirm|reset|invite/iu.test(value)) ?? links(body(message))[0];
  if (!link) throw new Error(`No confirmation link was found in the Mailpit message for ${email}.`);
  if (raw.navigate === false) return;
  const target = new URL(link);
  const configured = new URL(runtime.adminOrigin);
  target.protocol = configured.protocol; target.host = configured.host;
  await runtime.page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
}
