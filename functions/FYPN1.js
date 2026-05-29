import { logAndRedirect, ZOOM_FYP } from "./_lib/click-redirect.js";
export const onRequest = (ctx) => logAndRedirect(ctx, "sms_click_n1", ZOOM_FYP);
