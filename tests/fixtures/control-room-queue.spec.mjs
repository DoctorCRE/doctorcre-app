import { expect, test } from '@playwright/test';
import { appShellMarkup } from '../../js/navigation.js';
import { switcherUtilityPages } from '../../js/routes.js';

test('the partner menu and switcher omit retired destinations', () => {
  expect(appShellMarkup('/')).not.toMatch(/>Events<|>Doc Activity<|\/work-requests|\/control-room/);
  expect(switcherUtilityPages.map(({ label }) => label)).not.toContain('Doc Activity');
});
