import type { Browser } from "@e2e-dev/web";

export function reproTest(): typeof import("@e2e-dev/web").test;
export function openSearch(app: { open(path: string): Promise<unknown> }, browser: Browser): Promise<void>;
export function textContrast(browser: Browser, selector: string): Promise<{ found: boolean; ratio: number }>;
export function proveVisibleFailure(browser: Browser, selector: string): Promise<void>;
