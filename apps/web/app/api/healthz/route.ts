import { NextResponse } from 'next/server';

export const runtime = 'nodejs'; // ensure fast, simple route

export async function GET() {
  return NextResponse.json({ ok: true }, { status: 200 });
}
