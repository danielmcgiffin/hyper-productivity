interface Env {
  BUCKET: R2Bucket;
  AUTH_TOKEN: string;
  ICAL_OUTLOOK_URL?: string;
  ICAL_CURSUS_URL?: string;
  ICAL_PERSONAL_URL?: string;
}

const getCorsHeaders = (): [string, string][] => [
  ['Access-Control-Allow-Origin', '*'],
  ['Access-Control-Expose-Headers', 'ETag, Last-Modified'],
];

type ICalRoutePath = '/ical/outlook.ics' | '/ical/cursus.ics' | '/ical/personal.ics';
type ICalEnvKey = 'ICAL_OUTLOOK_URL' | 'ICAL_CURSUS_URL' | 'ICAL_PERSONAL_URL';

const isIcalRoutePath = (path: string): path is ICalRoutePath =>
  path === '/ical/outlook.ics' ||
  path === '/ical/cursus.ics' ||
  path === '/ical/personal.ics';

const getIcalUrlForPath = (path: ICalRoutePath, env: Env): string | undefined => {
  let envKey: ICalEnvKey;
  switch (path) {
    case '/ical/outlook.ics':
      envKey = 'ICAL_OUTLOOK_URL';
      break;
    case '/ical/cursus.ics':
      envKey = 'ICAL_CURSUS_URL';
      break;
    case '/ical/personal.ics':
      envKey = 'ICAL_PERSONAL_URL';
      break;
    default:
      return undefined;
  }

  return env[envKey];
};

const handleIcalProxyRequest = async (
  request: Request,
  env: Env,
  pathname: ICalRoutePath,
): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: getCorsHeaders(),
    });
  }

  const sourceUrl = getIcalUrlForPath(pathname, env);
  if (!sourceUrl) {
    return new Response(`Calendar route not configured: ${pathname}`, {
      status: 500,
      headers: getCorsHeaders(),
    });
  }

  try {
    const requestHeaders = new Headers();
    requestHeaders.set('User-Agent', 'sp-calendar-proxy/1.0');

    const upstream = await fetch(sourceUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: requestHeaders,
    });

    if (!upstream.ok) {
      return new Response(`Calendar fetch failed (${upstream.status})`, {
        status: 502,
        headers: getCorsHeaders(),
      });
    }

    const headers: [string, string][] = [
      ...getCorsHeaders(),
      ['Content-Type', upstream.headers.get('Content-Type') || 'text/calendar'],
      ['Cache-Control', 'public, max-age=300'],
    ];

    const etag = upstream.headers.get('ETag');
    if (etag) {
      headers.push(['ETag', etag]);
    }

    const lastModified = upstream.headers.get('Last-Modified');
    if (lastModified) {
      headers.push(['Last-Modified', lastModified]);
    }

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: 200,
      headers,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return new Response(`Calendar proxy error: ${message}`, {
      status: 502,
      headers: getCorsHeaders(),
    });
  }
};

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: [
          ...getCorsHeaders(),
          ['Access-Control-Allow-Methods', 'GET, PUT, DELETE, HEAD, OPTIONS'],
          [
            'Access-Control-Allow-Headers',
            'Authorization, Content-Type, If-Match, If-None-Match',
          ],
          ['Access-Control-Max-Age', '86400'],
        ],
      });
    }

    // Public calendar proxy routes (for web iCal CORS compatibility)
    if (isIcalRoutePath(url.pathname)) {
      return handleIcalProxyRequest(request, env, url.pathname);
    }

    // Auth check
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

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
