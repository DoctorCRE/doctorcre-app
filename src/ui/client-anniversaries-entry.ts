import { createClientAnniversariesClient, mountClientAnniversaries } from "./client-anniversaries.tsx";

const host = document.getElementById("clientAnniversaries");
if (host) {
  const client = createClientAnniversariesClient();
  mountClientAnniversaries(host, { load: (signal) => client.read({ signal }) });
}
