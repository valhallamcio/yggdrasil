/**
 * Small page that opens a stored `trace.json.gz` in ui.perfetto.dev. It fetches the trace from
 * this origin, gunzips it with DecompressionStream, and hands it over with Perfetto's documented
 * postMessage handshake: PING until PONG, then `{perfetto: {buffer, title}}`.
 * https://perfetto.dev/docs/visualization/deep-linking-to-perfetto-ui
 */

export const PERFETTO_ORIGIN = 'https://ui.perfetto.dev';

export function perfettoPageHtml(opts: { title: string; traceUrl: string; nonce: string }): string {
  const cfg = JSON.stringify({ title: opts.title, traceUrl: opts.traceUrl, origin: PERFETTO_ORIGIN }).replace(/</g, '\\u003c');
  const title = escapeHtml(opts.title);
  const nonce = escapeHtml(opts.nonce);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} - Perfetto</title>
<style nonce="${nonce}">
body { font: 14px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 40rem; padding: 0 1rem; }
button { font: inherit; padding: .5rem 1rem; cursor: pointer; }
#status { color: #555; }
</style>
</head>
<body>
<h1>${title}</h1>
<p id="status">Loading the trace...</p>
<button id="open" type="button" disabled>Open in Perfetto</button>
<script type="application/json" id="cfg">${cfg}</script>
<script nonce="${nonce}">
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var status = document.getElementById('status');
  var button = document.getElementById('open');
  var trace = null;

  function openPerfetto() {
    var win = window.open(cfg.origin);
    if (!win) { status.textContent = 'The browser blocked the popup. Allow popups for this page.'; return; }
    status.textContent = 'Waiting for Perfetto...';
    var timer = setInterval(function () { win.postMessage('PING', cfg.origin); }, 50);
    function onMessage(evt) {
      if (evt.origin !== cfg.origin || evt.data !== 'PONG') return;
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
      win.postMessage({ perfetto: { buffer: trace, title: cfg.title } }, cfg.origin);
      status.textContent = 'Trace sent to Perfetto.';
    }
    window.addEventListener('message', onMessage);
  }

  fetch(cfg.traceUrl, { credentials: 'same-origin' })
    .then(function (res) {
      if (!res.ok) throw new Error('trace download failed: HTTP ' + res.status);
      return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    })
    .then(function (buf) {
      trace = buf;
      status.textContent = 'Trace ready (' + (buf.byteLength / 1048576).toFixed(1) + ' MB).';
      button.disabled = false;
      button.addEventListener('click', openPerfetto);
    })
    .catch(function (err) { status.textContent = String(err); });
})();
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
