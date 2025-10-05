import { describe, it, expect } from 'vitest';
import { GET } from './route';

// Minimal shim for NextResponse.json return shape used in GET

describe('/api/healthz', () => {
  it('returns 200 and ok:true', async () => {
    const res: any = await GET();
    // NextResponse.json returns a NextResponse-like object; we check status and body
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
