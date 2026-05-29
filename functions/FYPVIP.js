import { logAndRedirect, ZOOM_VIP } from "./_lib/click-redirect.js";
export const onRequest = (ctx) => logAndRedirect(ctx, "sms_click_vip", ZOOM_VIP);
