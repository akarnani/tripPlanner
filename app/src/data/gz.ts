/**
 * Several static-file servers — Vite's dev server (sirv), GitHub
 * Pages, and a few CDNs — set `Content-Encoding: gzip` on `.gz` URLs.
 * The browser then transparently decompresses the body before
 * userland code sees it, so by the time we get the ArrayBuffer the
 * gzip wrapper may or may not still be there. Detect the gzip magic
 * (1f 8b) and only run DecompressionStream when it's actually a gzip
 * stream — otherwise the body is already plaintext and we'd error.
 */
export async function maybeGunzip(input: ArrayBuffer): Promise<ArrayBuffer> {
  if (input.byteLength < 2) return input;
  const head = new Uint8Array(input, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return input;
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([input]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}
