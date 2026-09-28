export function installWindowStorage(force = false): Storage {
  if (!force) {
    const globalValue = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')?.value;
    if (isStorage(globalValue)) {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: globalValue });
      return globalValue;
    }
    const windowValue = Object.getOwnPropertyDescriptor(window, 'localStorage')?.value;
    if (isStorage(windowValue)) return windowValue;
  }

  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return storage;
}

function isStorage(value: unknown): value is Storage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getItem' in value &&
    typeof value.getItem === 'function' &&
    'setItem' in value &&
    typeof value.setItem === 'function'
  );
}
