const listeners = new Map();
let sequence = 0;

export function watchVisibility(dotnet) {
    const id = `textbook-${++sequence}`;
    const listener = () => {
        if (document.hidden) dotnet.invokeMethodAsync("PauseForVisibility").catch(() => {});
    };
    document.addEventListener("visibilitychange", listener);
    listeners.set(id, listener);
    listener();
    return id;
}

export function unwatchVisibility(id) {
    const listener = listeners.get(id);
    if (listener) document.removeEventListener("visibilitychange", listener);
    listeners.delete(id);
}
