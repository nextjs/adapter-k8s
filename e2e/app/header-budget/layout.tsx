import type { ReactNode } from "react";
import { preload } from "react-dom";

export default function HeaderBudgetLayout({ children }: { children: ReactNode }) {
  for (let index = 0; index < 20; index += 1) {
    preload(`/header-budget/font-${String(index).padStart(2, "0")}.woff2`, {
      as: "font",
      type: "font/woff2",
      crossOrigin: "anonymous",
    });
  }
  return children;
}
