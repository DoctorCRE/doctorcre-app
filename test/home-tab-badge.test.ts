import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { setHomeTabBadge, useHomeTabBadge } from "../src/ui/home/tab-badge.ts";

const HOME_TITLE = "Home · DoctorCRE";

type BadgeNavigator = {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

const previous = {
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};

function restorePage(): void {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (previous.document) Object.defineProperty(globalThis, "document", previous.document);
  else Reflect.deleteProperty(globalThis, "document");
  if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
  else Reflect.deleteProperty(globalThis, "navigator");
}

function install(badge: BadgeNavigator): { title: string } {
  const page = { title: HOME_TITLE };
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: badge });
  return page;
}

test.afterEach(restorePage);

test("setting a count of 3 updates the tab title and badge, and a count of 0 clears both", () => {
  const setAppBadge = mock.fn(async (_contents?: number) => {});
  const clearAppBadge = mock.fn(async () => {});
  const page = install({ setAppBadge, clearAppBadge });

  setHomeTabBadge(3);
  assert.equal(page.title, "(3) Home · DoctorCRE");
  assert.equal(setAppBadge.mock.calls.length, 1);
  assert.deepEqual(setAppBadge.mock.calls[0]?.arguments, [3]);
  assert.equal(clearAppBadge.mock.calls.length, 0);

  setHomeTabBadge(0);
  assert.equal(page.title, "Home · DoctorCRE");
  assert.equal(clearAppBadge.mock.calls.length, 1);
  assert.equal(setAppBadge.mock.calls.length, 1);
});

test("when setAppBadge is absent or rejects, document.title still updates and no error is thrown", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const withoutBadge = install({});
    assert.doesNotThrow(() => setHomeTabBadge(3));
    assert.equal(withoutBadge.title, "(3) Home · DoctorCRE");

    const setAppBadge = mock.fn(async () => {
      throw new Error("badge denied");
    });
    const rejecting = install({ setAppBadge });
    assert.doesNotThrow(() => setHomeTabBadge(3));
    assert.equal(rejecting.title, "(3) Home · DoctorCRE");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a count change updates the badge without clearing it, and leaving Home clears it once", async () => {
  const setAppBadge = mock.fn(async (_contents?: number) => {});
  const clearAppBadge = mock.fn(async () => {});
  const dom = new JSDOM("<!doctype html>");
  const page = install({ setAppBadge, clearAppBadge });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const root = createRoot(dom.window.document.createElement("div"));
  const show = (home: boolean, count: number | null) =>
    act(async () => {
      root.render(createElement(Probe, { home, count }));
    });

  await show(true, null);
  assert.equal(page.title, HOME_TITLE);
  await show(true, 3);
  assert.equal(page.title, "(3) Home · DoctorCRE");
  await show(true, 2);
  assert.equal(page.title, "(2) Home · DoctorCRE");
  assert.deepEqual(
    setAppBadge.mock.calls.map((call) => call.arguments[0]),
    [3, 2],
  );
  assert.equal(clearAppBadge.mock.calls.length, 0);

  await show(false, 2);
  assert.equal(page.title, HOME_TITLE);
  assert.equal(clearAppBadge.mock.calls.length, 1);
  await act(async () => root.unmount());
  assert.equal(clearAppBadge.mock.calls.length, 1);
  dom.window.close();
});

function Probe({ home, count }: { home: boolean; count: number | null }) {
  useHomeTabBadge(home, count);
  return null;
}
