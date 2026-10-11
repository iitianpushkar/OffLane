"use client";

import { useEffect } from "react";

export function ProductBoot() {
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import("./product-client").then(({ initializeProduct }) => initializeProduct()).then((dispose) => {
      if (cancelled) dispose();
      else cleanup = dispose;
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  return null;
}
