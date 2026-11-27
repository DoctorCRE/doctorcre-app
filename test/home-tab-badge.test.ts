import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setHomeTabBadge } from "../src/ui/home/tab-badge.ts";

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
