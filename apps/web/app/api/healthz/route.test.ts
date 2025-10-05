import { describe, it, expect } from 'vitest';
import { GET } from './route';

describe('/api/healthz', () => {
  it("returns 200 and body 'ok'", async () => {
    const res: any = await GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('ok');
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
  });
});
