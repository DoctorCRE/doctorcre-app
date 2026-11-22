import { mountClientAnniversaries } from "./client-anniversaries.tsx";

const host = document.getElementById("clientAnniversaries");
if (host) mountClientAnniversaries(host);
