import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  const token = cookies().get('safepocket_token')?.value;
  if (!token) return NextResponse.json({ error: 'missing token cookie' }, { status: 400 });
  try {
    const [, payloadB64] = token.split('.');
    const json = JSON.parse(Buffer.from(payloadB64.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'));
    const minimal = {
      aud: json.aud,
      iss: json.iss,
      exp: json.exp,
      iat: json.iat,
      token_use: json.token_use,
      scope: json.scope,
      client_id: json.client_id
    };
    return NextResponse.json({ claims: minimal });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
