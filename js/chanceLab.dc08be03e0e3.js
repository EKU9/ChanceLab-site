(() => {
    'use strict';
    const dbName = 'ChanceLab';
    // 빈 영역이나 다른 조작을 탭하면 펼친 데이터 메뉴를 닫는다.
    document.addEventListener('pointerdown', event => {
        document.querySelectorAll('details.utility-menu[open]').forEach(menu => {
            if (!menu.contains(event.target)) menu.open = false;
        });
    });
    // 모달 밖의 탭·초기화 버튼으로 키보드 초점이 빠져나가지 않도록 한다.
    document.addEventListener('keydown', event => {
        const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) {
            if (event.key === 'Escape') document.querySelectorAll('details.utility-menu[open]').forEach(menu => { menu.open = false; });
            return;
        }
        // 비활성화된 실행 취소 버튼에서 초점이 body로 옮겨져도 ESC는 열린 창을 취소한다.
        if (event.key === 'Escape' && !dialog.contains(event.target)) {
            event.preventDefault();
            event.stopPropagation();
            dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            return;
        }
        if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
        const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')]
            .filter(element => element.getClientRects().length > 0);
        event.preventDefault();
        if (!controls.length) { dialog.focus(); return; }
        const index = controls.indexOf(document.activeElement);
        const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[next].focus();
    }, true);
    let focusedDialog = null, focusBeforeDialogs = null;
    new MutationObserver(() => {
        const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
        const top = dialogs[dialogs.length - 1] || null;
        if (top === focusedDialog) {
            if (top && !top.contains(document.activeElement)) top.focus({ preventScroll: true });
            return;
        }
        if (top) {
            if (!focusedDialog && !top.contains(document.activeElement)) focusBeforeDialogs = document.activeElement;
            if (!top.contains(document.activeElement)) top.focus({ preventScroll: true });
        } else if (focusBeforeDialogs?.isConnected) focusBeforeDialogs.focus({ preventScroll: true });
        focusedDialog = top;
    }).observe(document.body, { childList: true, subtree: true });
    const owner = crypto.randomUUID();
    let db, reference, fence = null, heartbeat, registration, cacheError = '', installError = '', checkingUpdate;
    let saveChain = Promise.resolve();
    let updateCheckSucceeded = false;
    let browserLockHeld = false, releaseBrowserLock;
    async function acquireBrowserLock() {
        if (!navigator.locks) return true;
        return await new Promise((resolve, reject) => {
            navigator.locks.request('ChanceLab.writer', { ifAvailable: true }, async lock => {
                if (!lock) { resolve(false); return; }
                browserLockHeld = true;
                resolve(true);
                await new Promise(release => { releaseBrowserLock = release; });
                browserLockHeld = false;
            }).catch(reject);
        });
    }
    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const complete = tx => new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error('저장 트랜잭션이 취소되었습니다.'));
        tx.onerror = () => {};
    });
    async function acquire() {
        const tx = db.transaction('records', 'readwrite');
        const done = complete(tx);
        const store = tx.objectStore('records');
        const lease = await request(store.get('lease'));
        const now = Date.now();
        if (browserLockHeld || !lease || lease.expires < now) {
            fence = { owner, token: crypto.randomUUID(), expires: now + 12000 };
            store.put(fence, 'lease');
        }
        await done;
        return fence !== null;
    }
    async function renew() {
        if (!fence) return;
        try {
            const tx = db.transaction('records', 'readwrite');
            const done = complete(tx);
            const store = tx.objectStore('records');
            const current = await request(store.get('lease'));
            const owns = current && current.owner === owner && current.token === fence.token;
            if (owns) {
                fence.expires = Date.now() + 12000;
                store.put(fence, 'lease');
            }
            await done;
            if (!owns) {
                fence = null;
                clearInterval(heartbeat);
                await reference?.invokeMethodAsync('OnOwnershipLost');
            }
        } catch { /* 다음 쓰기에서도 소유권을 다시 확인하므로 임시 오류가 덮어쓰기를 허용하지 않는다. */ }
    }
    const signalOffline = () => reference?.invokeMethodAsync('OnOfflineChanged').catch(() => {});
    // 활성 등록만으로는 현재 문서의 오프라인 탐색이 보장되지 않는다.
    function currentControlIssue(currentRegistration, controller, pageUrl) {
        if (!currentRegistration) return 'registration';
        if (!controller) return 'uncontrolled';
        if (controller.state !== 'activated') return 'inactive';
        try {
            const scope = new URL(currentRegistration.scope);
            const page = new URL(pageUrl);
            const script = new URL(controller.scriptURL);
            if (scope.origin !== page.origin || script.origin !== page.origin || !page.href.startsWith(scope.href)) return 'scope';
        } catch { return 'scope'; }
        return null;
    }
    const offlineReason = reason => ({
        registration: '앱 파일을 기기에 준비 중 · HTTPS 연결을 유지해 주세요.',
        uncontrolled: '이 화면의 오프라인 연결을 준비 중 · 연결된 상태에서 홈 화면 앱을 다시 열어 주세요.',
        inactive: '오프라인 실행 기능을 활성화하는 중입니다.',
        scope: '현재 주소의 오프라인 연결을 확인하지 못했습니다. 연결 후 같은 주소로 다시 열어 주세요.',
        changed: '오프라인 실행 버전이 바뀌어 다시 확인 중입니다.',
        'ready-marker-missing': '앱 파일 저장이 끝나지 않았습니다. 연결 후 앱을 다시 열어 주세요.',
        'app-shell-missing': '오프라인 시작 화면이 저장되지 않았습니다. 연결 후 앱을 다시 열어 주세요.',
        'assets-missing': '오프라인 앱 파일이 일부 없습니다. 연결 후 앱을 다시 열어 주세요.',
        'cache-error': '기기의 오프라인 저장소를 확인하지 못했습니다. 연결 후 다시 확인해 주세요.',
        'cache-missing': '승인한 버전의 앱 파일이 기기에 없습니다. 인터넷에 연결해 준비 상태를 확인해 주세요.',
        'approval-missing': '이전 버전의 준비 정보를 복원하지 못했습니다. 인터넷에 연결해 새 버전 안내를 확인해 주세요.',
        development: '개발 서버에서는 오프라인 준비를 완료할 수 없습니다. 게시본을 열어 주세요.',
        'invalid-status': '오프라인 파일의 준비 상태를 확인하지 못했습니다. 연결 후 다시 확인해 주세요.',
        timeout: '오프라인 실행 기능의 응답이 없습니다. 연결 후 앱을 다시 열어 주세요.'
    })[reason] || '오프라인 준비를 확인 중입니다.';
    function workerMessage(worker, message) {
        return new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            const finish = () => { clearTimeout(timeout); channel.port1.close(); };
            const timeout = setTimeout(() => { finish(); reject(new Error('응답 대기')); }, 8000);
            channel.port1.onmessage = event => { finish(); resolve(event.data); };
            channel.port1.onmessageerror = () => { finish(); reject(new Error('응답 오류')); };
            try { worker.postMessage(message, [channel.port2]); }
            catch (error) { finish(); reject(error); }
        });
    }
    const completeStatus = status => status?.ready === true && status.appShell === true && status.missingCount === 0 && typeof status.cacheVersion === 'string' && status.cacheVersion.length > 0;
    async function updateCandidate(controllerStatus, allowOffline = false) {
        if (!registration || (!allowOffline && (navigator.onLine === false || !updateCheckSucceeded))) return null;
        const worker = registration.waiting || navigator.serviceWorker.controller;
        if (!worker) return null;
        try {
            const status = worker === navigator.serviceWorker.controller && controllerStatus ? controllerStatus : await workerMessage(worker, { type: 'STATUS' });
            if (worker !== registration.waiting && worker !== navigator.serviceWorker.controller) return null;
            if (status.scope !== registration.scope || status.ownReleaseReady !== true || typeof status.updateKey !== 'string' || status.updateKey !== status.ownReleaseKey) return null;
            return { worker, key: status.updateKey, version: typeof status.updateVersion === 'string' ? status.updateVersion : '' };
        } catch { return null; }
    }
    const updateFields = candidate => ({ update: !!candidate, updateKey: candidate?.key || null, updateVersion: candidate?.version || null });
    async function checkForUpdate() {
        if (!registration || navigator.onLine === false) { updateCheckSucceeded = false; return false; }
        if (!checkingUpdate) checkingUpdate = Promise.resolve().then(() => registration.update()).then(() => { updateCheckSucceeded = true; return true; }).catch(() => { updateCheckSucceeded = false; return false; }).finally(() => {
            checkingUpdate = null;
            signalOffline();
        });
        return await checkingUpdate;
    }
    async function registerWorker() {
        if (!('serviceWorker' in navigator) || !window.isSecureContext) {
            cacheError = 'HTTPS로 열면 오프라인 준비가 가능합니다.';
            signalOffline();
            return;
        }
        let preparationTimeout;
        const controlChanged = () => {
            if (!currentControlIssue(registration, navigator.serviceWorker.controller, location.href)) clearTimeout(preparationTimeout);
            signalOffline();
        };
        navigator.serviceWorker.addEventListener('controllerchange', controlChanged);
        navigator.serviceWorker.addEventListener('message', signalOffline);
        // 등록 갱신 실패 때도 기존 등록의 캐시와 현재 제어 상태는 확인한다.
        try { registration = await navigator.serviceWorker.getRegistration(location.href); } catch { }
        try {
            if (!registration || navigator.onLine !== false) registration = await navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' });
            cacheError = '';
        } catch (error) {
            cacheError = '오프라인 등록 확인 실패 · 연결 후 앱을 다시 열어 주세요. ' + error.message;
        }
        if (!registration) { signalOffline(); return; }
        const observeInstalling = () => {
            const worker = registration.installing;
            if (!worker) return;
            installError = '';
            worker.addEventListener('statechange', () => {
                if (worker.state === 'redundant') installError = '앱 파일 저장에 실패했습니다. 연결과 기기 여유 공간을 확인한 뒤 다시 열어 주세요.';
                else if (worker.state === 'activated') installError = '';
                controlChanged();
            });
            signalOffline();
        };
        registration.addEventListener('updatefound', observeInstalling);
        observeInstalling();
        preparationTimeout = setTimeout(() => {
            if (!currentControlIssue(registration, navigator.serviceWorker.controller, location.href)) return;
            installError ||= '오프라인 연결 준비가 지연되고 있습니다. 연결된 상태에서 홈 화면 앱을 다시 열어 주세요.';
            signalOffline();
        }, 30000);
        navigator.serviceWorker.ready.then(controlChanged).catch(() => {
            installError = '오프라인 실행 기능을 활성화하지 못했습니다. 연결 후 앱을 다시 열어 주세요.';
            signalOffline();
        });
        // 인터넷 연결 확인은 앱 시작을 기다리게 하지 않으며 실패도 조용히 무시한다.
        checkForUpdate();
        controlChanged();
    }
    window.chanceLab = {
        focusTopDialog() {
            const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
            dialogs[dialogs.length - 1]?.focus({ preventScroll: true });
        },
        async initialize(dotnet) {
            reference = dotnet;
            const opening = indexedDB.open(dbName, 1);
            opening.onupgradeneeded = () => opening.result.createObjectStore('records');
            db = await request(opening);
            db.onversionchange = () => db.close();
            // Web Lock은 살아 있는 문서를 구분한다. 복제 탭의 sessionStorage도 소유권을 빼앗지 못한다.
            const canWrite = await acquireBrowserLock() && await acquire();
            const tx = db.transaction('records', 'readonly');
            const done = complete(tx);
            const store = tx.objectStore('records');
            const [snapshot, ui] = await Promise.all([request(store.get('snapshot')), request(store.get('ui'))]);
            await done;
            heartbeat = setInterval(renew, 3000);
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) reference?.invokeMethodAsync('OnHidden').catch(() => {});
                else { renew(); checkForUpdate(); signalOffline(); }
            });
            addEventListener('pagehide', () => reference?.invokeMethodAsync('OnHidden').catch(() => {}));
            addEventListener('online', () => { checkForUpdate(); signalOffline(); });
            addEventListener('offline', signalOffline);
            navigator.storage?.persist?.().catch(() => {});
            registerWorker();
            return { canWrite, snapshot: snapshot || null, ui: ui || null };
        },
        save(snapshot, ui) {
            const perform = async () => {
                if (!fence) throw new Error('이 창에는 저장 권한이 없습니다.');
                const tx = db.transaction('records', 'readwrite');
                const done = complete(tx);
                const store = tx.objectStore('records');
                const lease = await request(store.get('lease'));
                if (!lease || lease.owner !== owner || lease.token !== fence.token) {
                    tx.abort();
                    await done.catch(() => {});
                    throw new Error('다른 창이 저장소의 소유권을 가져갔습니다.');
                }
                // JSON 문자열로 보관하므로 C# long/decimal을 JS Number로 변환하지 않는다.
                store.put(snapshot, 'snapshot');
                store.put(ui, 'ui');
                lease.expires = Date.now() + 12000;
                store.put(lease, 'lease');
                await done;
            };
            const work = saveChain.then(perform);
            saveChain = work.catch(() => {});
            return work;
        },
        async offlineStatus() {
            const controller = navigator.serviceWorker?.controller;
            const issue = currentControlIssue(registration, controller, location.href);
            if (issue) return { ready: false, message: cacheError || installError || offlineReason(issue), ...updateFields(await updateCandidate()), reason: issue };
            try {
                const status = await workerMessage(controller, { type: 'STATUS' });
                const candidate = await updateCandidate(status);
                const changed = controller !== navigator.serviceWorker.controller;
                const controlIssue = currentControlIssue(registration, navigator.serviceWorker.controller, location.href);
                if (changed || controlIssue) {
                    const reason = changed ? 'changed' : controlIssue;
                    return { ready: false, message: offlineReason(reason), ...updateFields(candidate), reason };
                }
                if (status?.scope !== registration.scope) return { ready: false, message: offlineReason('scope'), ...updateFields(candidate), reason: 'scope' };
                const ready = completeStatus(status);
                const reason = ready ? '' : status.reason || 'invalid-status';
                return {
                    ready,
                    message: ready ? '오프라인 준비 완료' : offlineReason(reason),
                    ...updateFields(candidate), cacheVersion: status.cacheVersion, scope: status.scope,
                    missingCount: status.missingCount, appShell: status.appShell === true, reason
                };
            } catch { return { ready: false, message: offlineReason('timeout'), ...updateFields(await updateCandidate()), reason: 'timeout' }; }
        },
        checkForUpdate,
        async applyUpdate(expectedKey) {
            if (!expectedKey) return false;
            const candidate = await updateCandidate(null, true);
            if (!candidate || candidate.key !== expectedKey) { signalOffline(); return false; }
            const worker = candidate.worker;
            let changed = false;
            const controllerChanged = () => { if (navigator.serviceWorker.controller === worker) changed = true; };
            navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
            try {
                const result = await workerMessage(worker, { type: 'APPROVE', expectedKey });
                if (result?.approved !== true || result.key !== expectedKey) return false;
                // 이미 활성화된 새 워커도 승인한 요청 창에서만 새로고침한다.
                if (navigator.serviceWorker.controller !== worker && !changed) {
                    const activated = await new Promise(resolve => {
                        const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', ready); resolve(false); }, 15000);
                        const ready = () => {
                            if (navigator.serviceWorker.controller !== worker) return;
                            clearTimeout(timer);
                            navigator.serviceWorker.removeEventListener('controllerchange', ready);
                            resolve(true);
                        };
                        navigator.serviceWorker.addEventListener('controllerchange', ready);
                        ready();
                    });
                    if (!activated) return false;
                }
                location.reload();
                return true;
            } catch { return false; }
            finally { navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged); }
        },
        download(json, filename) {
            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = filename;
            document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        },
        scrollPosition: () => window.scrollY,
        restoreScroll: value => requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, value))),
        async release() {
            clearInterval(heartbeat);
            await saveChain;
            if (!db || !fence) return;
            const tx = db.transaction('records', 'readwrite');
            const done = complete(tx);
            const store = tx.objectStore('records');
            const lease = await request(store.get('lease'));
            if (lease?.owner === owner && lease.token === fence.token) store.delete('lease');
            await done;
            releaseBrowserLock?.();
            releaseBrowserLock = null;
        }
    };
})();
