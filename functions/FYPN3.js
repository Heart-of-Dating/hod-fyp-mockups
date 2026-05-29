import { logAndRedirect, ZOOM_FYP } from "./_lib/click-redirect.js";
export const onRequest = (ctx) => logAndRedirect(ctx, "sms_click_n3", ZOOM_FYP);
