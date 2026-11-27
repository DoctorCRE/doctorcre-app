import { useEffect } from "react";

const HOME_TITLE = "Home · DoctorCRE";

function runBadge(api: unknown, ...args: number[]): void {
  if (typeof api !== "function") return;
  let result: unknown;
  try {
    result = api.apply(navigator, args);
  } catch {
    return;
  }
  void Promise.resolve(result).catch(() => {});
}

export function setHomeTabBadge(count: number): void {
  if (count > 0) {
    document.title = `(${count}) ${HOME_TITLE}`;
    runBadge(navigator.setAppBadge, count);
    return;
  }
  document.title = HOME_TITLE;
  runBadge(navigator.clearAppBadge);
}

export function useHomeTabBadge(home: boolean, count: number | null): void {
  useEffect(() => {
    if (home && count != null) setHomeTabBadge(count);
  }, [home, count]);
  useEffect(() => {
    if (home) return () => setHomeTabBadge(0);
  }, [home]);
}
