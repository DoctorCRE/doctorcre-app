/**
 * The app Worker's CARR service binding, pointed at the local CARR Worker.
 * The browser's aborts are not forwarded: the local CARR keeps running a request
 * whose caller left, so teardown awaits `settled` before CARR closes its database.
 */
export function carrBinding(origin: string) {
  const inFlight = new Set<Promise<Response>>();
  return {
    fetch(request: Request) {
      const response = forward(origin, request);
      inFlight.add(response);
      const forget = () => inFlight.delete(response);
      response.then(forget, forget);
      return response;
    },
    settled: () => Promise.allSettled(inFlight),
  };
}

async function forward(origin: string, request: Request) {
  const url = new URL(request.url);
  const body = request.body && (await request.arrayBuffer());
  return fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: "manual",
  });
}
