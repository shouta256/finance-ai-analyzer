export const runtime = 'nodejs'; // keep minimal runtime

export async function GET() {
  return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
