interface Env {
  BUCKET: R2Bucket;
  AUTH_TOKEN: string;
}

const getCorsHeaders = (): [string, string][] => [
  ['Access-Control-Allow-Origin', '*'],
  ['Access-Control-Expose-Headers', 'ETag, Last-Modified'],
];

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: [
          ...getCorsHeaders(),
          ['Access-Control-Allow-Methods', 'GET, PUT, DELETE, HEAD'],
          [
            'Access-Control-Allow-Headers',
            'Authorization, Content-Type, If-Match, If-None-Match',
          ],
          ['Access-Control-Max-Age', '86400'],
        ],
      });
    }

    // Auth check
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const url = new URL(request.url);
    // Key = path without leading slash, e.g., "super-productivity/sync-data.json"
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!key) {
      return new Response('Missing key', { status: 400 });
    }

    try {
      switch (request.method) {
        case 'HEAD': {
          const obj = await env.BUCKET.head(key);
          if (!obj) return new Response(null, { status: 404, headers: getCorsHeaders() });
          return new Response(null, {
            status: 200,
            headers: [
              ...getCorsHeaders(),
              ['ETag', obj.etag],
              ['Last-Modified', obj.uploaded.toUTCString()],
            ],
          });
        }

        case 'GET': {
          const obj = await env.BUCKET.get(key);
          if (!obj) return new Response(null, { status: 404, headers: getCorsHeaders() });
          return new Response(obj.body, {
            headers: [
              ...getCorsHeaders(),
              ['ETag', obj.etag],
              ['Last-Modified', obj.uploaded.toUTCString()],
              ['Content-Type', 'application/json'],
            ],
          });
        }

        case 'PUT': {
          // Conditional upload: If-Match checks ETag for conflict detection
          const ifMatch = request.headers.get('If-Match');
          if (ifMatch) {
            const existing = await env.BUCKET.head(key);
            if (existing && existing.etag !== ifMatch) {
              return new Response('Precondition Failed', {
                status: 412,
                headers: getCorsHeaders(),
              });
            }
          }
          const body = await request.text();
          const result = await env.BUCKET.put(key, body);
          return new Response(null, {
            status: 200,
            headers: [...getCorsHeaders(), ['ETag', result.etag]],
          });
        }

        case 'DELETE': {
          await env.BUCKET.delete(key);
          return new Response(null, { status: 204, headers: getCorsHeaders() });
        }

        default:
          return new Response('Method not allowed', {
            status: 405,
            headers: getCorsHeaders(),
          });
      }
    } catch (e: any) {
      return new Response(`Internal error: ${e.message}`, {
        status: 500,
        headers: getCorsHeaders(),
      });
    }
  },
} satisfies ExportedHandler<Env>;
