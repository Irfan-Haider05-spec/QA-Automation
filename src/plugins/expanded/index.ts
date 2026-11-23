import { authzMatrix, authSession, rateLimit, dataExposure, raceConditions, fileUpload, webhookSecurity, graphql } from "./api-checks.js";
import { validationCoverage, apiContract, testResults, licenseSbom, bundleBudget } from "./static-checks.js";
import { sast, containerIac, mobileStatic } from "./scanner-adapters.js";
import { webClientSecurity, webForms, crossBrowser, linksSeo, i18nRtl, privacyConsent } from "./browser-checks.js";
import { uptime, tlsDnsMail, postDeployErrors, loadStress } from "./operations-checks.js";
import { passwordPolicy } from "./password-policy.js";
import { diffCoveragePlugin } from "./diff-coverage.js";
import { codeQualityPlugin } from "./code-quality.js";
import { flakyTestsPlugin } from "./flaky-tests.js";
import { mongoIndexesPlugin } from "./mongo-indexes.js";
import { logHygienePlugin } from "./log-hygiene.js";
import { apiScenariosPlugin } from "./api-scenarios.js";
import { dbChecksPlugin } from "./db-checks.js";
import { injectionProbesPlugin } from "./injection-probes.js";
import { scenarioLintPlugin } from "./scenario-lint.js";
import type { QaPlugin } from "../../core/types.js";

export const EXPANDED_PLUGINS: QaPlugin[] = [authzMatrix, authSession, rateLimit, dataExposure, validationCoverage, sast, apiContract, testResults,
  uptime, tlsDnsMail, raceConditions, fileUpload, webhookSecurity, webClientSecurity, webForms, crossBrowser, linksSeo, containerIac,
  mobileStatic, postDeployErrors, graphql, licenseSbom, i18nRtl, privacyConsent, loadStress, bundleBudget,
  passwordPolicy, diffCoveragePlugin, codeQualityPlugin, flakyTestsPlugin, mongoIndexesPlugin, logHygienePlugin, apiScenariosPlugin, dbChecksPlugin, injectionProbesPlugin, scenarioLintPlugin];
