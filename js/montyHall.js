const watchers = new Map();
let sequence = 0;

export function watchEnvironment(dotnet) {
    const id = `monty-${++sequence}`;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => dotnet.invokeMethodAsync('MontyEnvironmentChanged', motion.matches, document.hidden).catch(() => {});
    document.addEventListener('visibilitychange', update);
    motion.addEventListener('change', update);
    watchers.set(id, { motion, update });
    update();
    return id;
}

export function unwatchEnvironment(id) {
    const watcher = watchers.get(id);
    if (!watcher) return;
    document.removeEventListener('visibilitychange', watcher.update);
    watcher.motion.removeEventListener('change', watcher.update);
    watchers.delete(id);
}
