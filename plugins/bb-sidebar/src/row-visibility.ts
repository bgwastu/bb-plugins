type VisibilityCallback = () => void;

const watchedRows = new Map<Element, VisibilityCallback>();
let rowObserver: IntersectionObserver | null = null;

function ensureRowObserver(): IntersectionObserver {
  if (rowObserver) return rowObserver;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const onVisible = watchedRows.get(entry.target);
        if (!onVisible) continue;
        watchedRows.delete(entry.target);
        observer.unobserve(entry.target);
        onVisible();
      }
      if (watchedRows.size === 0) {
        observer.disconnect();
        if (rowObserver === observer) rowObserver = null;
      }
    },
    { rootMargin: "180px 0px" },
  );
  rowObserver = observer;
  return observer;
}

/**
 * Notify once a row enters or approaches the viewport. One shared observer
 * handles the list instead of allocating an observer for every thread card.
 */
export function observeOnceVisible(
  element: Element,
  callback: VisibilityCallback,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof IntersectionObserver === "undefined"
  ) {
    callback();
    return () => {};
  }

  const observer = ensureRowObserver();
  watchedRows.set(element, callback);
  observer.observe(element);

  return () => {
    watchedRows.delete(element);
    observer.unobserve(element);
    if (watchedRows.size === 0 && rowObserver === observer) {
      observer.disconnect();
      rowObserver = null;
    }
  };
}
