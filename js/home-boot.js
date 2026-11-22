// Home's data client, started before the dashboard's module graph finishes
// loading. workspace.html loads this as an async module, so the client
// download overlaps the shell instead of queuing behind it, and each mode
// fetches only its own client: live never downloads the fixture client.
import { resolveDealroomBoot } from './boot-mode.js';

async function createHomeClient(boot) {
  if (boot.mode === 'live') {
    const [{ createLiveClient }, { createLeadBoardClient }] = await Promise.all([
      import('./live-client.js'), import('./leads-client.js')]);
    const client = createLiveClient({ docContext: false });
    client.getLeadBoard = createLeadBoardClient({ docContext: false }).getLeadBoard;
    return client;
  }
  const { createFixtureClient } = await import('./fixture-client.js');
  const client = await createFixtureClient({ ...boot.options, docContext: false });
  client.getLeadBoard = async () => ({ leads: [] });
  return client;
}

export const homeClient = typeof location === 'undefined' ? null : createHomeClient(resolveDealroomBoot(location));

export async function readHomeEmailProposalPage(options) {
  const [{ readEmailProposalPage }, client] = await Promise.all([import('./email-followups.js'), homeClient]);
  return readEmailProposalPage(client, options);
}
