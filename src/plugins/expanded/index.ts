import { authzMatrix, authSession, rateLimit, dataExposure, raceConditions, fileUpload, webhookSecurity, graphql } from "./api-checks.js";
import { validationCoverage, apiContract, testResults, licenseSbom, bundleBudget } from "./static-checks.js";
import { sast, containerIac, mobileStatic } from "./scanner-adapters.js";
import { webClientSecurity, webForms, crossBrowser, linksSeo, i18nRtl, privacyConsent } from "./browser-checks.js";
import { uptime, tlsDnsMail, postDeployErrors, loadStress } from "./operations-checks.js";
import { passwordPolicy } from "./password-policy.js";
import type { QaPlugin } from "../../core/types.js";

export const EXPANDED_PLUGINS: QaPlugin[] = [authzMatrix, authSession, rateLimit, dataExposure, validationCoverage, sast, apiContract, testResults,
  uptime, tlsDnsMail, raceConditions, fileUpload, webhookSecurity, webClientSecurity, webForms, crossBrowser, linksSeo, containerIac,
  mobileStatic, postDeployErrors, graphql, licenseSbom, i18nRtl, privacyConsent, loadStress, bundleBudget,
  passwordPolicy];
