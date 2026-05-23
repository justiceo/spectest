import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL || 'https://jsonplaceholder.typicode.com';

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function fetchJson(path) {
  const response = await fetch(new URL(path, upstreamBaseUrl));
  if (!response.ok) {
    throw new Error(`Upstream request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function routeParams(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = pathPart;
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'HEAD') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/excluded-ping') {
      const excludedUrl = 'https://1.1.1.1/cdn-cgi/trace';
      const excludedResponse = await fetch(excludedUrl);
      sendJson(res, 200, {
        ok: excludedResponse.ok,
        status: excludedResponse.status,
        excludedUrl,
      });
      return;
    }

    const postParams = routeParams('/posts/:id', url.pathname);
    if (req.method === 'GET' && postParams) {
      const post = await fetchJson(`/posts/${postParams.id}`);
      const user = await fetchJson(`/users/${post.userId}`);
      sendJson(res, 200, {
        id: post.id,
        title: post.title,
        author: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
      });
      return;
    }

    const userParams = routeParams('/users/:id/summary', url.pathname);
    if (req.method === 'GET' && userParams) {
      const [user, posts, todos] = await Promise.all([
        fetchJson(`/users/${userParams.id}`),
        fetchJson(`/users/${userParams.id}/posts`),
        fetchJson(`/users/${userParams.id}/todos`),
      ]);
      sendJson(res, 200, {
        id: user.id,
        name: user.name,
        postCount: posts.length,
        openTodoCount: todos.filter((todo) => !todo.completed).length,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/search/comments') {
      const postId = url.searchParams.get('postId') || '1';
      const comments = await fetchJson(`/comments?postId=${encodeURIComponent(postId)}`);
      sendJson(res, 200, {
        postId: Number(postId),
        count: comments.length,
        emails: comments.slice(0, 3).map((comment) => comment.email),
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 502, {
      error: 'upstream request failed',
      message: error.message,
    });
  }
});

server.listen(port, () => {
  console.log(`Demo server listening on http://localhost:${port}`);
  console.log(`Proxying outbound requests to ${upstreamBaseUrl}`);
});
