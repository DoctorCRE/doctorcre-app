import { readMailPriorities, startEarlyMailPriorities } from "./mail-priorities-client";

if (location.pathname === "/" && !document.documentElement.hasAttribute("data-home-today-from-engine"))
  startEarlyMailPriorities((signal) => readMailPriorities(signal, "low"));
