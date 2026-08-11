/* Whizz Vídeo — service worker
   Guarda o app para abrir offline. Troque a VERSAO a cada atualização
   para que todos os aparelhos peguem a versão nova. */
const VERSAO = 'whizz-v1';
const ESSENCIAIS = [
  './',
  './index.html',
  './manifest.json',
  './icone-192.png',
  './icone-512.png',
  './apple-touch-icon.png'
];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const cache = await caches.open(VERSAO);
    await cache.addAll(ESSENCIAIS);
    // As bibliotecas externas são bônus: se alguma falhar, o app continua instalando
    await Promise.all(CDN.map(u => cache.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n => n !== VERSAO).map(n => caches.delete(n)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;                          // dados da planilha nunca são cacheados
  if (req.url.indexOf('script.google') >= 0) return;

  ev.respondWith((async () => {
    const guardado = await caches.match(req);
    if (guardado) {
      // devolve o guardado na hora e atualiza por baixo
      fetch(req).then(r => {
        if (r && r.ok) caches.open(VERSAO).then(c => c.put(req, r.clone()));
      }).catch(() => {});
      return guardado;
    }
    try {
      const rede = await fetch(req);
      if (rede && rede.ok && req.url.startsWith(self.location.origin)) {
        const c = await caches.open(VERSAO);
        c.put(req, rede.clone());
      }
      return rede;
    } catch (e) {
      return caches.match('./index.html');
    }
  })());
});
