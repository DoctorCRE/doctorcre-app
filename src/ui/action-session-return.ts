import { sessionReturnPath } from "../../js/routes.js";

const returnTo = new URL(location.href).searchParams.get("return_to");
const login = document.querySelector('a[href="/auth/login"]');
if (returnTo !== null && login instanceof HTMLAnchorElement) {
  const destination = sessionReturnPath(returnTo) ?? "/invoices";
  login.href = `/auth/login?return_to=${encodeURIComponent(destination)}`;
}
