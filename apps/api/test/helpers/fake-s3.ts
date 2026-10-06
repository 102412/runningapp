import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeS3 {
  endpoint: string;
  objects: Map<string, { body: Buffer; contentType: string | undefined }>;
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
  close(): Promise<void>;
}

/**
 * A minimal path-style S3 endpoint (PUT/GET/HEAD/DELETE object + multi-delete) for exercising the
 * S3 driver's request wiring. It does NOT verify AWS signatures; that needs a real S3/MinIO.
 */
export async function startFakeS3(bucket: string): Promise<FakeS3> {
  const objects: FakeS3['objects'] = new Map();
  const requests: FakeS3['requests'] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const prefix = `/${bucket}/`;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && url.searchParams.has('delete')) {
        for (const m of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g))
          objects.delete(m[1] ?? '');
        res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end('<DeleteResult></DeleteResult>');
        return;
      }
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      switch (req.method) {
        case 'PUT':
          objects.set(key, { body, contentType: req.headers['content-type'] });
          res.writeHead(200, { etag: '"fake"' }).end();
          return;
        case 'GET':
        case 'HEAD': {
          const obj = objects.get(key);
          if (!obj) {
            res
              .writeHead(404, { 'content-type': 'application/xml' })
              .end('<Error><Code>NoSuchKey</Code></Error>');
            return;
          }
          res.writeHead(200, {
            'content-length': String(obj.body.length),
            ...(obj.contentType ? { 'content-type': obj.contentType } : {}),
          });
          res.end(req.method === 'GET' ? obj.body : undefined);
          return;
        }
        case 'DELETE':
          objects.delete(key);
          res.writeHead(204).end();
          return;
        default:
          res.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
