import { createClientAnniversariesClient, mountClientAnniversaries } from "./client-anniversaries.tsx";
import { dealCutover } from "./deal-cutover.ts";

const host = document.getElementById("clientAnniversaries");
if (host) {
  const client = createClientAnniversariesClient();
  mountClientAnniversaries(host, { load: (signal) => client.read({ signal }) });
}

const coverage = document.getElementById("anniversaryCoverage");
const cutover = dealCutover(document);
if (coverage && cutover?.label) coverage.textContent = `From deals closed before ${cutover.label}`;
