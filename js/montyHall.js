const watchers = new Map();
let sequence = 0;

export function watchEnvironment(dotnet, root) {
    const id = `monty-${++sequence}`;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => dotnet.invokeMethodAsync('MontyEnvironmentChanged', motion.matches, document.hidden).catch(() => {});
    const watcher = { motion, update, root, expanded: false, scroll: 0, overflow: '', focus: null };
    const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
    const fullscreenChanged = () => dotnet.invokeMethodAsync('MontyFullscreenChanged', fullscreenElement() === root, null).catch(() => {});
    const fullscreenClick = async event => {
        const button = event.target.closest('[data-monty-fullscreen]');
        if (!button || !root.contains(button) || button.disabled) return;
        // 브라우저의 사용자 동작 권한이 남아 있는 실제 클릭 안에서 요청한다.
        try {
            if (fullscreenElement() === root) await leaveFullscreen(root);
            else if (root.requestFullscreen) await root.requestFullscreen();
            else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
            else throw new Error('fullscreen-unavailable');
            fullscreenChanged();
        } catch {
            dotnet.invokeMethodAsync('MontyFullscreenChanged', false, '이 브라우저에서는 크게 보기로 화면을 채웁니다. 작게 보기로 돌아갈 수 있어요.').catch(() => {});
        }
    };
    const keydown = event => {
        if (!watcher.expanded || event.key !== 'Escape' || event.defaultPrevented) return;
        // 설명·초기화는 공통 모달 경로에 맡기고 그다음 ESC에서 확대를 닫는다.
        if (root.querySelector('[role="dialog"][aria-modal="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        dotnet.invokeMethodAsync('MontyCloseDisplay').catch(() => {});
    };
    document.addEventListener('visibilitychange', update);
    motion.addEventListener('change', update);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    document.addEventListener('webkitfullscreenchange', fullscreenChanged);
    root.addEventListener('click', fullscreenClick);
    document.addEventListener('keydown', keydown, true);
    Object.assign(watcher, { fullscreenChanged, fullscreenClick, keydown });
    watchers.set(id, watcher);
    update();
    return id;
}

async function leaveFullscreen(root) {
    if ((document.fullscreenElement || document.webkitFullscreenElement) !== root) return;
    try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
    } catch { /* 브라우저가 먼저 해제했어도 확대 복귀와 정리를 계속한다. */ }
}

export async function setExpanded(id, expanded) {
    const watcher = watchers.get(id);
    if (!watcher || watcher.expanded === expanded) return;
    watcher.expanded = expanded;
    if (expanded) {
        watcher.scroll = window.scrollY;
        watcher.overflow = document.body.style.overflow;
        watcher.focus = document.activeElement;
        document.body.style.overflow = 'hidden';
        watcher.root.scrollTop = 0;
        watcher.root.querySelector('[data-testid="monty-display-close"]')?.focus({ preventScroll: true });
    } else {
        const leaving = leaveFullscreen(watcher.root);
        // 해제 응답 전에 새 확대가 시작되어도 이전 복귀가 스크롤 잠금을 덮지 않는다.
        document.body.style.overflow = watcher.overflow;
        window.scrollTo({ top: watcher.scroll, behavior: 'instant' });
        const focus = watcher.root.querySelector('[data-testid="monty-expand"]') || (watcher.focus?.isConnected ? watcher.focus : null);
        focus?.focus({ preventScroll: true });
        await leaving;
    }
}

export function unwatchEnvironment(id) {
    const watcher = watchers.get(id);
    if (!watcher) return;
    document.removeEventListener('visibilitychange', watcher.update);
    watcher.motion.removeEventListener('change', watcher.update);
    document.removeEventListener('fullscreenchange', watcher.fullscreenChanged);
    document.removeEventListener('webkitfullscreenchange', watcher.fullscreenChanged);
    watcher.root.removeEventListener('click', watcher.fullscreenClick);
    document.removeEventListener('keydown', watcher.keydown, true);
    if (watcher.expanded) {
        document.body.style.overflow = watcher.overflow;
        void leaveFullscreen(watcher.root);
    }
    watchers.delete(id);
}
