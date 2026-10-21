export function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export function errorResponse(code, message, { status = 500, headers = {} } = {}) {
  return jsonResponse(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}

export function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};

  const wildcard = allowedOrigins === '*';
  const allowed = wildcard || (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin));
  if (!allowed) return {};

  return {
    'Access-Control-Allow-Origin': wildcard ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function withHeaders(response, headers) {
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) {
    copy.headers.set(key, value);
  }
  return copy;
}
