/* Manifest version: 77jPvQoP */
// 게시 산출물은 먼저 모두 저장하고, 사용자가 승인한 버전만 시작 화면으로 제공한다.
self.importScripts('./service-worker-assets.js');
const releaseKey = self.assetsManifest.version;
const cacheName = 'chancelab-' + releaseKey;
const metaCacheName = 'chancelab-meta';
const assets = self.assetsManifest.assets.filter(asset => !/service-worker\.js$/.test(asset.url));
const absolute = path => new URL(path, self.registration.scope).href;
const appShellKey = () => absolute('index.html');
const approvedKeyUrl = () => absolute('__approved');

function unavailableResponse(navigation) {
    const message = '승인한 앱 파일을 찾을 수 없어 실행을 멈췄습니다. 저장된 실험 결과는 삭제하지 않았습니다. 기기의 저장 공간을 확인하고 ChanceLab 담당자에게 앱 파일 복구를 요청해 주세요.';
    const body = navigation
        ? '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChanceLab 파일 복구 안내</title><style>body{margin:0;padding:32px;background:#faf9f6;color:#263348;font:18px/1.8 system-ui,sans-serif}main{max-width:640px;margin:10vh auto}h1{font-size:28px;line-height:1.4}</style><main><h1>ChanceLab 앱 파일 복구가 필요합니다</h1><p>' + message + '</p></main></html>'
        : message;
    return new Response(body, { status: 503, statusText: 'Approved app files unavailable', headers: {
        'Content-Type': (navigation ? 'text/html' : 'text/plain') + '; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"
    } });
}

async function appVersion(cache) {
    try {
        const response = await cache.match(absolute('app-version.json'));
        const value = response && await response.json();
        return typeof value?.version === 'string' && value.version.length <= 80 ? value.version : null;
    } catch { return null; }
}

async function releaseStatus(key) {
    const status = { ready: false, cacheVersion: key || '', appVersion: null, scope: self.registration.scope, missingCount: null, appShell: false, reason: key ? 'cache-error' : 'approval-missing' };
    if (!key) return status;
    try {
        const name = 'chancelab-' + key;
        if (!await caches.has(name)) { status.reason = 'cache-missing'; return status; }
        const cache = await caches.open(name);
        const marker = await cache.match(absolute('__ready'));
        const marked = !!marker && await marker.text() === key;
        status.appShell = !!(await cache.match(appShellKey()));
        const storedMetadata = await cache.match(absolute('__metadata'));
        const metadata = storedMetadata ? await storedMetadata.json() : null;
        if (metadata && (metadata.cacheKey !== key || metadata.scope !== self.registration.scope || metadata.appShell !== appShellKey() || !Array.isArray(metadata.assets))) {
            status.reason = 'invalid-status';
            return status;
        }
        // 이전 로컬 게시본은 완료 표식·시작 화면·실제 캐시 키로 승인 상태를 이전한다.
        const urls = metadata?.assets || (key === releaseKey ? assets.map(asset => absolute(asset.url)) : (await cache.keys()).map(request => request.url)
            .filter(url => url.startsWith(self.registration.scope) && !/\/__(ready|metadata)$/.test(url)));
        const complete = await Promise.all(urls.map(url => cache.match(url)));
        status.missingCount = complete.filter(response => !response).length;
        status.appVersion = metadata?.version || await appVersion(cache);
        status.ready = marked && status.appShell && status.missingCount === 0;
        status.reason = !marked ? 'ready-marker-missing' : !status.appShell ? 'app-shell-missing' : status.missingCount ? 'assets-missing' : '';
    } catch { /* 저장소 접근 실패는 기존 승인 정보를 바꾸지 않는다. */ }
    return status;
}

async function readApprovedKey() {
    const meta = await caches.open(metaCacheName);
    const pointer = await meta.match(approvedKeyUrl());
    return pointer ? await pointer.text() : null;
}

let initializingApproval;
async function ensureApproval() {
    if (!initializingApproval) initializingApproval = (async () => {
        if (await readApprovedKey()) return;
        let foundPrevious = false;
        const names = (await caches.keys()).filter(name => name.startsWith('chancelab-') && name !== metaCacheName && name !== cacheName).reverse();
        for (const name of names) {
            const cache = await caches.open(name);
            if (!(await cache.keys()).some(request => request.url.startsWith(self.registration.scope))) continue;
            foundPrevious = true;
            const key = name.slice('chancelab-'.length);
            if (!(await releaseStatus(key)).ready) continue;
            const meta = await caches.open(metaCacheName);
            await meta.put(approvedKeyUrl(), new Response(key));
            return;
        }
        // 새 설치만 초기 승인한다. 손상된 이전 캐시는 사용자의 승인 없이 교체하지 않는다.
        if (!foundPrevious && (await releaseStatus(releaseKey)).ready) {
            const meta = await caches.open(metaCacheName);
            await meta.put(approvedKeyUrl(), new Response(releaseKey));
        }
    })().catch(error => { initializingApproval = null; throw error; });
    await initializingApproval;
}

async function statusResponse() {
    await ensureApproval();
    const approvedKey = await readApprovedKey();
    const [approved, own] = await Promise.all([releaseStatus(approvedKey), releaseStatus(releaseKey)]);
    return {
        ...approved,
        ownReleaseKey: releaseKey, ownReleaseVersion: own.appVersion, ownReleaseReady: own.ready,
        updateKey: own.ready && approvedKey !== releaseKey ? releaseKey : null,
        updateVersion: own.appVersion
    };
}

async function approveRelease(expectedKey) {
    if (expectedKey !== releaseKey || !(await releaseStatus(releaseKey)).ready) return false;
    const meta = await caches.open(metaCacheName);
    await meta.put(approvedKeyUrl(), new Response(releaseKey));
    return true;
}

self.addEventListener('install', event => event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(assets.map(asset => new Request(absolute(asset.url), { integrity: asset.hash, cache: 'no-cache' })));
    await cache.put(absolute('__metadata'), new Response(JSON.stringify({
        cacheKey: releaseKey, version: await appVersion(cache), scope: self.registration.scope,
        appShell: appShellKey(), assets: assets.map(asset => absolute(asset.url))
    }), { headers: { 'Content-Type': 'application/json' } }));
    await cache.put(absolute('__ready'), new Response(releaseKey));
    await ensureApproval();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
    await ensureApproval();
    // 자동 활성화되어도 승인 포인터를 유지하며 기존 창을 강제로 새로고침하지 않는다.
    await self.clients.claim();
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'OFFLINE_READY' });
})()));
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
    const path = url.pathname;
    if (/\/(install|health|connection|classroom-certificate\.cer)$/.test(path)) return;
    // 워커 자체의 갱신은 승인된 앱 파일과 별개로 브라우저가 확인해야 한다.
    if (path === new URL('service-worker.js', self.registration.scope).pathname || path === new URL('service-worker-assets.js', self.registration.scope).pathname) return;
    event.respondWith((async () => {
        try {
            await ensureApproval();
            const approvedKey = await readApprovedKey();
            if (approvedKey) {
                const cache = await caches.open('chancelab-' + approvedKey);
                const key = event.request.mode === 'navigate' ? appShellKey() : event.request;
                const response = await cache.match(key);
                if (response) return response;
            }
            // 구버전 창은 내용 해시가 있는 런타임 파일만 다른 캐시에서 읽는다.
            const fingerprinted = path.startsWith(new URL('_framework/', self.registration.scope).pathname) && /\.[a-z0-9_-]{8,}\.(js|wasm|dll|dat|pdb|json)(\.(br|gz))?$/i.test(path);
            if (event.request.mode !== 'navigate' && fingerprinted) {
                for (const name of await caches.keys()) {
                    if (!name.startsWith('chancelab-') || name === metaCacheName) continue;
                    const response = await (await caches.open(name)).match(event.request);
                    if (response) return response;
                }
            }
        } catch { /* 승인 캐시가 손상돼도 네트워크의 미승인 앱으로 대체하지 않는다. */ }
        return unavailableResponse(event.request.mode === 'navigate');
    })());
});
self.addEventListener('message', event => {
    if (event.data?.type === 'STATUS') event.waitUntil((async () => {
        try { event.ports[0]?.postMessage(await statusResponse()); }
        catch { event.ports[0]?.postMessage({ ready: false, scope: self.registration.scope, reason: 'cache-error' }); }
    })());
    if (event.data?.type === 'APPROVE' || event.data?.type === 'ACTIVATE') event.waitUntil((async () => {
        // ACTIVATE는 이전 설치본의 사용자가 누른 업데이트 버튼과의 호환 경로다.
        const expectedKey = event.data.type === 'ACTIVATE' ? event.data.expectedKey || releaseKey : event.data.expectedKey;
        let approved = false;
        try { approved = await approveRelease(expectedKey); } catch { }
        event.ports[0]?.postMessage({ approved, key: expectedKey });
        if (approved) await self.skipWaiting();
    })());
});
