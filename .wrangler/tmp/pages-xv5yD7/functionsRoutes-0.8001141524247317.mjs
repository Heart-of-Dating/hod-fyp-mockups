import { onRequestPost as __api_admin_login_js_onRequestPost } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/admin-login.js"
import { onRequestGet as __api_dashboard_js_onRequestGet } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/dashboard.js"
import { onRequestGet as __api_dashboard_search_js_onRequestGet } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/dashboard-search.js"
import { onRequestGet as __api_meta_ads_js_onRequestGet } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/meta-ads.js"
import { onRequestOptions as __api_register_js_onRequestOptions } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/register.js"
import { onRequestPost as __api_register_js_onRequestPost } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/register.js"
import { onRequestOptions as __api_scholarship_enter_js_onRequestOptions } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/scholarship-enter.js"
import { onRequestPost as __api_scholarship_enter_js_onRequestPost } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/scholarship-enter.js"
import { onRequest as __api__click_diag_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/_click_diag.js"
import { onRequest as __api_fyp_visits_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/fyp-visits.js"
import { onRequest as __api_scholarship_list_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/scholarship-list.js"
import { onRequest as __api_sod_counts_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/api/sod-counts.js"
import { onRequest as __admin__middleware_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/admin/_middleware.js"
import { onRequest as __fyp__middleware_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/fyp/_middleware.js"
import { onRequest as __FYPN1_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/FYPN1.js"
import { onRequest as __FYPN2_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/FYPN2.js"
import { onRequest as __FYPN3_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/FYPN3.js"
import { onRequest as __FYPN4_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/FYPN4.js"
import { onRequest as __FYPVIP_js_onRequest } from "/Users/jjtomlin/Documents/HOD-FYP-mockups/functions/FYPVIP.js"

export const routes = [
    {
      routePath: "/api/admin-login",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_admin_login_js_onRequestPost],
    },
  {
      routePath: "/api/dashboard",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_dashboard_js_onRequestGet],
    },
  {
      routePath: "/api/dashboard-search",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_dashboard_search_js_onRequestGet],
    },
  {
      routePath: "/api/meta-ads",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_meta_ads_js_onRequestGet],
    },
  {
      routePath: "/api/register",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_register_js_onRequestOptions],
    },
  {
      routePath: "/api/register",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_register_js_onRequestPost],
    },
  {
      routePath: "/api/scholarship-enter",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_scholarship_enter_js_onRequestOptions],
    },
  {
      routePath: "/api/scholarship-enter",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_scholarship_enter_js_onRequestPost],
    },
  {
      routePath: "/api/_click_diag",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api__click_diag_js_onRequest],
    },
  {
      routePath: "/api/fyp-visits",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_fyp_visits_js_onRequest],
    },
  {
      routePath: "/api/scholarship-list",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_scholarship_list_js_onRequest],
    },
  {
      routePath: "/api/sod-counts",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_sod_counts_js_onRequest],
    },
  {
      routePath: "/admin",
      mountPath: "/admin",
      method: "",
      middlewares: [__admin__middleware_js_onRequest],
      modules: [],
    },
  {
      routePath: "/fyp",
      mountPath: "/fyp",
      method: "",
      middlewares: [__fyp__middleware_js_onRequest],
      modules: [],
    },
  {
      routePath: "/FYPN1",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__FYPN1_js_onRequest],
    },
  {
      routePath: "/FYPN2",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__FYPN2_js_onRequest],
    },
  {
      routePath: "/FYPN3",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__FYPN3_js_onRequest],
    },
  {
      routePath: "/FYPN4",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__FYPN4_js_onRequest],
    },
  {
      routePath: "/FYPVIP",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__FYPVIP_js_onRequest],
    },
  ]