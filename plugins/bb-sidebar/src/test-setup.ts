import { createRequire } from "node:module";

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = TestResizeObserver;

if (typeof window === "undefined" && !("require" in globalThis)) {
  Object.defineProperty(globalThis, "require", {
    configurable: true,
    value: createRequire(import.meta.url),
  });
}

class TestStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value));
  }
}

const testStorage = new TestStorage();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: testStorage,
});

if (typeof window !== "undefined" && typeof Storage !== "undefined") {
  const storageData = new WeakMap<Storage, Map<string, string>>();

  Object.defineProperties(Storage.prototype, {
    length: {
      configurable: true,
      get(this: Storage) {
        return storageData.get(this)?.size ?? 0;
      },
    },
    clear: {
      configurable: true,
      writable: true,
      value(this: Storage) {
        storageData.set(this, new Map());
        for (const key of Object.keys(this)) delete (this as any)[key];
      },
    },
    getItem: {
      configurable: true,
      writable: true,
      value(this: Storage, key: string) {
        return storageData.get(this)?.get(String(key)) ?? null;
      },
    },
    key: {
      configurable: true,
      writable: true,
      value(this: Storage, index: number) {
        return [...(storageData.get(this)?.keys() ?? [])][index] ?? null;
      },
    },
    removeItem: {
      configurable: true,
      writable: true,
      value(this: Storage, key: string) {
        const normalized = String(key);
        storageData.get(this)?.delete(normalized);
        delete (this as any)[normalized];
      },
    },
    setItem: {
      configurable: true,
      writable: true,
      value(this: Storage, key: string, value: string) {
        const normalizedKey = String(key);
        const normalizedValue = String(value);
        const values = storageData.get(this) ?? new Map<string, string>();
        values.set(normalizedKey, normalizedValue);
        storageData.set(this, values);
        Object.defineProperty(this, normalizedKey, {
          configurable: true,
          enumerable: true,
          value: normalizedValue,
          writable: true,
        });
      },
    },
  });

  const browserStorage = Object.create(Storage.prototype) as Storage;
  storageData.set(browserStorage, new Map());
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: browserStorage,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: browserStorage,
  });

  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly scrollMargin = "";
    readonly thresholds: number[] = [];
    private readonly observed = new Set<Element>();
    private deliveryScheduled = false;

    constructor(private readonly callback: IntersectionObserverCallback) {}

    observe(target: Element): void {
      this.observed.add(target);
      if (this.deliveryScheduled) return;
      this.deliveryScheduled = true;
      queueMicrotask(() => {
        this.deliveryScheduled = false;
        const entries = [...this.observed].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            boundingClientRect: rect,
            intersectionRatio: 1,
            intersectionRect: rect,
            isIntersecting: true,
            rootBounds: null,
            target: element,
            time: Date.now(),
          };
        });
        this.observed.clear();
        if (entries.length > 0) this.callback(entries, this);
      });
    }

    disconnect(): void {
      this.observed.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    unobserve(target: Element): void {
      this.observed.delete(target);
    }
  }

  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: TestIntersectionObserver,
  });
}
